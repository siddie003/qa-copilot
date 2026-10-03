import type { Severity } from "@qa/core";
import type {
  CaptureRecord,
  CheckSummary,
  FindingDraft,
  PageRecord,
  Scanner,
  ScannerContext,
} from "./types";
import { analyzablePages, displayUrl, formatBytes, sample, screenshotEvidence } from "./util";

/** Google's published thresholds ("needs improvement" / "poor"). */
const METRICS = [
  {
    id: "lcp",
    label: "Largest Contentful Paint",
    unit: "ms",
    good: 2500,
    poor: 4000,
    read: (c: CaptureRecord) => vitals(c)?.lcpMs ?? null,
  },
  {
    id: "cls",
    label: "Cumulative Layout Shift",
    unit: "",
    good: 0.1,
    poor: 0.25,
    read: (c: CaptureRecord) => vitals(c)?.cls ?? null,
  },
  {
    id: "tbt",
    label: "Total Blocking Time (approximation)",
    unit: "ms",
    good: 200,
    poor: 600,
    read: (c: CaptureRecord) => vitals(c)?.tbtMs ?? null,
  },
  {
    id: "ttfb",
    label: "Time to First Byte",
    unit: "ms",
    good: 800,
    poor: 1800,
    read: (c: CaptureRecord) => num(c.timings.ttfbMs),
  },
  {
    id: "fcp",
    label: "First Contentful Paint",
    unit: "ms",
    good: 1800,
    poor: 3000,
    read: (c: CaptureRecord) => num(c.timings.firstContentfulPaintMs),
  },
] as const;

const PAGE_WEIGHT = { medium: 3_000_000, high: 6_000_000 };
const JS_BUDGET = 1_000_000;
const CSS_BUDGET = 300_000;
const REQUEST_BUDGET = 100;
const LARGE_IMAGE = 300_000;

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function vitals(c: CaptureRecord) {
  const v = c.metrics?.vitals as
    { lcpMs?: number | null; cls?: number | null; tbtMs?: number | null } | null | undefined;
  return v ?? null;
}
const fmt = (v: number, unit: string) => (unit === "ms" ? `${Math.round(v)} ms` : v.toFixed(3));
const bytesOf = (r: { decodedSize: number | null; transferSize: number | null }) =>
  r.decodedSize ?? r.transferSize ?? 0;

export const performanceScanner: Scanner = {
  key: "performance",
  idPrefix: "PERF",
  version: "1.0.0",
  async run(ctx: ScannerContext) {
    const checks: CheckSummary = {
      evaluated: 0,
      inconclusive: [],
      notes: [
        "Lab measurements from a single page load in the scanner's environment; field data from real users can differ.",
      ],
    };
    const findings: FindingDraft[] = [];
    const pages = analyzablePages(ctx.pages).filter((p) => p.captures.some((c) => !c.error));
    const largeImages = new Map<
      string,
      { bytes: number; pages: Set<string>; firstPage: PageRecord }
    >();
    const blocking = new Map<string, { type: string; pages: Set<string>; firstPage: PageRecord }>();

    for (const p of pages) {
      const caps = p.captures.filter((c) => !c.error);
      const url = displayUrl(p);

      // Timing metrics: one finding per page and metric, at the worst viewport.
      for (const m of METRICS) {
        const values = caps
          .map((c) => ({ c, v: m.read(c) }))
          .filter((x): x is { c: CaptureRecord; v: number } => x.v !== null);
        checks.evaluated += 1;
        if (!values.length) {
          checks.inconclusive.push({
            check: m.label,
            reason: "Not measurable in this browser session",
            pageUrl: url,
          });
          continue;
        }
        const worst = values.reduce((a, b) => (b.v > a.v ? b : a));
        if (worst.v <= m.good) continue;
        const severity: Severity = worst.v > m.poor ? "high" : "medium";
        findings.push({
          ruleId: `${m.id}-slow`,
          title: `${m.label} ${severity === "high" ? "is poor" : "needs improvement"}`,
          message: `${m.label} measured ${fmt(worst.v, m.unit)} at ${worst.c.viewport} (good: ≤ ${fmt(m.good, m.unit)}, poor: > ${fmt(m.poor, m.unit)}).`,
          subcategory: "web-vitals",
          pageId: p.id,
          pageUrl: url,
          viewport: worst.c.viewport,
          severity,
          verdict: "confirmed",
          confidence: 0.75,
          expected: `≤ ${fmt(m.good, m.unit)}`,
          actual: fmt(worst.v, m.unit),
          evidence: [
            {
              kind: "measurement",
              data: {
                metric: m.id,
                label: m.label,
                unit: m.unit || "score",
                values: Object.fromEntries(values.map((x) => [x.c.viewport, x.v])),
                thresholds: { good: m.good, poor: m.poor },
                lcpElement:
                  m.id === "lcp"
                    ? ((vitals(worst.c) as { lcpElement?: string } | null)?.lcpElement ?? null)
                    : undefined,
              },
            },
            ...screenshotEvidence(worst.c),
          ],
        });
      }

      // Resource budgets from the first successful capture (desktop).
      const c = caps[0]!;
      const reqs = c.requests.filter((r) => !r.failureText);
      const total = reqs.reduce((s, r) => s + bytesOf(r), 0);
      const js = reqs
        .filter((r) => r.resourceType === "script")
        .reduce((s, r) => s + bytesOf(r), 0);
      const css = reqs
        .filter((r) => r.resourceType === "stylesheet")
        .reduce((s, r) => s + bytesOf(r), 0);
      const top = [...reqs]
        .sort((a, b) => bytesOf(b) - bytesOf(a))
        .slice(0, 5)
        .map((r) => ({ url: r.url, type: r.resourceType, bytes: bytesOf(r) }));
      checks.evaluated += 4;
      const budget = (
        ruleId: string,
        title: string,
        value: number,
        limit: number,
        severity: Severity,
        what: string,
      ) =>
        findings.push({
          ruleId,
          title,
          message: `${what} is ${formatBytes(value)} on this page (budget ${formatBytes(limit)}).`,
          subcategory: "page-weight",
          pageId: p.id,
          pageUrl: url,
          viewport: c.viewport,
          severity,
          verdict: "confirmed",
          confidence: 0.8,
          expected: `≤ ${formatBytes(limit)}`,
          actual: formatBytes(value),
          evidence: [
            {
              kind: "measurement",
              data: {
                totalBytes: total,
                scriptBytes: js,
                stylesheetBytes: css,
                requests: c.requests.length,
                largestResources: top,
                viewport: c.viewport,
              },
            },
          ],
        });
      if (total > PAGE_WEIGHT.medium)
        budget(
          "page-weight",
          "Page is heavy",
          total,
          PAGE_WEIGHT.medium,
          total > PAGE_WEIGHT.high ? "high" : "medium",
          "The total download size",
        );
      if (js > JS_BUDGET)
        budget(
          "javascript-size",
          "Large amount of JavaScript",
          js,
          JS_BUDGET,
          "medium",
          "JavaScript",
        );
      if (css > CSS_BUDGET)
        budget("css-size", "Large amount of CSS", css, CSS_BUDGET, "low", "CSS");
      if (c.requests.length > REQUEST_BUDGET)
        findings.push({
          ruleId: "request-count",
          title: "Many network requests",
          message: `The page makes ${c.requests.length} requests (budget ${REQUEST_BUDGET}).`,
          subcategory: "page-weight",
          pageId: p.id,
          pageUrl: url,
          viewport: c.viewport,
          severity: "low",
          verdict: "confirmed",
          confidence: 0.8,
          expected: `≤ ${REQUEST_BUDGET} requests`,
          actual: `${c.requests.length} requests`,
          evidence: [
            {
              kind: "measurement",
              data: {
                requests: c.requests.length,
                byType: countBy(c.requests.map((r) => r.resourceType)),
              },
            },
          ],
        });

      // Images: heavy files and files much larger than displayed.
      const images =
        (c.metrics?.images as
          | Array<{ src: string; selector: string; naturalWidth: number; renderedWidth: number }>
          | undefined) ?? [];
      for (const r of reqs.filter((x) => x.resourceType === "image")) {
        const bytes = bytesOf(r);
        if (bytes > LARGE_IMAGE) {
          const e = largeImages.get(r.url) ?? { bytes, pages: new Set<string>(), firstPage: p };
          e.pages.add(url);
          largeImages.set(r.url, e);
        }
      }
      for (const img of images) {
        const req = reqs.find((r) => r.url === img.src);
        const bytes = req ? bytesOf(req) : 0;
        if (img.renderedWidth > 0 && img.naturalWidth > img.renderedWidth * 2 && bytes > 50_000)
          findings.push({
            ruleId: "image-oversized",
            title: "Image is much larger than its displayed size",
            message: `${img.src} is ${img.naturalWidth}px wide but displayed at ${img.renderedWidth}px at ${c.viewport}; serve a resized or responsive (srcset) version.`,
            subcategory: "images",
            pageId: p.id,
            pageUrl: url,
            selector: img.selector,
            viewport: c.viewport,
            severity: "low",
            verdict: "confirmed",
            confidence: 0.85,
            expected: `≤ ${img.renderedWidth * 2}px wide (2× for high-density screens)`,
            actual: `${img.naturalWidth}px (${formatBytes(bytes)})`,
            fingerprintKey: img.src,
            evidence: [
              {
                kind: "measurement",
                data: {
                  src: img.src,
                  naturalWidth: img.naturalWidth,
                  renderedWidth: img.renderedWidth,
                  bytes,
                },
              },
            ],
          });
      }
      // Render-blocking resources from every viewport (a resource may only load at some sizes).
      for (const b of caps.flatMap(
        (cap) =>
          (cap.metrics?.renderBlocking as Array<{ type: string; url: string }> | undefined) ?? [],
      )) {
        const e = blocking.get(b.url) ?? { type: b.type, pages: new Set<string>(), firstPage: p };
        e.pages.add(url);
        blocking.set(b.url, e);
      }
    }

    for (const [src, e] of largeImages)
      findings.push({
        ruleId: "image-large",
        title: "Large image file",
        message: `${src} is ${formatBytes(e.bytes)}. Compress it or use a modern format (WebP/AVIF).`,
        subcategory: "images",
        pageId: e.pages.size === 1 ? e.firstPage.id : null,
        pageUrl: displayUrl(e.firstPage),
        severity: "medium",
        verdict: "confirmed",
        confidence: 0.9,
        expected: `≤ ${formatBytes(LARGE_IMAGE)}`,
        actual: formatBytes(e.bytes),
        fingerprintKey: src,
        evidence: [
          {
            kind: "network",
            data: {
              url: src,
              bytes: e.bytes,
              source: "Content-Length header",
              pages: sample([...e.pages], 10),
            },
          },
        ],
      });
    for (const [src, e] of blocking)
      findings.push({
        ruleId: "render-blocking-resource",
        title: `Render-blocking ${e.type}`,
        message: `${src} is loaded in <head> ${e.type === "script" ? "without async or defer" : "as a blocking stylesheet"}, delaying the first render on ${e.pages.size} page(s).`,
        subcategory: "render-blocking",
        pageId: e.pages.size === 1 ? e.firstPage.id : null,
        pageUrl: displayUrl(e.firstPage),
        severity: "low",
        verdict: "confirmed",
        confidence: 0.85,
        expected:
          e.type === "script"
            ? "async/defer scripts or scripts at the end of <body>"
            : "Critical CSS inlined, the rest loaded without blocking",
        actual: `Blocking ${e.type} in <head>`,
        fingerprintKey: src,
        evidence: [
          {
            kind: "html_snippet",
            data: { resource: src, type: e.type, pages: sample([...e.pages], 10) },
          },
        ],
      });

    if (!pages.length)
      return {
        status: "inconclusive",
        statusReason: "No successful page captures to measure",
        findings,
        checks,
        toolName: "Chromium performance APIs",
        toolVersion: "1.0.0",
      };
    return {
      status: "completed",
      statusReason: `${pages.length} page${pages.length === 1 ? "" : "s"} measured (lab Core Web Vitals, TTFB/FCP, page weight, images, render-blocking resources); ${findings.length} finding${findings.length === 1 ? "" : "s"}`,
      findings,
      checks,
      toolName: "Chromium performance APIs",
      toolVersion: "1.0.0",
    };
  },
};

function countBy(items: string[]) {
  const out: Record<string, number> = {};
  for (const i of items) out[i] = (out[i] ?? 0) + 1;
  return out;
}
