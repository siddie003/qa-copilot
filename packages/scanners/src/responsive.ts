import type { Severity } from "@qa/core";
import type {
  CaptureRecord,
  CheckSummary,
  FindingDraft,
  PageRecord,
  Scanner,
  ScannerContext,
} from "./types";
import { analyzablePages, displayUrl, screenshotEvidence } from "./util";

type Box = { x: number; y: number; width: number; height: number };
interface Metrics {
  viewportWidth: number;
  overflowPx: number;
  overflowElements: Array<{ selector: string; right: number; width: number; box: Box }>;
  clippedText: Array<{
    selector: string;
    text: string;
    scrollWidth: number;
    clientWidth: number;
    box: Box;
  }>;
  smallTargets: Array<{ selector: string; width: number; height: number; label: string; box: Box }>;
  overlaps: Array<{ a: string; b: string; overlapRatio: number; boxA: Box; boxB: Box }>;
  smallText: {
    count: number;
    samples: Array<{ selector: string; fontSizePx: number; text: string }>;
  };
  images: Array<{ src: string; selector: string; broken: boolean; alt: string | null }>;
}

const TOUCH_MAX_WIDTH = 767;

// Live check of the mobile navigation (string script: see page-scripts.ts).
const NAV_STATE_SCRIPT = `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0 && r.bottom > 0 && r.right > 0 && r.left < innerWidth; };
  const links = Array.prototype.slice.call(document.querySelectorAll("nav a[href], header a[href], [role=navigation] a[href]"));
  const toggles = Array.prototype.slice.call(document.querySelectorAll("button, [role=button], a[href='#'], summary"))
    .filter((el) => vis(el) && (el.hasAttribute("aria-expanded") || el.hasAttribute("aria-controls") || /menu|nav|hamburger|burger/i.test((el.getAttribute("aria-label") || "") + " " + (el.className || "") + " " + (el.id || "") + " " + (el.textContent || ""))));
  toggles.forEach((el, i) => el.setAttribute("data-qa-nav-toggle", String(i)));
  return { total: links.length, visible: links.filter(vis).length, toggles: toggles.length, toggleLabel: toggles[0] ? (toggles[0].getAttribute("aria-label") || toggles[0].textContent || "").trim().slice(0, 60) : null };
})()`;

function metricsOf(c: CaptureRecord): Metrics | null {
  return (c.metrics as unknown as Metrics | null) ?? null;
}

export const responsiveScanner: Scanner = {
  key: "responsive",
  idPrefix: "RSP",
  version: "1.0.0",
  async run(ctx: ScannerContext) {
    const checks: CheckSummary = {
      evaluated: 0,
      inconclusive: [
        {
          check: "Spacing, alignment and layout against the design",
          reason:
            "Unable to verify without a processed design reference (design comparison: Phase 6)",
          pageUrl: null,
        },
      ],
    };
    const findings: FindingDraft[] = [];
    const pages = analyzablePages(ctx.pages);
    let measured = 0;

    for (const p of pages) {
      const url = displayUrl(p);
      for (const c of p.captures) {
        const m = c.error ? null : metricsOf(c);
        if (!m) {
          checks.inconclusive.push({
            check: `Layout at ${c.viewport}`,
            reason: c.error ? `Capture failed: ${c.error}` : "No layout measurements",
            pageUrl: url,
          });
          continue;
        }
        measured += 1;
        checks.evaluated += 6;
        const touch = c.width <= TOUCH_MAX_WIDTH;
        const shot = (extra: Record<string, unknown>) => screenshotEvidence(c, extra);
        const base = { pageId: p.id, pageUrl: url, viewport: c.viewport };

        if (m.overflowPx > 1) {
          const severity: Severity = c.width < 1024 ? "high" : "medium";
          const first = m.overflowElements[0];
          findings.push({
            ...base,
            ruleId: "horizontal-overflow",
            title: `Page scrolls horizontally at ${c.viewport} (${c.width}px)`,
            message: `The page is ${m.overflowPx}px wider than the ${c.width}px viewport${first ? `; ${first.selector} extends to ${first.right}px` : ""}. Users must scroll sideways.`,
            subcategory: "layout",
            selector: first?.selector ?? null,
            severity,
            verdict: "confirmed",
            confidence: 0.95,
            expected: `Content fits within ${c.width}px`,
            actual: `Document width ${c.width + m.overflowPx}px`,
            evidence: [
              {
                kind: "measurement",
                data: {
                  viewportWidth: c.width,
                  overflowPx: m.overflowPx,
                  elements: m.overflowElements,
                },
              },
              ...shot({ highlight: m.overflowElements.map((e) => e.box) }),
            ],
          });
        }
        for (const t of m.clippedText.slice(0, 5))
          findings.push({
            ...base,
            ruleId: "text-clipped",
            title: "Text is cut off by its container",
            message: `“${t.text}” does not fit in ${t.selector} at ${c.viewport} (content ${t.scrollWidth}px, box ${t.clientWidth}px) and is hidden by overflow.`,
            subcategory: "layout",
            selector: t.selector,
            severity: "medium",
            verdict: "potential",
            confidence: 0.75,
            expected: "Text fully visible (wrapping, or an ellipsis when truncation is intended)",
            actual: `${t.scrollWidth - t.clientWidth}px of content hidden`,
            evidence: [
              { kind: "measurement", data: t as unknown as Record<string, unknown> },
              ...shot({ highlight: [t.box] }),
            ],
          });
        for (const o of m.overlaps.slice(0, 5))
          findings.push({
            ...base,
            ruleId: "interactive-overlap",
            title: "Interactive elements overlap",
            message: `${o.a} and ${o.b} overlap by ${Math.round(o.overlapRatio * 100)}% at ${c.viewport}, so taps or clicks may hit the wrong one.`,
            subcategory: "layout",
            selector: `${o.a} ∩ ${o.b}`,
            severity: "medium",
            verdict: "potential",
            confidence: 0.7,
            expected: "Separate, non-overlapping targets",
            actual: `${Math.round(o.overlapRatio * 100)}% of the smaller target covered`,
            evidence: [
              { kind: "measurement", data: o as unknown as Record<string, unknown> },
              ...shot({ highlight: [o.boxA, o.boxB] }),
            ],
          });
        if (touch) {
          for (const s of m.smallTargets.slice(0, 5))
            findings.push({
              ...base,
              ruleId: "tap-target-small",
              title: "Touch target is smaller than 24×24 px",
              message: `${s.selector}${s.label ? ` (“${s.label}”)` : ""} is ${s.width}×${s.height}px at ${c.viewport}; WCAG 2.5.8 asks for at least 24×24 CSS px unless enough spacing surrounds it.`,
              subcategory: "touch",
              selector: s.selector,
              severity: "medium",
              verdict: "potential",
              confidence: 0.7,
              expected: "≥ 24×24 CSS px (44×44 recommended)",
              actual: `${s.width}×${s.height}px`,
              evidence: [
                { kind: "measurement", data: s as unknown as Record<string, unknown> },
                ...shot({ highlight: [s.box] }),
              ],
            });
          if (m.smallText.count > 0)
            findings.push({
              ...base,
              ruleId: "text-too-small-mobile",
              title: "Text is smaller than 12px on mobile",
              message: `${m.smallText.count} text element(s) render below 12px at ${c.viewport}, which is hard to read without zooming.`,
              subcategory: "typography",
              selector: m.smallText.samples[0]?.selector ?? null,
              severity: "low",
              verdict: "confirmed",
              confidence: 0.85,
              expected: "Body text ≥ 16px, never below 12px",
              actual: m.smallText.samples.map((x) => `${x.fontSizePx}px`).join(", "),
              evidence: [
                {
                  kind: "computed_style",
                  data: { count: m.smallText.count, samples: m.smallText.samples },
                },
              ],
            });
        }
        // Images that downloaded but do not render (failed downloads are reported by the link scanner).
        const failedUrls = new Set(
          c.requests.filter((r) => r.failureText || (r.status ?? 0) >= 400).map((r) => r.url),
        );
        for (const img of m.images.filter((i) => i.broken && !failedUrls.has(i.src)).slice(0, 5))
          findings.push({
            ...base,
            ruleId: "image-not-rendered",
            title: "Image does not render",
            message: `${img.src} downloaded but could not be displayed (invalid or unsupported image data).`,
            subcategory: "images",
            selector: img.selector,
            severity: "medium",
            verdict: "confirmed",
            confidence: 0.85,
            expected: "Image renders",
            actual: "naturalWidth = 0 after load",
            fingerprintKey: img.src,
            evidence: [
              { kind: "measurement", data: img as unknown as Record<string, unknown> },
              ...shot({}),
            ],
          });
      }
    }

    const merged = mergeAcrossViewports(findings);
    findings.length = 0;
    findings.push(...merged);

    // Live mobile navigation check on the start page at the narrowest touch viewport.
    const narrow = [...ctx.viewports]
      .sort((a, b) => a.width - b.width)
      .find((v) => v.width <= TOUCH_MAX_WIDTH);
    const home = pages.find((p) => p.depth === 0) ?? pages[0];
    if (narrow && home) findings.push(...(await mobileNavFindings(ctx, home, narrow, checks)));
    else if (!narrow)
      checks.inconclusive.push({
        check: "Mobile navigation",
        reason: "No viewport narrower than 768px is configured",
        pageUrl: null,
      });

    if (!measured)
      return {
        status: "inconclusive",
        statusReason: "No page captures with layout measurements",
        findings,
        checks,
        toolName: "QA Copilot layout checks",
        toolVersion: "1.0.0",
      };
    return {
      status: "completed",
      statusReason: `${measured} page/viewport layout${measured === 1 ? "" : "s"} measured (overflow, clipping, overlaps, touch targets, text size, images) plus a live mobile navigation test; ${findings.length} finding${findings.length === 1 ? "" : "s"}`,
      findings,
      checks,
      toolName: "QA Copilot layout checks",
      toolVersion: "1.0.0",
    };
  },
};

const RANK: Record<Severity, number> = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };

/**
 * The same problem (rule + page + element) seen at several viewports becomes one finding that
 * lists the viewports, keeps the highest severity and all evidence.
 */
export function mergeAcrossViewports(findings: FindingDraft[]): FindingDraft[] {
  const groups = new Map<string, FindingDraft[]>();
  for (const f of findings) {
    const key = `${f.ruleId}|${f.pageId ?? ""}|${f.selector ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  return [...groups.values()].map((group) => {
    if (group.length === 1) return group[0]!;
    const base = group.reduce((a, b) => (RANK[b.severity] > RANK[a.severity] ? b : a));
    const viewports = group.map((g) => g.viewport).filter(Boolean) as string[];
    return {
      ...base,
      title:
        base.ruleId === "horizontal-overflow"
          ? `Page scrolls horizontally (${viewports.join(", ")})`
          : base.title,
      message: `${base.message} Also observed at: ${viewports.filter((v) => v !== base.viewport).join(", ")}.`,
      viewport: null,
      evidence: group.flatMap((g) => g.evidence).slice(0, 12),
    };
  });
}

async function mobileNavFindings(
  ctx: ScannerContext,
  home: PageRecord,
  viewport: { name: string; width: number; height: number },
  checks: CheckSummary,
): Promise<FindingDraft[]> {
  const url = displayUrl(home);
  let live;
  try {
    live = await ctx.openPage(url, viewport);
    const before = (await live.page.evaluate(NAV_STATE_SCRIPT)) as {
      total: number;
      visible: number;
      toggles: number;
      toggleLabel: string | null;
    };
    checks.evaluated += 1;
    if (before.total === 0) {
      checks.inconclusive.push({
        check: "Mobile navigation",
        reason: "No links inside <nav> or <header> on the start page",
        pageUrl: url,
      });
      return [];
    }
    if (before.visible > 0) return [];
    const base = {
      pageId: home.id,
      pageUrl: url,
      viewport: viewport.name,
      subcategory: "navigation",
      confidence: 0.85,
    };
    if (before.toggles === 0)
      return [
        {
          ...base,
          ruleId: "mobile-nav-unreachable",
          title: "Navigation is not reachable on mobile",
          message: `At ${viewport.width}px all ${before.total} navigation links are hidden and no menu button was found.`,
          severity: "high",
          verdict: "confirmed",
          expected: "Visible navigation or a menu button that reveals it",
          actual: `0 of ${before.total} links visible, no toggle`,
          evidence: [
            {
              kind: "measurement",
              data: {
                viewport: viewport.name,
                linksTotal: before.total,
                linksVisible: 0,
                toggles: 0,
              },
            },
          ],
        },
      ];
    await live.page.click('[data-qa-nav-toggle="0"]', { timeout: 5_000 });
    await live.page.waitForTimeout(500);
    const after = (await live.page.evaluate(NAV_STATE_SCRIPT)) as { visible: number };
    if (after.visible > 0) return [];
    return [
      {
        ...base,
        ruleId: "mobile-menu-broken",
        title: "Mobile menu button does not reveal the navigation",
        message: `Tapping “${before.toggleLabel || "menu"}” at ${viewport.width}px left all ${before.total} navigation links hidden.`,
        selector: `menu toggle “${before.toggleLabel ?? ""}”`,
        severity: "high",
        verdict: "confirmed",
        expected: "Navigation links become visible after tapping the menu button",
        actual: "Still 0 visible links after tapping",
        evidence: [
          {
            kind: "measurement",
            data: {
              viewport: viewport.name,
              linksTotal: before.total,
              visibleBefore: 0,
              visibleAfter: after.visible,
              toggle: before.toggleLabel,
            },
          },
        ],
      },
    ];
  } catch (err) {
    checks.inconclusive.push({
      check: "Mobile navigation",
      reason: `Could not test: ${(err as Error).message.slice(0, 200)}`,
      pageUrl: url,
    });
    return [];
  } finally {
    await live?.close();
  }
}
