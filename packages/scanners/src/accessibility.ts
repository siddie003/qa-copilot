import AxeBuilder from "@axe-core/playwright";
import type { Page } from "playwright";
import type { Severity } from "@qa/core";
import type { CheckSummary, FindingDraft, PageRecord, Scanner, ScannerContext } from "./types";
import {
  analyzablePages,
  captureFor,
  displayUrl,
  pool,
  screenshotEvidence,
  truncate,
} from "./util";

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];
const IMPACT: Record<string, Severity> = {
  critical: "critical",
  serious: "high",
  moderate: "medium",
  minor: "low",
};
const LOWER: Record<Severity, Severity> = {
  critical: "high",
  high: "medium",
  medium: "low",
  low: "info",
  info: "info",
};
const MAX_NODES_PER_RULE = 15;
/** Page cap when the context sets none (the worker passes the scan's page limit by default). */
export const DEFAULT_ACCESSIBILITY_MAX_PAGES = 25;
const FOCUS_ELEMENTS = 25;
const CONCURRENCY = 3;

// In-page scripts (strings: see packages/browser/src/page-scripts.ts for why).
const FOCUS_BASELINE_SCRIPT = `(() => {
  const els = Array.prototype.slice.call(document.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, [tabindex]:not([tabindex="-1"])'))
    .filter((el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && !el.disabled; })
    .slice(0, ${FOCUS_ELEMENTS});
  els.forEach((el, i) => el.setAttribute("data-qa-focus-idx", String(i)));
  return els.map((el) => { const cs = getComputedStyle(el); return [cs.outlineStyle, cs.outlineWidth, cs.outlineColor, cs.boxShadow, cs.borderColor, cs.backgroundColor, cs.textDecorationLine, cs.color].join("|"); });
})()`;
const FOCUS_ACTIVE_SCRIPT = `(() => {
  const el = document.activeElement;
  if (!el || !el.hasAttribute("data-qa-focus-idx")) return null;
  const cs = getComputedStyle(el);
  const outline = cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0;
  return {
    idx: Number(el.getAttribute("data-qa-focus-idx")),
    style: [cs.outlineStyle, cs.outlineWidth, cs.outlineColor, cs.boxShadow, cs.borderColor, cs.backgroundColor, cs.textDecorationLine, cs.color].join("|"),
    outline,
    html: el.outerHTML.slice(0, 300),
    tag: el.tagName.toLowerCase(),
    label: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 60),
  };
})()`;

interface Merged {
  finding: FindingDraft;
  viewports: Set<string>;
}

export const accessibilityScanner: Scanner = {
  key: "accessibility",
  idPrefix: "A11Y",
  version: "1.0.0",
  async run(ctx: ScannerContext) {
    const analyzable = analyzablePages(ctx.pages);
    const maxPages = ctx.limits?.accessibilityMaxPages ?? DEFAULT_ACCESSIBILITY_MAX_PAGES;
    const pages = analyzable.slice(0, maxPages);
    const checks: CheckSummary = { evaluated: 0, inconclusive: [] };
    const merged = new Map<string, Merged>();
    let axeVersion = "unknown";
    let failedRuns = 0;
    /** Viewports per page not analyzed because the step's time budget was used up. */
    const outOfTime = new Map<PageRecord, string[]>();

    const jobs = pages.flatMap((p) => ctx.viewports.map((viewport) => ({ p, viewport })));
    await pool(
      jobs,
      CONCURRENCY,
      async ({ p, viewport }) => {
        if (ctx.limits?.deadline && Date.now() > ctx.limits.deadline) {
          outOfTime.set(p, [...(outOfTime.get(p) ?? []), viewport.name]);
          return;
        }
        {
          let live;
          try {
            live = await ctx.openPage(displayUrl(p), viewport);
            const result = await new AxeBuilder({ page: live.page })
              .withTags([...WCAG_TAGS, "best-practice"])
              .analyze();
            axeVersion = result.testEngine.version;
            checks.evaluated +=
              result.passes.length + result.violations.length + result.incomplete.length;
            const capture = captureFor(p, viewport.name);

            for (const v of result.violations) {
              const best = !v.tags.some((t) => WCAG_TAGS.includes(t));
              const base = IMPACT[v.impact ?? "minor"] ?? "low";
              const severity = best ? LOWER[base] : base;
              const wcag = v.tags.filter((t) => /^wcag\d/.test(t) || /^wcag\d+[a-z]*$/.test(t));
              for (const node of v.nodes.slice(0, MAX_NODES_PER_RULE)) {
                const target = node.target.map(String).join(" ");
                const key = `${v.id}|${p.id}|${target}`;
                const existing = merged.get(key);
                if (existing) {
                  existing.viewports.add(viewport.name);
                  continue;
                }
                merged.set(key, {
                  viewports: new Set([viewport.name]),
                  finding: {
                    ruleId: v.id,
                    title: v.help,
                    message: `${v.description} (axe rule “${v.id}”${best ? ", best practice" : ""}).`,
                    subcategory: best ? "best-practice" : "wcag",
                    pageId: p.id,
                    pageUrl: displayUrl(p),
                    selector: target,
                    viewport: viewport.name,
                    severity,
                    verdict: "confirmed",
                    confidence: 0.95,
                    expected: v.help,
                    actual: truncate(node.failureSummary ?? "", 1000),
                    evidence: [
                      {
                        kind: "axe_node",
                        data: {
                          ruleId: v.id,
                          impact: v.impact ?? null,
                          wcag,
                          helpUrl: v.helpUrl,
                          target,
                          html: truncate(node.html, 600),
                          failureSummary: truncate(node.failureSummary ?? "", 1000),
                        },
                      },
                      ...screenshotEvidence(capture),
                    ],
                  },
                });
              }
              if (v.nodes.length > MAX_NODES_PER_RULE)
                checks.inconclusive.push({
                  check: v.id,
                  reason: `${v.nodes.length - MAX_NODES_PER_RULE} more elements fail this rule; only the first ${MAX_NODES_PER_RULE} are reported`,
                  pageUrl: displayUrl(p),
                });
            }
            for (const inc of result.incomplete) {
              if (checks.inconclusive.length >= 100) break;
              checks.inconclusive.push({
                check: `${inc.id}: ${inc.help}`,
                reason: `axe could not decide automatically for ${inc.nodes.length} element(s) at ${viewport.name}; needs manual review`,
                pageUrl: displayUrl(p),
              });
            }

            // Keyboard: visible focus indicator (WCAG 2.4.7), first viewport only.
            if (viewport === ctx.viewports[0]) {
              for (const f of await focusIndicatorFindings(
                live.page,
                p.id,
                displayUrl(p),
                viewport.name,
              )) {
                merged.set(`${f.ruleId}|${p.id}|${f.selector}`, {
                  finding: f,
                  viewports: new Set([viewport.name]),
                });
              }
            }
          } catch (err) {
            failedRuns += 1;
            checks.inconclusive.push({
              check: "axe-core analysis",
              reason: `Could not analyze at ${viewport.name}: ${truncate((err as Error).message, 200)}`,
              pageUrl: displayUrl(p),
            });
          } finally {
            await live?.close();
          }
        }
      },
      ctx.signal,
    );
    // Pages beyond the limit were not analyzed: say so per page (scan comparisons then never
    // count their earlier accessibility issues as resolved).
    for (const p of analyzable.slice(maxPages))
      checks.inconclusive.push({
        check: "axe-core analysis",
        reason: `Not analyzed: accessibility checks are limited to the first ${maxPages} pages of a scan (SCAN_ACCESSIBILITY_MAX_PAGES)`,
        pageUrl: displayUrl(p),
      });
    for (const [p, viewports] of outOfTime)
      checks.inconclusive.push({
        check: "axe-core analysis",
        reason: `Not analyzed at ${viewports.join(", ")}: the accessibility step's time budget (80% of SCAN_SCANNER_TIMEOUT_MS) was used up`,
        pageUrl: displayUrl(p),
      });

    const findings = [...merged.values()].map(({ finding, viewports }) => {
      const list = [...viewports];
      return {
        ...finding,
        viewport: list.length === 1 ? list[0]! : null,
        evidence: finding.evidence.map((e) =>
          e.kind === "axe_node" ? { ...e, data: { ...e.data, viewports: list } } : e,
        ),
      };
    });
    const total = pages.length * ctx.viewports.length;
    if (pages.length === 0)
      return {
        status: "inconclusive",
        statusReason: "No HTML pages to analyze",
        findings,
        checks,
        toolName: "axe-core",
        toolVersion: axeVersion,
      };
    const skipped = [...outOfTime.values()].reduce((s, v) => s + v.length, 0);
    const analyzed = total - failedRuns - skipped;
    if (analyzed === 0 && skipped > 0)
      return {
        status: "inconclusive",
        statusReason: "The time budget was used up before any page could be analyzed",
        findings,
        checks,
        toolName: "axe-core",
        toolVersion: axeVersion,
      };
    if (analyzed === 0)
      return {
        status: "failed",
        statusReason: "axe-core could not analyze any page",
        findings,
        checks,
        toolName: "axe-core",
        toolVersion: axeVersion,
      };
    const notCovered = [
      skipped ? `${skipped} not analyzed (time budget)` : null,
      analyzable.length > pages.length
        ? `${analyzable.length - pages.length} page(s) beyond the limit of ${maxPages}`
        : null,
    ].filter(Boolean);
    return {
      status: "completed",
      statusReason: `${analyzed} of ${total} page/viewport combinations analyzed (WCAG 2.2 A/AA + best practices)${notCovered.length ? ` (${notCovered.join("; ")})` : ""}; ${findings.length} violation${findings.length === 1 ? "" : "s"}; ${checks.inconclusive.length} check(s) need manual review`,
      findings,
      checks,
      toolName: "axe-core",
      toolVersion: axeVersion,
    };
  },
};

async function focusIndicatorFindings(
  page: Page,
  pageId: string,
  pageUrl: string,
  viewport: string,
): Promise<FindingDraft[]> {
  const baseline = (await page.evaluate(FOCUS_BASELINE_SCRIPT)) as string[];
  if (!baseline.length) return [];
  await page.evaluate(
    "document.activeElement && document.activeElement.blur && document.activeElement.blur()",
  );
  const seen = new Set<number>();
  const missing: Array<{ html: string; tag: string; label: string; idx: number }> = [];
  for (let i = 0; i < baseline.length + 5 && seen.size < baseline.length; i++) {
    await page.keyboard.press("Tab");
    const active = (await page.evaluate(FOCUS_ACTIVE_SCRIPT)) as {
      idx: number;
      style: string;
      outline: boolean;
      html: string;
      tag: string;
      label: string;
    } | null;
    if (!active || seen.has(active.idx)) continue;
    seen.add(active.idx);
    if (!active.outline && active.style === baseline[active.idx]) missing.push(active);
  }
  return missing.slice(0, 10).map((m) => ({
    ruleId: "focus-indicator-visible",
    title: "Keyboard focus is not visible",
    message: `When this ${m.tag} receives keyboard focus, none of its outline, shadow, border, background, underline or text colour changes, so keyboard users cannot see where they are (WCAG 2.4.7).`,
    subcategory: "keyboard",
    pageId,
    pageUrl,
    selector: `${m.tag}${m.label ? ` “${m.label}”` : ` #${m.idx + 1} in tab order`}`,
    viewport,
    severity: "medium" as const,
    verdict: "potential" as const,
    confidence: 0.7,
    expected: "A visible focus indicator when the element is reached with the Tab key",
    actual: "Computed styles identical in focused and unfocused state",
    evidence: [
      {
        kind: "computed_style" as const,
        data: {
          element: truncate(m.html, 300),
          comparedProperties: [
            "outline",
            "box-shadow",
            "border-color",
            "background-color",
            "text-decoration",
            "color",
          ],
          focusedEqualsUnfocused: true,
        },
      },
    ],
  }));
}
