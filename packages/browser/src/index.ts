import {
  assertPublicTarget,
  BlockedTargetError,
  type Resolver,
  type TargetPolicy,
} from "@qa/security";
import { authHeadersFor, isOnSite, parseCookieString, type ScanAuth } from "@qa/core";
import { chromium, type Browser, type BrowserContext, type Page, type Request } from "playwright";
import { startGuardProxy, type GuardProxy } from "./proxy";

export { startGuardProxy, type GuardProxy };

export interface ViewportSpec {
  name: string;
  width: number;
  height: number;
}

export interface BrowserSession {
  browser: Browser;
  version: string;
  /** Present when all browser traffic goes through the guard proxy. */
  proxy: GuardProxy | null;
  close(): Promise<void>;
}

/**
 * Launches headless Chromium. With `guard`, every request (including localhost) is forced through
 * the guard proxy, so Chromium never resolves DNS itself (see proxy.ts).
 */
export async function launchBrowser(
  opts: { guard?: { policy: TargetPolicy; resolve?: Resolver } } = {},
): Promise<BrowserSession> {
  const proxy = opts.guard ? await startGuardProxy(opts.guard.policy, opts.guard.resolve) : null;
  try {
    const browser = await chromium.launch({
      headless: true,
      args: ["--disable-dev-shm-usage"],
      // "<-loopback>" removes Chromium's implicit proxy bypass for localhost/127.0.0.1.
      ...(proxy ? { proxy: { server: proxy.url, bypass: "<-loopback>" } } : {}),
    });
    return {
      browser,
      proxy,
      version: `Chromium ${browser.version()}`,
      close: async () => {
        await browser.close();
        await proxy?.close();
      },
    };
  } catch (err) {
    await proxy?.close();
    throw err;
  }
}

export interface GuardState {
  blocked: Array<{ url: string; reason: string }>;
}

/**
 * Applies the scan's network policy inside the browser: every http(s) request (documents,
 * scripts, images, XHR) is checked and requests to private/internal addresses are aborted.
 * Results are cached per host:port for the context's lifetime.
 */
async function installNetworkGuard(
  context: BrowserContext,
  policy: TargetPolicy,
  resolve: Resolver | undefined,
  state: GuardState,
  auth: SiteAuth | undefined,
) {
  const cache = new Map<string, Promise<string | null>>();
  await context.route("**/*", async (route) => {
    const url = route.request().url();
    if (!/^https?:/i.test(url)) return route.continue();
    const u = new URL(url);
    const key = `${u.protocol}//${u.host}`;
    let verdict = cache.get(key);
    if (!verdict) {
      verdict = assertPublicTarget(url, policy, resolve).then(
        () => null,
        (err: unknown) => (err instanceof BlockedTargetError ? err.message : String(err)),
      );
      cache.set(key, verdict);
    }
    const reason = await verdict;
    if (reason) {
      state.blocked.push({ url, reason });
      return route.abort("blockedbyclient");
    }
    // Header credentials are added only to requests for the scanned site.
    if (auth?.credentials.type === "header" && isOnSite(url, auth.siteUrl)) {
      return route.continue({
        headers: {
          ...route.request().headers(),
          ...authHeadersFor(auth.credentials, auth.siteUrl, url),
        },
      });
    }
    return route.continue();
  });
}

export interface SiteAuth {
  siteUrl: string;
  credentials: ScanAuth;
}

export interface ContextOptions {
  viewport: ViewportSpec;
  userAgent: string;
  policy: TargetPolicy;
  resolve?: Resolver;
  /** Credentials for login-protected sites; applied to the scanned site only. */
  auth?: SiteAuth;
}

export async function newGuardedContext(session: BrowserSession, opts: ContextOptions) {
  const mobile = opts.viewport.width < 768;
  const context = await session.browser.newContext({
    viewport: { width: opts.viewport.width, height: opts.viewport.height },
    deviceScaleFactor: 1,
    isMobile: mobile,
    hasTouch: mobile,
    userAgent: `${opts.userAgent}${mobile ? " Mobile" : ""}`,
    serviceWorkers: "block",
    ignoreHTTPSErrors: false,
    javaScriptEnabled: true,
    ...(opts.auth?.credentials.type === "basic"
      ? {
          httpCredentials: {
            username: opts.auth.credentials.username,
            password: opts.auth.credentials.password,
            // Basic credentials are only ever sent to the scanned site's origin.
            origin: new URL(opts.auth.siteUrl).origin,
          },
        }
      : {}),
  });
  if (opts.auth?.credentials.type === "cookies") {
    const origin = new URL(opts.auth.siteUrl).origin;
    await context.addCookies(
      parseCookieString(opts.auth.credentials.cookies).map((c) => ({
        name: c.name,
        value: c.value,
        url: origin,
      })),
    );
  }
  const guard: GuardState = { blocked: [] };
  await installNetworkGuard(context, opts.policy, opts.resolve, guard, opts.auth);
  return { context, guard };
}

export interface CapturedRequest {
  url: string;
  resourceType: string;
  method: string;
  status: number | null;
  transferSize: number | null;
  decodedSize: number | null;
  durationMs: number | null;
  failureText: string | null;
  fromCache: boolean | null;
  isMixedContent: boolean;
}

export interface ConsoleEntry {
  type: string;
  text: string;
  location: string | null;
}

export interface PageCaptureResult {
  viewport: ViewportSpec;
  requestedUrl: string;
  finalUrl: string | null;
  status: number | null;
  title: string | null;
  html: string | null;
  screenshot: Buffer | null;
  screenshotTruncated: boolean;
  console: ConsoleEntry[];
  pageErrors: string[];
  requests: CapturedRequest[];
  blockedRequests: GuardState["blocked"];
  timings: Record<string, number | null>;
  /** Absolute hrefs of <a>/<area> elements in the rendered DOM. */
  renderedLinks: string[];
  error: string | null;
}

const MAX_SCREENSHOT_HEIGHT = 12_000;

/**
 * Runs inside the page. Kept as a plain string on purpose: TypeScript runners such as tsx/esbuild
 * wrap named functions in a `__name()` helper that does not exist in the browser, which breaks
 * functions passed to page.evaluate. A string is sent to the page exactly as written.
 */
const TIMINGS_SCRIPT = `(() => {
  const nav = performance.getEntriesByType("navigation")[0];
  const fcp = performance.getEntriesByName("first-contentful-paint")[0];
  const round = (v) => (v === null || v === undefined || v <= 0 ? null : Math.round(v));
  return {
    ttfbMs: round(nav && nav.responseStart),
    domContentLoadedMs: round(nav && nav.domContentLoadedEventEnd),
    loadMs: round(nav && nav.loadEventEnd),
    firstContentfulPaintMs: round(fcp && fcp.startTime),
    transferSize: nav ? nav.transferSize : null,
    documentHeight: document.documentElement.scrollHeight,
    documentWidth: document.documentElement.scrollWidth,
  };
})()`;

function declaredLength(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  return Number(value);
}
const MAX_CONSOLE_ENTRIES = 200;
const MAX_REQUESTS = 1_000;

function attachCollectors(page: Page, pageUrl: string) {
  const consoleEntries: ConsoleEntry[] = [];
  const pageErrors: string[] = [];
  const requests: CapturedRequest[] = [];
  const pending: Promise<void>[] = [];
  const isHttpsPage = pageUrl.startsWith("https:");

  page.on("console", (msg) => {
    if (consoleEntries.length >= MAX_CONSOLE_ENTRIES) return;
    const loc = msg.location();
    consoleEntries.push({
      type: msg.type(),
      text: msg.text().slice(0, 2_000),
      location: loc.url ? `${loc.url}:${loc.lineNumber}` : null,
    });
  });
  page.on(
    "pageerror",
    (err) => pageErrors.length < 100 && pageErrors.push(err.message.slice(0, 2_000)),
  );

  const record = (req: Request, failed: boolean) => {
    if (requests.length >= MAX_REQUESTS || !/^https?:/i.test(req.url())) return;
    pending.push(
      (async () => {
        const response = failed ? null : await req.response().catch(() => null);
        const sizes = failed ? null : await req.sizes().catch(() => null);
        const t = req.timing();
        requests.push({
          url: req.url(),
          resourceType: req.resourceType(),
          method: req.method(),
          status: response?.status() ?? null,
          // Approximate bytes on the wire as reported by Chromium (request interception makes the
          // per-request accounting imprecise by a few hundred bytes).
          transferSize: sizes ? sizes.responseBodySize + sizes.responseHeadersSize : null,
          // Exact body size only when the server declared it; otherwise unknown (null).
          decodedSize: declaredLength(response?.headers()["content-length"]),
          durationMs: t.responseEnd > 0 ? Math.round(t.responseEnd) : null,
          failureText: failed ? (req.failure()?.errorText ?? "failed") : null,
          // Playwright does not expose HTTP cache hits: unknown, not "false".
          fromCache: null,
          isMixedContent: isHttpsPage && req.url().startsWith("http:"),
        });
      })(),
    );
  };
  page.on("requestfinished", (r) => record(r, false));
  page.on("requestfailed", (r) => record(r, true));
  return { consoleEntries, pageErrors, requests, settle: () => Promise.allSettled(pending) };
}

/** Loads one page in a guarded context and captures DOM, screenshot, network and console. */
export async function capturePage(
  context: BrowserContext,
  guard: GuardState,
  url: string,
  viewport: ViewportSpec,
  opts: { timeoutMs: number; screenshot: boolean; proxy?: GuardProxy | null },
): Promise<PageCaptureResult> {
  const page = await context.newPage();
  const blockedBefore = guard.blocked.length;
  const proxyBlockedBefore = opts.proxy?.blocked.length ?? 0;
  const collectors = attachCollectors(page, url);
  const base: PageCaptureResult = {
    viewport,
    requestedUrl: url,
    finalUrl: null,
    status: null,
    title: null,
    html: null,
    screenshot: null,
    screenshotTruncated: false,
    console: collectors.consoleEntries,
    pageErrors: collectors.pageErrors,
    requests: collectors.requests,
    blockedRequests: [],
    timings: {},
    renderedLinks: [],
    error: null,
  };
  try {
    const response = await page.goto(url, { waitUntil: "load", timeout: opts.timeoutMs });
    // Give late requests a short chance to finish; slow pages are captured as they are.
    await page
      .waitForLoadState("networkidle", { timeout: Math.min(5_000, opts.timeoutMs) })
      .catch(() => {});
    base.status = response?.status() ?? null;
    base.finalUrl = page.url();
    base.title = (await page.title()) || null;
    base.html = await page.content();
    base.timings = (await page.evaluate(TIMINGS_SCRIPT)) as Record<string, number | null>;
    base.renderedLinks = await page.$$eval("a[href], area[href]", (els) =>
      els.map((e) => (e as HTMLAnchorElement).href).filter((h) => /^https?:/i.test(h)),
    );
    if (opts.screenshot) {
      const height = (base.timings.documentHeight as number | null) ?? viewport.height;
      base.screenshotTruncated = height > MAX_SCREENSHOT_HEIGHT;
      base.screenshot = await page.screenshot({
        type: "png",
        fullPage: true,
        animations: "disabled",
        timeout: opts.timeoutMs,
        ...(base.screenshotTruncated
          ? { clip: { x: 0, y: 0, width: viewport.width, height: MAX_SCREENSHOT_HEIGHT } }
          : {}),
      });
    }
  } catch (err) {
    base.error = (err as Error).message.split("\n")[0]!.slice(0, 500);
  } finally {
    await collectors.settle();
    base.blockedRequests = [
      ...guard.blocked.slice(blockedBefore),
      ...(opts.proxy?.blocked.slice(proxyBlockedBefore) ?? []),
    ];
    await page.close().catch(() => {});
  }
  return base;
}

/** Lightweight render used during crawling to discover links created by JavaScript. */
export async function renderLinks(
  context: BrowserContext,
  url: string,
  timeoutMs: number,
): Promise<string[]> {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "load", timeout: timeoutMs });
    await page
      .waitForLoadState("networkidle", { timeout: Math.min(3_000, timeoutMs) })
      .catch(() => {});
    return await page.$$eval("a[href], area[href]", (els) =>
      els.map((e) => (e as HTMLAnchorElement).href).filter((h) => /^https?:/i.test(h)),
    );
  } finally {
    await page.close().catch(() => {});
  }
}
