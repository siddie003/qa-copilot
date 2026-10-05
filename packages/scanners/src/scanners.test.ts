import type { FetchResult } from "@qa/crawler";
import { describe, expect, it } from "vitest";
import { classifyLink } from "./links";
import { performanceScanner } from "./performance";
import { mergeAcrossViewports, responsiveScanner } from "./responsive";
import { maskSecret, parseCsp, securityScanner } from "./security";
import { seoScanner } from "./seo";
import {
  findingDraftSchema,
  type CaptureRecord,
  type PageRecord,
  type ScannerContext,
} from "./types";
import { analyzablePages } from "./util";

// Synthetic, in-memory inputs: these tests exercise scanner logic without network or browser.
let n = 0;
type PageInput = Omit<Partial<PageRecord>, "captures"> & {
  html?: string;
  dom?: string;
  captures?: Array<Partial<CaptureRecord>>;
};

function page(over: PageInput = {}): PageRecord {
  n += 1;
  const id = over.id ?? `p${n}`;
  const {
    html = '<html lang="en"><head><title>A good descriptive title</title></head><body><h1>Hi</h1></body></html>',
    dom,
    captures = [],
    ...rest
  } = over;
  const defaults: PageRecord = {
    id,
    url: `https://example.com/page-${n}`,
    finalUrl: null,
    httpStatus: 200,
    depth: 1,
    title: null,
    contentType: "text/html; charset=utf-8",
    crawlError: null,
    redirectChain: null,
    responseHeaders: {},
    loadRawHtml: async () => html,
    captures: [],
  };
  const captureDefaults = (): CaptureRecord => ({
    pageId: id,
    viewport: "desktop",
    width: 1440,
    height: 900,
    screenshotKey: null,
    error: null,
    timings: {},
    metrics: null,
    consoleMessages: [],
    requests: [],
    loadDom: async () => dom ?? null,
    loadDesignStyles: async () => null,
    loadTextContent: async () => null,
  });
  return Object.assign(defaults, rest, {
    captures: captures.map((c) => Object.assign(captureDefaults(), c)),
  });
}

function ctx(pages: PageRecord[], over: Partial<ScannerContext> = {}): ScannerContext {
  return {
    scanId: "s1",
    siteUrl: "https://example.com/",
    viewports: [{ name: "desktop", width: 1440, height: 900 }],
    pages,
    robots: {
      url: "https://example.com/robots.txt",
      status: "found",
      httpStatus: 200,
      sitemaps: [],
      isAllowed: () => true,
      body: "",
    },
    fetch: {
      policy: { allowedPrivateHosts: [] },
      dispatcher: {} as never,
      userAgent: "t",
      timeoutMs: 1000,
      retries: 0,
      resolve: async () => {
        throw Object.assign(new Error("offline"), { code: "ENOTFOUND" });
      },
    },
    signal: new AbortController().signal,
    openPage: async () => {
      throw new Error("no browser in unit tests");
    },
    pageTimeoutMs: 1000,
    log: () => {},
    references: { designSpec: null, content: null },
    ...over,
  };
}

const rules = (r: { findings: Array<{ ruleId: string }> }) =>
  r.findings.map((f) => f.ruleId).sort();

describe("analyzablePages", () => {
  it("drops failed, non-HTML and redirect duplicates of the same document", () => {
    const direct = page({ url: "https://example.com/about" });
    const redirected = page({
      url: "https://example.com/old",
      finalUrl: "https://example.com/about",
      redirectChain: [{ url: "https://example.com/old", status: 301 }],
    });
    const pdf = page({ contentType: "application/pdf" });
    const missing = page({ httpStatus: 404 });
    expect(analyzablePages([redirected, direct, pdf, missing]).map((p) => p.id)).toEqual([
      direct.id,
    ]);
  });
});

describe("security scanner", () => {
  it("parses CSP directives", () => {
    const csp = parseCsp(
      "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.x; frame-ancestors 'none'",
    )!;
    expect(csp.get("script-src")).toEqual(["'self'", "'unsafe-inline'", "https://cdn.x"]);
    expect(csp.has("frame-ancestors")).toBe(true);
  });

  it("reports nothing for a well-configured HTTPS site", async () => {
    const good = page({
      url: "https://example.com/",
      responseHeaders: {
        "strict-transport-security": "max-age=31536000; includeSubDomains",
        "content-security-policy":
          "default-src 'self'; script-src 'self' 'nonce-abc'; frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
        "referrer-policy": "strict-origin-when-cross-origin",
        "permissions-policy": "camera=()",
        server: "nginx",
        "set-cookie": ["sid=[redacted]; Secure; HttpOnly; SameSite=Lax"],
      },
      html: '<html><head><script src="https://cdn.other.com/a.js" integrity="sha384-x" crossorigin="anonymous"></script></head><body><form action="/save"></form></body></html>',
    });
    const r = await securityScanner.run(ctx([good]));
    expect(r.status).toBe("completed");
    expect(r.findings).toEqual([]);
    // The http→https probe could not be made offline: reported, not guessed.
    expect(r.checks.inconclusive.map((c) => c.check)).toContain("HTTP to HTTPS redirect");
  });

  it("detects missing/weak headers, cookie flags, insecure forms, missing SRI and secrets", async () => {
    const bad = page({
      url: "https://example.com/",
      responseHeaders: {
        "strict-transport-security": "max-age=3600",
        "content-security-policy": "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
        "referrer-policy": "unsafe-url",
        server: "Apache/2.4.1",
        "x-powered-by": "PHP/8.2",
        "set-cookie": ["sid=[redacted]; Path=/"],
      },
      html: '<html><head><script src="https://cdn.other.com/lib.js"></script></head><body><form action="http://example.com/login"></form><!-- AKIAIOSFODNN7EXAMPLE --></body></html>',
    });
    const r = await securityScanner.run(ctx([bad]));
    expect(rules(r)).toEqual(
      [
        "cookie-flags",
        "csp-unsafe-script",
        "exposed-secret-aws-access-key",
        "frame-protection-missing",
        "hsts-weak",
        "insecure-form-action",
        "permissions-policy-missing",
        "referrer-policy-unsafe",
        "server-version-disclosure",
        "sri-missing",
        "x-content-type-options-missing",
      ].sort(),
    );
    const secret = r.findings.find((f) => f.ruleId.startsWith("exposed-secret"))!;
    expect(JSON.stringify(secret)).not.toContain("AKIAIOSFODNN7EXAMPLE"); // masked everywhere
    expect(secret.verdict).toBe("potential");
    expect(r.findings.find((f) => f.ruleId === "cookie-flags")!.severity).toBe("medium"); // missing Secure on HTTPS
  });

  it("reports plain HTTP sites and never uses HSTS rules on them", async () => {
    const r = await securityScanner.run(
      ctx([page({ url: "http://example.com/" })], { siteUrl: "http://example.com/" }),
    );
    expect(rules(r)).toContain("https-not-used");
    expect(rules(r).some((x) => x.startsWith("hsts"))).toBe(false);
  });

  it("masks secrets", () => {
    expect(maskSecret("AKIAIOSFODNN7EXAMPLE")).toBe("AKIA************LE");
  });
});

describe("seo scanner", () => {
  it("finds on-page problems from the rendered DOM", async () => {
    const dom = `<html><head><title>Hi</title><script type="application/ld+json">{"broken": </script></head>
      <body><h1>A</h1><h1>B</h1><h4>skip</h4><img src="x.png"></body></html>`;
    const p = page({ captures: [{}], dom });
    const r = await seoScanner.run(ctx([p]));
    const ids = rules(r);
    for (const id of [
      "title-length",
      "meta-description-missing",
      "h1-multiple",
      "heading-level-skipped",
      "html-lang-missing",
      "viewport-meta-missing",
      "img-alt-attribute-missing",
      "structured-data-invalid",
      "canonical-missing",
      "open-graph-missing",
    ])
      expect(ids).toContain(id);
    expect(r.findings.find((f) => f.ruleId === "title-length")!.evidence[0]!.data.source).toBe(
      "rendered DOM",
    );
  });

  it("detects duplicates across pages and a missing sitemap (reported as inconclusive when unreachable)", async () => {
    const html = (t: string) =>
      `<html lang="en"><head><title>${t}</title><meta name="description" content="A sufficiently long description of this page for search results."><meta name="viewport" content="width=device-width"><link rel="canonical" href="/x"></head><body><h1>x</h1></body></html>`;
    const r = await seoScanner.run(
      ctx([page({ html: html("Same title here!") }), page({ html: html("Same title here!") })]),
    );
    expect(rules(r)).toContain("title-duplicate");
    expect(rules(r)).toContain("meta-description-duplicate");
    expect(r.checks.inconclusive.some((c) => c.check === "Sitemap")).toBe(true);
  });

  it("treats noindex as potential (it may be intentional)", async () => {
    const r = await seoScanner.run(ctx([page({ responseHeaders: { "x-robots-tag": "noindex" } })]));
    expect(r.findings.find((f) => f.ruleId === "noindex")!.verdict).toBe("potential");
  });
});

describe("link classification", () => {
  const res = (over: Partial<FetchResult>): FetchResult => ({
    requestedUrl: "u",
    finalUrl: "u",
    status: 200,
    headers: {},
    contentType: null,
    redirectChain: [],
    body: null,
    bodyTruncated: false,
    durationMs: 1,
    attempts: 1,
    error: null,
    ...over,
  });
  it.each([
    [res({ status: 404 }), "broken"],
    [res({ status: 410 }), "broken"],
    [res({ status: 500 }), "broken"],
    [res({ status: 503, attempts: 3 }), "temporary"],
    [res({ status: 403 }), "inconclusive"],
    [res({ status: 429 }), "inconclusive"],
    [
      res({ status: null, error: { code: "ETIMEDOUT", message: "t", transient: true } }),
      "temporary",
    ],
    [
      res({
        status: null,
        error: { code: "DNS_FAILURE", message: "d", transient: false, dnsCode: "ENOTFOUND" },
      }),
      "broken",
    ],
    [
      res({
        status: null,
        error: { code: "DNS_FAILURE", message: "d", transient: true, dnsCode: "EAI_AGAIN" },
      }),
      "temporary",
    ],
    [
      res({ status: null, error: { code: "PRIVATE_ADDRESS", message: "p", transient: false } }),
      "inconclusive",
    ],
    [
      res({
        redirectChain: [
          { url: "a", status: 301 },
          { url: "b", status: 302 },
        ],
      }),
      "redirect",
    ],
    [res({}), "ok"],
  ])("%#", (r, kind) => {
    expect(classifyLink(r).kind).toBe(kind);
  });
});

describe("performance scanner", () => {
  it("applies Core Web Vitals thresholds at the worst viewport and flags large images", async () => {
    const p = page({
      captures: [
        {
          viewport: "desktop",
          timings: { ttfbMs: 300, firstContentfulPaintMs: 900 },
          metrics: {
            vitals: { lcpMs: 2000, cls: 0.02, tbtMs: 50 },
            images: [],
            renderBlocking: [],
          },
          requests: [
            {
              url: "https://example.com/big.jpg",
              resourceType: "image",
              method: "GET",
              status: 200,
              transferSize: 900_000,
              decodedSize: 900_000,
              durationMs: 10,
              failureText: null,
              isMixedContent: false,
            },
          ],
        },
        {
          viewport: "mobile",
          width: 390,
          timings: { ttfbMs: 2000, firstContentfulPaintMs: 3500 },
          metrics: {
            vitals: { lcpMs: 4500, cls: 0.3, tbtMs: 100 },
            images: [],
            renderBlocking: [{ type: "script", url: "https://example.com/a.js" }],
          },
          requests: [],
        },
      ],
    });
    const r = await performanceScanner.run(ctx([p]));
    const lcp = r.findings.find((f) => f.ruleId === "lcp-slow")!;
    expect(lcp).toMatchObject({ severity: "high", viewport: "mobile", actual: "4500 ms" });
    expect(lcp.evidence[0]!.data.values).toEqual({ desktop: 2000, mobile: 4500 });
    expect(rules(r)).toEqual([
      "cls-slow",
      "fcp-slow",
      "image-large",
      "lcp-slow",
      "render-blocking-resource",
      "ttfb-slow",
    ]);
    expect(r.findings.find((f) => f.ruleId === "tbt-slow")).toBeUndefined();
  });

  it("reports unmeasurable metrics as inconclusive, not as passing", async () => {
    const r = await performanceScanner.run(
      ctx([page({ captures: [{ metrics: { vitals: null, images: [], renderBlocking: [] } }] })]),
    );
    expect(r.checks.inconclusive.map((c) => c.check)).toContain("Largest Contentful Paint");
  });
});

describe("responsive scanner", () => {
  const metrics = (over: Record<string, unknown>) => ({
    viewportWidth: 390,
    overflowPx: 0,
    overflowElements: [],
    clippedText: [],
    smallTargets: [],
    overlaps: [],
    smallText: { count: 0, samples: [] },
    images: [],
    ...over,
  });
  it("detects overflow, small targets and small text, merging viewports", async () => {
    const box = { x: 0, y: 0, width: 10, height: 10 };
    const p = page({
      depth: 1,
      captures: [
        {
          viewport: "mobile",
          width: 390,
          metrics: metrics({
            overflowPx: 700,
            overflowElements: [{ selector: "div.banner", right: 1090, width: 1100, box }],
            smallTargets: [{ selector: "button.q", width: 16, height: 16, label: "?", box }],
            smallText: {
              count: 2,
              samples: [{ selector: "small", fontSizePx: 9, text: "fine print" }],
            },
          }),
        },
        {
          viewport: "tablet",
          width: 768,
          metrics: metrics({
            overflowPx: 330,
            overflowElements: [{ selector: "div.banner", right: 1090, width: 1100, box }],
          }),
        },
        { viewport: "desktop", width: 1440, metrics: metrics({}) },
      ],
    });
    const r = await responsiveScanner.run(
      ctx([p], { viewports: [{ name: "desktop", width: 1440, height: 900 }] }),
    );
    const overflow = r.findings.filter((f) => f.ruleId === "horizontal-overflow");
    expect(overflow).toHaveLength(1);
    expect(overflow[0]).toMatchObject({ viewport: null, severity: "high", selector: "div.banner" });
    expect(rules(r)).toEqual(["horizontal-overflow", "tap-target-small", "text-too-small-mobile"]);
    // No touch viewport configured: the mobile nav test is reported as not run.
    expect(r.checks.inconclusive.map((c) => c.check)).toContain("Mobile navigation");
  });

  it("merges identical problems across viewports", () => {
    const f = (viewport: string, severity: "high" | "medium") => ({
      ruleId: "text-clipped",
      title: "t",
      message: "m",
      pageId: "p",
      selector: "div",
      viewport,
      severity,
      verdict: "potential" as const,
      confidence: 0.7,
      evidence: [{ kind: "measurement" as const, data: { viewport } }],
    });
    const merged = mergeAcrossViewports([f("mobile", "medium"), f("desktop", "high")]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ viewport: null, severity: "high" });
    expect(merged[0]!.evidence).toHaveLength(2);
  });
});

describe("finding contract", () => {
  it("rejects findings without evidence", () => {
    const base = {
      ruleId: "r",
      title: "t",
      message: "m",
      severity: "low",
      verdict: "confirmed",
      confidence: 1,
    };
    expect(findingDraftSchema.safeParse({ ...base, evidence: [] }).success).toBe(false);
    expect(
      findingDraftSchema.safeParse({ ...base, evidence: [{ kind: "document", data: { a: 1 } }] })
        .success,
    ).toBe(true);
  });
});
