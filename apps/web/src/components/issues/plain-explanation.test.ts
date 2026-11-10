import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  FindingGuide,
  PlainExplanation,
  Reliability,
  RichText,
  type ExplainedOccurrence,
} from "./plain-explanation";

const NAV_ICON =
  '<img loading="lazy" decoding="async" src="https://shop.example.test/image.svg" class="nav__icon-mobile">';

type F = ExplainedOccurrence["findings"][number];
const finding = (over: Partial<F> = {}): F => ({
  displayId: "A11Y-024",
  viewport: "desktop",
  selector: ".nav__icon-mobile",
  pageUrl: "https://shop.example.test/",
  expected: null,
  actual: null,
  evidence: [
    {
      kind: "axe_node",
      data: {
        html: NAV_ICON,
        wcag: ["wcag111"],
        helpUrl: "https://dequeuniversity.com/rules/axe/4.13/image-alt",
      },
    },
  ],
  ...over,
});

const occurrence = (over: Partial<ExplainedOccurrence> = {}): ExplainedOccurrence => ({
  category: "accessibility",
  ruleId: "image-alt",
  severity: "critical",
  severityRationale: "Severity assigned by the scanner rule (critical).",
  affectedUrls: ["https://shop.example.test/", "https://shop.example.test/about"],
  affectedElement: ".nav__icon-mobile",
  expected: null,
  actual: null,
  recommendation: "Add an alt attribute to each listed image.",
  confidence: 0.95,
  verdict: "confirmed",
  groundingStatus: "not_applicable",
  explanation: null,
  findings: [finding(), finding({ displayId: "A11Y-025", viewport: "mobile" }), finding()],
  ...over,
});

const render = (o: ExplainedOccurrence, status = "open") =>
  renderToStaticMarkup(createElement(PlainExplanation, { occurrence: o, status }))
    .replace(/<!-- -->/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'");

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

describe("PlainExplanation", () => {
  it("shows the easy explanation first, built from the occurrence's own evidence", () => {
    const html = render(occurrence());
    for (const card of [
      "In plain language",
      "Where it was found",
      "How to fix it",
      "Example fix",
      "How to verify the fix",
    ])
      expect(html).toContain(`>${card}</h2>`);
    for (const q of ["What is the problem?", "Why does it matter?", "What should I do next?"])
      expect(html).toContain(`>${q}</h3>`);
    const t = text(html);
    expect(t).toContain("has no text alternative");
    expect(t).toContain("nav__icon-mobile");
    expect(t).toContain("2 pages · screen sizes: desktop, mobile");
    expect(t).toContain("3 scanner findings are the evidence");
    expect(html).toContain('href="#evidence"');
    // The recorded HTML is shown as text, never rendered as markup.
    expect(html).not.toContain("<img loading");
    expect(t).toContain(`As recorded by the scanner (finding A11Y-024)`);
    expect(t).toContain(NAV_ICON);
    // Before/after labels and placeholder wording.
    expect(t).toContain("Before — copied from the scan evidence");
    expect(t).toContain('alt="[describe what the image shows or does]"');
    expect(t).toContain("After — suggested change (adapt to your code)");
    expect(html).toContain('aria-label="Copy: After — suggested change (adapt to your code)"');
    // Built-in guidance is labelled as such; the fix is never presented as verified.
    expect(t).toContain("Built-in guidance for this rule");
    expect(t).toContain("A suggested fix is not verified until a later scan");
    expect(t).toContain("Marking it Resolved yourself does not verify the fix");
    expect(t).toContain("What the scan could not tell");
    // The doc link from the evidence is a safe external link.
    expect(html).toMatch(
      /<a href="https:\/\/dequeuniversity\.com\/rules\/axe\/4\.13\/image-alt" target="_blank" rel="noopener noreferrer"/,
    );
  });

  it("uses grounded AI text only when grounding accepted it, and labels it", () => {
    const explanation = {
      problem: "The mobile menu icon has no alternative text.",
      steps: ["Open the header template.", "Add an aria-label to the menu link."],
    };
    const accepted = text(render(occurrence({ groundingStatus: "passed", explanation })));
    expect(accepted).toContain("The mobile menu icon has no alternative text.");
    expect(accepted).toContain("Add an aria-label to the menu link.");
    expect(accepted).toContain(
      "Written by AI from this issue's evidence and checked automatically",
    );
    for (const status of ["rejected", "not_applicable"]) {
      const ignored = text(render(occurrence({ groundingStatus: status, explanation })));
      expect(ignored).not.toContain("The mobile menu icon has no alternative text.");
      expect(ignored).not.toContain("Written by AI");
    }
    // Older AI issues without an explanation still show their grounded AI recommendation.
    const older = text(render(occurrence({ groundingStatus: "partial" })));
    expect(older).toContain("AI suggestion for this issue");
    expect(older).toContain("Add an alt attribute to each listed image.");
  });

  it("explains uncertain verdicts up front and asks for a check before the fix", () => {
    const html = render(occurrence({ verdict: "potential" }));
    expect(html).toMatch(/role="note"[^>]*><span class="font-semibold">Needs review:/);
    expect(text(html)).toContain("First check whether the problem is real");
    expect(render(occurrence())).not.toContain('role="note"');
  });

  it("does not claim a fix was confirmed when a person marked the issue resolved", () => {
    expect(text(render(occurrence(), "resolved"))).toContain("That is not yet a confirmation");
    expect(text(render(occurrence(), "reopened"))).toContain("found this issue again");
    expect(text(render(occurrence(), "open"))).not.toContain("not yet a confirmation");
  });

  it("omits the example card without a grounded example and handles site-wide issues", () => {
    const html = render(
      occurrence({
        category: "performance",
        ruleId: "tbt-slow",
        affectedUrls: [],
        affectedElement: null,
        findings: [finding({ selector: null, evidence: [] })],
      }),
    );
    expect(html).not.toContain(">Example fix</h2>");
    expect(text(html)).toContain("The whole site");
    expect(text(html)).toContain("lab measurements from one scan");
    const many = Array.from({ length: 8 }, (_, i) => `https://shop.example.test/p${i}`);
    expect(text(render(occurrence({ affectedUrls: many })))).toContain("and 3 more");
  });

  it("escapes hostile evidence and links only http(s) addresses", () => {
    const hostile = '<img src=x onerror="alert(1)">';
    const html = render(
      occurrence({
        findings: [finding({ evidence: [{ kind: "axe_node", data: { html: hostile } }] })],
      }),
    );
    expect(html).not.toContain(hostile);
    expect(html).toContain("&lt;img src=x onerror=");
    const rich = renderToStaticMarkup(
      createElement(RichText, { text: "See javascript:alert(1) and `a.b` at https://x.test/y." }),
    );
    expect(rich).not.toContain('href="javascript');
    expect(rich).toContain('<a href="https://x.test/y"');
    expect(rich).toContain(">a.b</code>");
  });

  it("explains reliability in the technical section", () => {
    const html = renderToStaticMarkup(
      createElement(Reliability, { verdict: "confirmed", confidence: 0.95 }),
    );
    expect(html).toContain("Confidence 95%.");
    expect(html).toContain("Confirmed.");
  });
});

describe("FindingGuide (scan findings page)", () => {
  // The finding from the user's report (A11Y-024 on a WordPress site, mobile viewport).
  const html =
    '<img loading="lazy" decoding="async" src="https://ascendion.us/wp-content/uploads/2026/07/Frame-3.svg" class="nav__icon-mobile">';
  const f = {
    displayId: "A11Y-024",
    scanner: "accessibility",
    ruleId: "image-alt",
    verdict: "confirmed",
    viewport: "mobile",
    selector: ".nav__icon-mobile",
    pageUrl:
      "https://ascendion.com/ideas-and-insights/trust-is-banking-and-financial-services-most-valuable-asset/",
    expected: "Images must have alternative text",
    actual: "Fix any of the following: Element does not have an alt attribute",
    evidence: [
      {
        kind: "axe_node",
        data: {
          html,
          wcag: ["wcag2a", "wcag111"],
          impact: "critical",
          helpUrl: "https://dequeuniversity.com/rules/axe/4.13/image-alt?application=playwright",
          failureSummary: "Fix any of the following:\n  Element does not have an alt attribute",
        },
      },
    ],
  };

  it("explains the finding in plain language with a grounded fix and verification", () => {
    const out = renderToStaticMarkup(
      createElement(FindingGuide, {
        finding: f,
        issueHref: "/projects/p/issues/7?scan=s",
        issueLabel: "ISSUE-7",
      }),
    );
    const t = text(out.replace(/<!-- -->/g, "").replace(/&quot;/g, '"'));
    expect(t).toContain("What is the problem?");
    expect(t).toContain("has no text alternative");
    expect(t).toContain("suggests an icon, logo or navigation control");
    expect(t).toContain("Why does it matter?");
    expect(t).toContain("What should I do next?");
    expect(t).toContain("at the mobile screen size");
    expect(t).toContain("WordPress: set the “Alternative Text” field");
    expect(t).toContain(html);
    expect(t).toContain('class="nav__icon-mobile" alt="[describe what the image shows or does]"');
    expect(t).toContain('alt="[what the link does, e.g. Open menu]"');
    expect(t).toContain("How to verify the fix");
    expect(t).toContain("Marking it Resolved yourself does not verify the fix");
    expect(t).toContain("Open ISSUE-7 for its status, history and related findings");
    expect(out).not.toContain("<img loading");
  });
});
