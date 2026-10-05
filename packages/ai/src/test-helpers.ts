import type { AiIssue } from "./schema";
import type { ScanFinding } from "./types";

/** Test data only (imported by *.test.ts files). */

let seq = 0;

export function finding(p: Partial<ScanFinding> & Pick<ScanFinding, "displayId">): ScanFinding {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    scanner: "seo",
    ruleId: "rule",
    subcategory: null,
    title: "Title",
    message: "Message",
    severity: "medium",
    verdict: "confirmed",
    confidence: 0.95,
    selector: null,
    viewport: null,
    expected: null,
    actual: null,
    fingerprint: `fp-${p.displayId}`,
    pageUrl: null,
    evidence: [{ kind: "document", data: { note: "evidence" } }],
    ...p,
  };
}

const SITE = "http://localhost:4100";

/** Findings shaped like the real scanners' output on the fixture site. */
export function scanFindings(): ScanFinding[] {
  return [
    finding({
      displayId: "SEO-001",
      scanner: "seo",
      ruleId: "meta-description-missing",
      subcategory: "on-page",
      title: "Meta description is missing",
      message: "Without a meta description, search engines choose a snippet themselves.",
      expected: '<meta name="description"> with 50–160 characters',
      actual: "No meta description",
      pageUrl: `${SITE}/about`,
      evidence: [{ kind: "document", data: { url: `${SITE}/about`, description: null } }],
    }),
    finding({
      displayId: "SEO-002",
      scanner: "seo",
      ruleId: "meta-description-missing",
      subcategory: "on-page",
      title: "Meta description is missing",
      message: "Without a meta description, search engines choose a snippet themselves.",
      expected: '<meta name="description"> with 50–160 characters',
      actual: "No meta description",
      pageUrl: `${SITE}/contact`,
      evidence: [{ kind: "document", data: { url: `${SITE}/contact`, description: null } }],
    }),
    finding({
      displayId: "SEO-003",
      scanner: "seo",
      ruleId: "title-duplicate",
      subcategory: "duplicates",
      title: "Duplicate title on 2 pages",
      message: "2 crawled pages share the same title, so search engines cannot tell them apart.",
      expected: "A unique title per page",
      actual: "“Acme Widgets” on 2 pages",
      pageUrl: null,
      evidence: [
        {
          kind: "document",
          data: { value: "Acme Widgets", pages: [`${SITE}/`, `${SITE}/products`] },
        },
      ],
    }),
    finding({
      displayId: "A11Y-001",
      scanner: "accessibility",
      ruleId: "color-contrast",
      subcategory: "wcag",
      title: "Elements must meet minimum color contrast ratio thresholds",
      message: "Ensures the contrast between foreground and background colors meets WCAG 2 AA.",
      severity: "high",
      selector: "p.muted",
      viewport: "desktop",
      expected: "Elements must meet minimum color contrast ratio thresholds",
      actual:
        "Element has insufficient color contrast of 1.66 (foreground color: #c4c4c4, background color: #ffffff, font size: 12.0pt (16px), font weight: normal). Expected contrast ratio of 4.5:1",
      pageUrl: `${SITE}/products`,
      evidence: [
        {
          kind: "axe_node",
          data: {
            ruleId: "color-contrast",
            impact: "serious",
            wcag: ["wcag2aa", "wcag143"],
            helpUrl: "https://dequeuniversity.com/rules/axe/4.13/color-contrast",
            target: "p.muted",
            html: '<p class="muted">Prices include VAT.</p>',
            failureSummary: "Fix any of the following: Element has insufficient color contrast",
          },
        },
        { kind: "screenshot", data: { viewport: "desktop", width: 1440, height: 900 } },
      ],
    }),
    finding({
      displayId: "A11Y-002",
      scanner: "accessibility",
      ruleId: "color-contrast",
      subcategory: "wcag",
      title: "Elements must meet minimum color contrast ratio thresholds",
      message: "Ensures the contrast between foreground and background colors meets WCAG 2 AA.",
      severity: "high",
      selector: "span.note",
      viewport: "desktop",
      expected: "Elements must meet minimum color contrast ratio thresholds",
      actual: "Element has insufficient color contrast of 2.1",
      pageUrl: `${SITE}/products`,
      evidence: [
        {
          kind: "axe_node",
          data: {
            ruleId: "color-contrast",
            wcag: ["wcag2aa", "wcag143"],
            helpUrl: "https://dequeuniversity.com/rules/axe/4.13/color-contrast",
            target: "span.note",
          },
        },
      ],
    }),
    finding({
      displayId: "PERF-001",
      scanner: "performance",
      ruleId: "lcp-slow",
      subcategory: "web-vitals",
      title: "Largest Contentful Paint is poor",
      message:
        "Largest Contentful Paint measured 4232 ms at mobile (good: ≤ 2500 ms, poor: > 4000 ms).",
      severity: "high",
      viewport: "mobile",
      expected: "≤ 2500 ms",
      actual: "4232 ms",
      pageUrl: `${SITE}/slow`,
      evidence: [
        {
          kind: "measurement",
          data: {
            metric: "lcp",
            values: { desktop: 3900.4, mobile: 4231.6 },
            thresholds: { good: 2500, poor: 4000 },
          },
        },
      ],
    }),
    finding({
      displayId: "DSN-001",
      scanner: "design",
      ruleId: "design-font-size-mismatch",
      subcategory: "typography",
      title: "Heading 1 font size: 40px instead of 48px",
      message:
        "Heading 1 font size differs from the design reference on 1 page (desktop): expected 48px (entered manually), found 40px.",
      selector: "h1",
      expected: "48px",
      actual: "40px",
      fingerprint: "fp-dsn-h1-size",
      pageUrl: `${SITE}/`,
      evidence: [
        {
          kind: "design_token",
          data: {
            token: "typography.h1.fontSize",
            expected: "48px",
            source: "entered manually",
          },
        },
        {
          kind: "computed_style",
          data: {
            property: "fontSize",
            observations: [{ page: `${SITE}/`, viewport: "desktop", actual: "40px" }],
          },
        },
      ],
    }),
    finding({
      displayId: "RSP-001",
      scanner: "responsive",
      ruleId: "tap-target-small",
      subcategory: "touch",
      title: "Touch target is smaller than 24×24 px",
      message: "a.tiny is 16×16px at mobile; WCAG 2.5.8 asks for at least 24×24 CSS px.",
      severity: "medium",
      verdict: "potential",
      confidence: 0.7,
      selector: "a.tiny",
      viewport: "mobile",
      expected: "≥ 24×24 CSS px (44×44 recommended)",
      actual: "16×16px",
      pageUrl: `${SITE}/contact`,
      evidence: [{ kind: "measurement", data: { selector: "a.tiny", width: 16, height: 16 } }],
    }),
  ];
}

/** An AI issue that is fully supported by the A11Y color-contrast group's evidence. */
export function groundedContrastIssue(groupId: string): AiIssue {
  return {
    groupId,
    sourceFindingIds: ["A11Y-001", "A11Y-002"],
    title: "Low-contrast text on the products page",
    description:
      "Two text elements on http://localhost:4100/products have too little contrast: p.muted uses #c4c4c4 on #ffffff (contrast 1.66). Users with low vision may not be able to read them.",
    severity: "high",
    severityRationale: "Text that cannot be read blocks users with low vision.",
    affectedElement: null,
    expected: "Expected contrast ratio of 4.5:1",
    actual: null,
    recommendation:
      "Darken the text color of p.muted and span.note until they meet WCAG 1.4.3; see https://dequeuniversity.com/rules/axe/4.13/color-contrast.",
    claims: [
      { text: "p.muted has a contrast of 1.66", findingId: "A11Y-001", evidenceField: "actual" },
      { text: "The rule is color-contrast", findingId: "A11Y-002", evidenceField: "evidence" },
    ],
  };
}
