import { randomUUID } from "node:crypto";
import { errorFields, type AppConfig, type Logger, type ScanConfigSnapshot } from "@qa/core";
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
import { pipelineRepo, type Database } from "@qa/db";
import {
  assertPublicTarget,
  BlockedTargetError,
  createGuardedDispatcher,
  validateWebsiteUrl,
  type Resolver,
  type TargetPolicy,
} from "@qa/security";
import type { Storage } from "@qa/storage";

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
  scanRow: { id: string; configSnapshot: Record<string, unknown> },
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

async function preflight(rt: ScanRuntime, s: ScanState): Promise<StepOutcome> {
  const url = s.snapshot.websiteUrl;
  const check = validateWebsiteUrl(url, { allowedPrivateHosts: s.policy.allowedPrivateHosts });
  if (!check.ok)
    return { status: "failed", error: check.message, fatal: "Website URL is not allowed" };
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
    return {
      status: "failed",
      error: `Website unreachable: ${res.error.code} – ${res.error.message}`,
      fatal: "Website unreachable",
    };
  }
  const status = res.status!;
  if ([401, 403, 407, 429].includes(status)) {
    return {
      status: "inconclusive",
      statusReason: `The start page answered HTTP ${status}. The site requires authentication or blocks automated access, so it cannot be scanned.`,
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
  if (s.robots)
    parts.push(
      `robots.txt: ${s.robots.status === "found" ? "found" : s.robots.status === "missing" ? "not present (all allowed)" : "unreachable (crawling disallowed per RFC 9309)"}`,
    );
  else parts.push("robots.txt: ignored by project setting");
  return { status: "completed", statusReason: parts.join("; ") };
}

async function ensureBrowser(s: ScanState) {
  s.browser ??= await launchBrowser();
  return s.browser;
}

async function crawlStep(rt: ScanRuntime, s: ScanState): Promise<StepOutcome> {
  const browser = await ensureBrowser(s);
  const desktop = s.snapshot.viewports[0] ?? { name: "desktop", width: 1440, height: 900 };
  const { context } = await newGuardedContext(browser, {
    viewport: desktop,
    userAgent: s.snapshot.userAgent,
    policy: s.policy,
    resolve: rt.resolve,
  });
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
  const browser = await ensureBrowser(s);
  const pages = await pipelineRepo.listCapturablePages(rt.db, s.scanId);
  if (pages.length === 0)
    return {
      status: "inconclusive",
      statusReason: "No HTML pages with a successful response to capture",
    };
  let ok = 0;
  let failed = 0;
  const failures: string[] = [];
  for (const viewport of s.snapshot.viewports) {
    const { context, guard } = await newGuardedContext(browser, {
      viewport,
      userAgent: s.snapshot.userAgent,
      policy: s.policy,
      resolve: rt.resolve,
    });
    try {
      for (const p of pages) {
        if (s.abort.signal.aborted) throw new CancelledError();
        const target = p.finalUrl ?? p.url;
        const r = await capturePage(context, guard, target, viewport, {
          timeoutMs: s.snapshot.pageTimeoutMs,
          screenshot: true,
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
  }
  const total = ok + failed;
  const reason = `${ok} of ${total} page captures succeeded across ${s.snapshot.viewports.length} viewport${s.snapshot.viewports.length === 1 ? "" : "s"} (${s.snapshot.viewports.map((v) => v.name).join(", ")})`;
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
