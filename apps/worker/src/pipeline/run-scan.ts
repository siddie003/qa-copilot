import { randomUUID } from "node:crypto";
import {
  authHeadersFor,
  errorFields,
  SCANNER_KEYS,
  scanAuthSchema,
  type AppConfig,
  type Logger,
  type ScanAuth,
  type ScanConfigSnapshot,
} from "@qa/core";
import {
  capturePage,
  launchBrowser,
  newGuardedContext,
  renderLinks,
  type BrowserSession,
} from "@qa/browser";
import {
  crawl,
  detectTechnology,
  guardedFetch,
  loadRobots,
  normalizeUrl,
  type FetchOptions,
  type RobotsRules,
} from "@qa/crawler";
import { pipelineRepo, secretsRepo, type Database } from "@qa/db";
import { SCANNERS, type ScannerContext } from "@qa/scanners";
import {
  assertPublicTarget,
  BlockedTargetError,
  createGuardedDispatcher,
  decryptSecret,
  validateWebsiteUrl,
  type Resolver,
  type TargetPolicy,
} from "@qa/security";
import type { Storage } from "@qa/storage";
import { buildScannerContext, runScannerStep, type ScannerEnv } from "./scanner-steps";

export interface ScanRuntime {
  db: Database;
  storage: Storage;
  config: AppConfig;
  log: Logger;
  /** Injected in tests to control DNS; defaults to the system resolver. */
  resolve?: Resolver;
  heartbeatMs?: number;
}

type StepOutcome = {
  status: "completed" | "failed" | "inconclusive";
  statusReason?: string;
  error?: string;
  findingCount?: number;
  toolName?: string;
  toolVersion?: string;
  /** Scanner summary of what was checked (stored on the step). */
  checks?: Record<string, unknown>;
  /** A fatal outcome stops the scan: remaining steps are skipped with this reason. */
  fatal?: string;
};

class CancelledError extends Error {
  constructor() {
    super("Scan cancelled");
  }
}

class StepTimeoutError extends Error {}

interface ScanState {
  scanId: string;
  projectId: string;
  /** Canonical site URL (start URL after redirects); credentials are limited to this site. */
  siteUrl: string;
  credentials: ScanAuth | null;
  snapshot: ScanConfigSnapshot;
  policy: TargetPolicy;
  fetchOpts: FetchOptions;
  abort: AbortController;
  robots: RobotsRules | null;
  startFinalUrl: string | null;
  browser: BrowserSession | null;
}

/** Executes one claimed scan end to end. Never throws: all failures are recorded on the scan. */
export async function runScan(
  rt: ScanRuntime,
  scanRow: { id: string; projectId: string; configSnapshot: Record<string, unknown> },
) {
  const snapshot = scanRow.configSnapshot as unknown as ScanConfigSnapshot;
  const log = rt.log.child({ scanId: scanRow.id });
  const policy: TargetPolicy = { allowedPrivateHosts: rt.config.SCAN_ALLOWED_PRIVATE_HOSTS };
  const dispatcher = createGuardedDispatcher(policy, {
    resolve: rt.resolve,
    connectTimeoutMs: snapshot.pageTimeoutMs,
  });
  const abort = new AbortController();
  const state: ScanState = {
    scanId: scanRow.id,
    projectId: scanRow.projectId,
    siteUrl: snapshot.websiteUrl,
    credentials: null,
    snapshot,
    policy,
    abort,
    robots: null,
    startFinalUrl: null,
    browser: null,
    fetchOpts: {
      policy,
      dispatcher,
      userAgent: snapshot.userAgent,
      timeoutMs: snapshot.pageTimeoutMs,
      retries: rt.config.LINK_CHECK_RETRIES,
      resolve: rt.resolve,
      // Evaluated per request/redirect hop: credentials only ever go to the scanned site.
      authHeaders: (url) => authHeadersFor(state.credentials, state.siteUrl, url),
    },
  };

  const beat = setInterval(() => {
    pipelineRepo
      .heartbeat(rt.db, scanRow.id)
      .then(({ cancelRequested }) => {
        if (cancelRequested && !abort.signal.aborted) {
          log.info("cancellation requested");
          abort.abort();
        }
      })
      .catch((err) => log.warn(errorFields(err), "heartbeat failed"));
  }, rt.heartbeatMs ?? 5_000);

  const started = Date.now();
  let fatal: string | null = null;
  let anyFailed = false;
  let cancelled = false;

  const runStep = async (stepKey: string, fn: () => Promise<StepOutcome>) => {
    if (fatal || cancelled) return;
    const slog = log.child({ step: stepKey });
    await pipelineRepo.updateStep(rt.db, scanRow.id, stepKey, { status: "running", started: true });
    const stepStart = Date.now();
    let outcome: StepOutcome;
    let timer: NodeJS.Timeout | undefined;
    try {
      if (abort.signal.aborted) throw new CancelledError();
      outcome = await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new StepTimeoutError(
                  `Step timed out after ${Math.round(rt.config.SCAN_SCANNER_TIMEOUT_MS / 1000)} s`,
                ),
              ),
            rt.config.SCAN_SCANNER_TIMEOUT_MS,
          );
        }),
      ]);
      if (abort.signal.aborted) throw new CancelledError();
    } catch (err) {
      if (err instanceof CancelledError || abort.signal.aborted) {
        cancelled = true;
        await pipelineRepo.updateStep(rt.db, scanRow.id, stepKey, {
          status: "skipped",
          statusReason: "Cancelled by user",
          finished: true,
        });
        slog.info("step cancelled");
        return;
      }
      outcome = {
        status: "failed",
        error:
          err instanceof StepTimeoutError
            ? err.message
            : `Unexpected error: ${(err as Error).message}`,
      };
      slog.error(errorFields(err), "step crashed");
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (outcome.status === "failed") anyFailed = true;
    if (outcome.fatal) fatal = outcome.fatal;
    await pipelineRepo.updateStep(rt.db, scanRow.id, stepKey, {
      status: outcome.status,
      statusReason: outcome.statusReason ?? null,
      error: outcome.error ?? null,
      findingCount: outcome.findingCount,
      toolName: outcome.toolName,
      toolVersion: outcome.toolVersion,
      checks: outcome.checks,
      finished: true,
    });
    slog.info(
      {
        status: outcome.status,
        durationMs: Date.now() - stepStart,
        findingCount: outcome.findingCount ?? 0,
        error: outcome.error,
      },
      "step finished",
    );
  };

  try {
    log.info({ websiteUrl: snapshot.websiteUrl }, "scan started");
    await runStep("preflight", () => preflight(rt, state));
    await runStep("crawl", () => crawlStep(rt, state));
    await runStep("capture", () => captureStep(rt, state));
    // QA scanners: each one is an independent step; a failing scanner does not stop the others.
    if (!fatal && !cancelled) {
      const env = scannerEnv(rt, state);
      let ctx: ScannerContext | null = null;
      for (const key of SCANNER_KEYS) {
        if (!snapshot.scanners.includes(key)) continue;
        await runStep(key, async () => {
          ctx ??= await buildScannerContext(env);
          return runScannerStep(env, SCANNERS[key], ctx);
        });
      }
    }
  } finally {
    clearInterval(beat);
    await state.browser?.close().catch(() => {});
    await dispatcher.close().catch(() => {});
  }

  if (cancelled) {
    await pipelineRepo.skipPendingSteps(rt.db, scanRow.id, "Scan cancelled");
    await pipelineRepo.finishScan(rt.db, scanRow.id, "cancelled");
  } else if (fatal) {
    await pipelineRepo.skipPendingSteps(rt.db, scanRow.id, `Not run: ${fatal}`);
    await pipelineRepo.finishScan(rt.db, scanRow.id, "failed", fatal);
  } else {
    await pipelineRepo.finishScan(
      rt.db,
      scanRow.id,
      anyFailed ? "completed_with_failures" : "completed",
    );
  }
  log.info({ durationMs: Date.now() - started, cancelled, fatal, anyFailed }, "scan finished");
}

/** Decrypts the project's site credentials. Returns a fatal outcome if they are unusable. */
async function loadCredentials(rt: ScanRuntime, s: ScanState): Promise<StepOutcome | null> {
  const fail = (error: string): StepOutcome => ({
    status: "failed",
    error,
    fatal: "Site credentials unavailable",
  });
  const row = await secretsRepo.getProjectSecret(rt.db, s.projectId, secretsRepo.SCAN_AUTH_KIND);
  if (!row)
    return fail("Site credentials were removed after this scan was queued. Start a new scan.");
  if (!rt.config.ENCRYPTION_KEY)
    return fail(
      "ENCRYPTION_KEY is not configured on the worker, so site credentials cannot be decrypted.",
    );
  try {
    const parsed = scanAuthSchema.safeParse(
      JSON.parse(decryptSecret(row.ciphertext, rt.config.ENCRYPTION_KEY, s.projectId)),
    );
    if (!parsed.success)
      return fail("Stored site credentials are invalid. Save them again in project settings.");
    s.credentials = parsed.data;
    return null;
  } catch {
    return fail(
      "Site credentials could not be decrypted (was ENCRYPTION_KEY changed?). Save them again in project settings.",
    );
  }
}

async function preflight(rt: ScanRuntime, s: ScanState): Promise<StepOutcome> {
  const url = s.snapshot.websiteUrl;
  const check = validateWebsiteUrl(url, { allowedPrivateHosts: s.policy.allowedPrivateHosts });
  if (!check.ok)
    return { status: "failed", error: check.message, fatal: "Website URL is not allowed" };
  if (s.snapshot.authType) {
    const loaded = await loadCredentials(rt, s);
    if (loaded) return loaded;
  }
  try {
    await assertPublicTarget(check.url, s.policy, rt.resolve);
  } catch (err) {
    if (err instanceof BlockedTargetError) {
      const msg = err.code === "DNS_FAILURE" ? err.message : `Blocked for safety: ${err.message}`;
      return {
        status: "failed",
        error: msg,
        fatal:
          err.code === "DNS_FAILURE"
            ? "Website host could not be resolved"
            : "Website resolves to a private or internal address",
      };
    }
    throw err;
  }

  const res = await guardedFetch(check.url, { ...s.fetchOpts, signal: s.abort.signal });
  if (res.error) {
    const tls = /CERT|TLS|SSL|EPROTO|ERR_SSL/i.test(`${res.error.code} ${res.error.message}`);
    return {
      status: "failed",
      error: `Website unreachable: ${res.error.code} – ${res.error.message}${
        tls && check.url.startsWith("https:")
          ? " (the HTTPS connection failed; if the site only serves plain HTTP, use an http:// URL)"
          : ""
      }`,
      fatal: "Website unreachable",
    };
  }
  const status = res.status!;
  if ([401, 403, 407, 429].includes(status)) {
    return {
      status: "inconclusive",
      statusReason:
        s.credentials && (status === 401 || status === 403)
          ? `The start page answered HTTP ${status} even with the configured ${s.credentials.type} credentials. Check the site credentials in project settings.`
          : `The start page answered HTTP ${status}. The site requires authentication or blocks automated access, so it cannot be scanned. Site credentials can be added in project settings.`,
      fatal: `Start page returned HTTP ${status}`,
    };
  }
  if (status >= 400) {
    return {
      status: "failed",
      error: `Start page returned HTTP ${status}`,
      fatal: `Start page returned HTTP ${status}`,
    };
  }
  s.startFinalUrl = res.finalUrl;
  s.siteUrl = res.finalUrl;

  const technologies = detectTechnology({
    url: res.finalUrl,
    headers: res.headers,
    html: res.body,
  });
  await pipelineRepo.setTechnology(rt.db, s.scanId, {
    detected: technologies,
    source: "response headers and served HTML of the start page",
    note: technologies.length ? null : "Could not determine",
  });

  if (s.snapshot.respectRobots)
    s.robots = await loadRobots(res.finalUrl, { ...s.fetchOpts, signal: s.abort.signal });

  const parts = [`Reachable: HTTP ${status} in ${res.durationMs} ms`];
  if (res.redirectChain.length)
    parts.push(
      `redirected to ${res.finalUrl} (${res.redirectChain.length} hop${res.redirectChain.length > 1 ? "s" : ""})`,
    );
  const tech = technologies.filter((t) => t.category !== "server");
  parts.push(
    tech.length
      ? `technology: ${tech.map((t) => `${t.name} (${t.confidence})`).join(", ")}`
      : "technology: could not determine",
  );
  if (s.credentials) parts.push(`site credentials: ${s.credentials.type} (sent to this site only)`);
  if (s.robots)
    parts.push(
      `robots.txt: ${s.robots.status === "found" ? "found" : s.robots.status === "missing" ? "not present (all allowed)" : "unreachable (crawling disallowed per RFC 9309)"}`,
    );
  else parts.push("robots.txt: ignored by project setting");
  return { status: "completed", statusReason: parts.join("; ") };
}

/** Everything a scanner step needs; contexts reuse the scan's guarded browser and credentials. */
function scannerEnv(rt: ScanRuntime, s: ScanState): ScannerEnv {
  return {
    db: rt.db,
    storage: rt.storage,
    log: rt.log.child({ scanId: s.scanId }),
    scanId: s.scanId,
    siteUrl: s.siteUrl,
    viewports: s.snapshot.viewports,
    robots: s.robots,
    fetch: { ...s.fetchOpts, signal: s.abort.signal },
    signal: s.abort.signal,
    pageTimeoutMs: s.snapshot.pageTimeoutMs,
    openContext: (viewport) => openContext(rt, s, viewport),
  };
}

/** One Chromium per scan; all its traffic goes through the guard proxy (no own DNS lookups). */
async function ensureBrowser(rt: ScanRuntime, s: ScanState) {
  s.browser ??= await launchBrowser({ guard: { policy: s.policy, resolve: rt.resolve } });
  return s.browser;
}

/** Guarded browser context for one viewport, with the site's credentials if configured. */
async function openContext(
  rt: ScanRuntime,
  s: ScanState,
  viewport: { name: string; width: number; height: number },
) {
  const browser = await ensureBrowser(rt, s);
  return newGuardedContext(browser, {
    viewport,
    userAgent: s.snapshot.userAgent,
    policy: s.policy,
    resolve: rt.resolve,
    ...(s.credentials ? { auth: { siteUrl: s.siteUrl, credentials: s.credentials } } : {}),
  });
}

async function crawlStep(rt: ScanRuntime, s: ScanState): Promise<StepOutcome> {
  const browser = await ensureBrowser(rt, s);
  const desktop = s.snapshot.viewports[0] ?? { name: "desktop", width: 1440, height: 900 };
  const { context } = await openContext(rt, s, desktop);
  let stored = 0;
  try {
    const summary = await crawl(
      {
        startUrl: s.startFinalUrl ?? s.snapshot.websiteUrl,
        maxPages: s.snapshot.maxPages,
        maxDepth: s.snapshot.maxDepth,
        concurrency: s.snapshot.concurrency,
        fetch: s.fetchOpts,
        robots: s.robots,
        signal: s.abort.signal,
        renderLinks: (url) => renderLinks(context, url, s.snapshot.pageTimeoutMs),
      },
      async (p) => {
        const id = randomUUID();
        let rawHtmlKey: string | null = null;
        if (p.result?.body && p.isHtml) {
          rawHtmlKey = `scans/${s.scanId}/pages/${id}/raw.html`;
          await rt.storage.put(rawHtmlKey, p.result.body);
        }
        const r = p.result;
        await pipelineRepo.insertPage(rt.db, s.scanId, {
          id,
          url: p.url,
          normalizedUrl: normalizeUrl(p.url) ?? p.url,
          finalUrl: r?.finalUrl ?? null,
          httpStatus: r?.status ?? null,
          redirectChain: r?.redirectChain.length ? r.redirectChain : null,
          depth: p.depth,
          discoveredFrom: p.discoveredFrom,
          title: p.title,
          contentType: r?.contentType ?? null,
          responseHeaders: r ? r.headers : null,
          rawHtmlKey,
          crawlError: p.blockedByRobots
            ? "Not crawled: disallowed by robots.txt"
            : r?.error
              ? `${r.error.code}: ${r.error.message}`
              : null,
        });
        stored += 1;
        if (stored % 5 === 0) await pipelineRepo.notifyScan(rt.db, s.scanId);
      },
    );
    if (summary.cancelled) throw new CancelledError();
    const reason = [
      `${summary.pagesFetched} page${summary.pagesFetched === 1 ? "" : "s"} fetched`,
      summary.failed ? `${summary.failed} returned an error or could not be loaded` : null,
      summary.blockedByRobots ? `${summary.blockedByRobots} skipped (robots.txt)` : null,
      summary.limitReached
        ? `page limit of ${s.snapshot.maxPages} reached; ${summary.queuedButNotVisited} discovered URLs not visited`
        : null,
    ]
      .filter(Boolean)
      .join("; ");
    if (summary.pagesFetched === 0)
      return {
        status: "failed",
        error: "No pages could be crawled",
        fatal: "No pages could be crawled",
      };
    return {
      status: "completed",
      statusReason: reason,
      toolName: "HTTP crawler + Chromium link discovery",
      toolVersion: browser.version,
    };
  } finally {
    await context.close().catch(() => {});
  }
}

async function captureStep(rt: ScanRuntime, s: ScanState): Promise<StepOutcome> {
  const browser = await ensureBrowser(rt, s);
  const capturable = await pipelineRepo.listCapturablePages(rt.db, s.scanId);
  // A URL that redirects to a page already in the list is the same document: capture it once,
  // preferring the URL that was reached directly.
  const seenTargets = new Set<string>();
  const pages = [...capturable]
    .sort(
      (a, b) => Number(Boolean(a.redirectChain?.length)) - Number(Boolean(b.redirectChain?.length)),
    )
    .filter((p) => {
      const key = normalizeUrl(p.finalUrl ?? p.url) ?? p.url;
      if (seenTargets.has(key)) return false;
      seenTargets.add(key);
      return true;
    });
  if (pages.length === 0)
    return {
      status: "inconclusive",
      statusReason: "No HTML pages with a successful response to capture",
    };
  let ok = 0;
  let failed = 0;
  const failures: string[] = [];
  // Viewports are captured in parallel, each in its own context (one page at a time per
  // context, so blocked-request evidence stays attributed to the right page).
  const lanes = await Promise.allSettled(
    s.snapshot.viewports.map(async (viewport) => {
      const { context, guard } = await openContext(rt, s, viewport);
      try {
        for (const p of pages) {
          if (s.abort.signal.aborted) throw new CancelledError();
          const target = p.finalUrl ?? p.url;
          const r = await capturePage(context, guard, target, viewport, {
            timeoutMs: s.snapshot.pageTimeoutMs,
            screenshot: true,
            proxy: browser.proxy,
          });
          const base = `scans/${s.scanId}/pages/${p.id}/${viewport.name}`;
          const screenshotKey = r.screenshot
            ? (await rt.storage.put(`${base}.png`, r.screenshot)).key
            : null;
          const domSnapshotKey = r.html ? (await rt.storage.put(`${base}.html`, r.html)).key : null;
          await pipelineRepo.insertCapture(rt.db, {
            pageId: p.id,
            viewport: viewport.name,
            width: viewport.width,
            height: viewport.height,
            screenshotKey,
            domSnapshotKey,
            consoleMessages: [
              ...r.console.map((c) => ({ ...c })),
              ...r.pageErrors.map((e) => ({ type: "pageerror", text: e, location: null })),
            ],
            metrics: r.metrics,
            timings: {
              ...r.timings,
              finalUrl: r.finalUrl,
              status: r.status,
              screenshotTruncated: r.screenshotTruncated,
              blockedRequests: r.blockedRequests,
            },
            error: r.error,
            requests: r.requests,
          });
          if (r.error) {
            failed += 1;
            if (failures.length < 5) failures.push(`${viewport.name} ${target}: ${r.error}`);
          } else ok += 1;
        }
      } finally {
        await context.close().catch(() => {});
      }
      await pipelineRepo.notifyScan(rt.db, s.scanId);
    }),
  );
  const laneError = lanes.find((l): l is PromiseRejectedResult => l.status === "rejected");
  if (laneError) throw laneError.reason;
  const total = ok + failed;
  const skippedDuplicates = capturable.length - pages.length;
  const reason = `${ok} of ${total} page captures succeeded${skippedDuplicates ? ` (${skippedDuplicates} redirecting URL${skippedDuplicates === 1 ? "" : "s"} not captured twice)` : ""} across ${s.snapshot.viewports.length} viewport${s.snapshot.viewports.length === 1 ? "" : "s"} (${s.snapshot.viewports.map((v) => v.name).join(", ")})`;
  if (ok === 0)
    return {
      status: "failed",
      error: `All captures failed. ${failures.join(" | ")}`,
      toolName: "Playwright",
      toolVersion: browser.version,
    };
  return {
    status: "completed",
    statusReason: failed ? `${reason}. Failures: ${failures.join(" | ")}` : reason,
    toolName: "Playwright",
    toolVersion: browser.version,
  };
}
