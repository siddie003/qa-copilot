import { errorFields, publicErrorMessage, type Logger, type ScanFontReference } from "@qa/core";
import type { FetchOptions, RobotsRules } from "@qa/crawler";
import { normalizeUrl } from "@qa/crawler";
import { pipelineRepo, type Database } from "@qa/db";
import {
  findingDraftSchema,
  type CaptureRecord,
  type LivePage,
  type PageRecord,
  type ScanReferences,
  type Scanner,
  type ScannerContext,
} from "@qa/scanners";
import type { Storage } from "@qa/storage";
import type { BrowserContext } from "playwright";

export interface ScannerStepOutcome {
  status: "completed" | "failed" | "inconclusive";
  statusReason?: string;
  error?: string;
  findingCount: number;
  toolName: string;
  toolVersion: string;
  checks: Record<string, unknown>;
}

export interface ScannerEnv {
  db: Database;
  storage: Storage;
  log: Logger;
  scanId: string;
  siteUrl: string;
  viewports: Array<{ name: string; width: number; height: number }>;
  robots: RobotsRules | null;
  fetch: FetchOptions;
  signal: AbortSignal;
  pageTimeoutMs: number;
  /** Design spec and content documents frozen into the scan. */
  references: ScanReferences;
  /** Scanner limits (accessibility page cap); the step deadline is added per step. */
  limits?: ScannerContext["limits"];
  /** Brand font files frozen into the scan. */
  approvedFonts?: ScanFontReference[];
  /** Guarded browser context (policy + credentials) for one viewport. */
  openContext(viewport: {
    name: string;
    width: number;
    height: number;
  }): Promise<{ context: BrowserContext }>;
}

const readText = (storage: Storage, key: string | null) => async () =>
  key
    ? storage
        .read(key)
        .then((b) => b.toString("utf8"))
        .catch(() => null)
    : null;

const readJson = (storage: Storage, key: string | null) => async () => {
  const text = await readText(storage, key)();
  if (!text) return null;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
};

/** Builds the read-only scanner context from what crawl and capture stored. */
export async function buildScannerContext(env: ScannerEnv): Promise<ScannerContext> {
  const data = await pipelineRepo.loadScanData(env.db, env.scanId);
  const requestsByCapture = new Map<string, typeof data.requests>();
  for (const r of data.requests) {
    const list = requestsByCapture.get(r.pageCaptureId) ?? [];
    list.push(r);
    requestsByCapture.set(r.pageCaptureId, list);
  }
  const pages: PageRecord[] = data.pages.map((p) => ({
    id: p.id,
    url: p.url,
    finalUrl: p.finalUrl,
    httpStatus: p.httpStatus,
    depth: p.depth,
    origin: p.origin,
    title: p.title,
    contentType: p.contentType,
    crawlError: p.crawlError,
    redirectChain: p.redirectChain,
    responseHeaders: p.responseHeaders,
    loadRawHtml: readText(env.storage, p.rawHtmlKey),
    captures: data.captures
      .filter((c) => c.pageId === p.id)
      .map((c): CaptureRecord => ({
        pageId: p.id,
        viewport: c.viewport,
        width: c.width,
        height: c.height,
        screenshotKey: c.screenshotKey,
        error: c.error,
        timings: c.timings ?? {},
        metrics: c.metrics ?? null,
        consoleMessages: c.consoleMessages ?? [],
        requests: (requestsByCapture.get(c.id) ?? []).map((r) => ({
          url: r.url,
          resourceType: r.resourceType,
          method: r.method,
          status: r.status,
          transferSize: r.transferSize,
          decodedSize: r.decodedSize,
          durationMs: r.durationMs,
          failureText: r.failureText,
          isMixedContent: r.isMixedContent,
        })),
        loadDom: readText(env.storage, c.domSnapshotKey),
        loadDesignStyles: readJson(env.storage, c.computedStylesKey),
        loadTextContent: readJson(env.storage, c.textContentKey),
        loadQuality: readJson(env.storage, c.qualityKey),
      })),
  }));

  return {
    scanId: env.scanId,
    siteUrl: env.siteUrl,
    viewports: env.viewports,
    pages,
    robots: env.robots,
    fetch: env.fetch,
    signal: env.signal,
    pageTimeoutMs: env.pageTimeoutMs,
    references: env.references,
    ...(env.limits ? { limits: env.limits } : {}),
    approvedFonts: env.approvedFonts ?? [],
    stepResult: (stepKey) => pipelineRepo.getStepResult(env.db, env.scanId, stepKey),
    log: (msg, data) => env.log.info(data ?? {}, msg),
    async openPage(url, viewport): Promise<LivePage> {
      const { context } = await env.openContext(viewport);
      try {
        const page = await context.newPage();
        await page.goto(url, { waitUntil: "load", timeout: env.pageTimeoutMs });
        await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => {});
        return { page, close: () => context.close().catch(() => {}) };
      } catch (err) {
        await context.close().catch(() => {});
        throw err;
      }
    },
  };
}

function locationKey(pageUrl: string | null | undefined): string {
  if (!pageUrl) return "site";
  const n = normalizeUrl(pageUrl);
  if (!n) return pageUrl;
  const u = new URL(n);
  return `${u.pathname}${u.search}`;
}

/**
 * Runs one scanner and stores its findings. Each finding is re-validated (evidence required);
 * invalid ones are dropped and reported as inconclusive checks instead of being stored.
 */
export async function runScannerStep(
  env: ScannerEnv,
  scanner: Scanner,
  ctx: ScannerContext,
): Promise<ScannerStepOutcome> {
  const result = await scanner.run(ctx);
  // A step that was stopped (timeout, cancellation, shutdown) has already been recorded; storing
  // its findings now could add findings after the scan's issues were created.
  if (ctx.signal.aborted)
    return {
      status: "failed",
      error: "Stopped before its findings were stored",
      findingCount: 0,
      toolName: result.toolName,
      toolVersion: result.toolVersion,
      checks: result.checks as unknown as Record<string, unknown>,
    };
  const valid = [];
  let rejected = 0;
  for (const f of result.findings) {
    const parsed = findingDraftSchema.safeParse(f);
    if (parsed.success) valid.push(parsed.data);
    else {
      rejected += 1;
      env.log.warn(
        { scanner: scanner.key, ruleId: f.ruleId, issues: parsed.error.issues.slice(0, 3) },
        "finding rejected: invalid structure",
      );
    }
  }
  if (rejected)
    result.checks.inconclusive.push({
      check: "Finding validation",
      reason: `${rejected} finding(s) were discarded because they lacked required fields or evidence`,
      pageUrl: null,
    });

  let ids: string[] = [];
  try {
    ids = await pipelineRepo.insertFindings(
      env.db,
      env.scanId,
      scanner.key,
      scanner.idPrefix,
      valid.map((f) => ({
        ruleId: f.ruleId,
        title: f.title,
        message: f.message,
        category: scanner.key,
        subcategory: f.subcategory ?? null,
        pageId: f.pageId ?? null,
        locationKey: locationKey(f.pageUrl),
        selector: f.selector ?? null,
        viewport: f.viewport ?? null,
        severity: f.severity,
        verdict: f.verdict,
        confidence: f.confidence,
        expected: f.expected ?? null,
        actual: f.actual ?? null,
        fingerprintKey: f.fingerprintKey ?? null,
        evidence: f.evidence.map((e) => ({
          kind: e.kind,
          data: e.data,
          storageKey: e.storageKey ?? null,
        })),
      })),
    );
  } catch (err) {
    env.log.error(errorFields(err), "storing findings failed");
    return {
      status: "failed",
      error: `Findings could not be stored: ${publicErrorMessage(err)}`,
      findingCount: 0,
      toolName: result.toolName,
      toolVersion: result.toolVersion,
      checks: result.checks as unknown as Record<string, unknown>,
    };
  }
  return {
    status: result.status,
    statusReason: result.statusReason,
    findingCount: ids.length,
    toolName: result.toolName,
    toolVersion: result.toolVersion,
    checks: {
      evaluated: result.checks.evaluated,
      inconclusive: result.checks.inconclusive.slice(0, 200),
      inconclusiveTotal: result.checks.inconclusive.length,
      notes: result.checks.notes ?? [],
      ...(result.checks.comparison ? { comparison: result.checks.comparison } : {}),
      ...(result.checks.parts ? { parts: result.checks.parts } : {}),
    },
  };
}
