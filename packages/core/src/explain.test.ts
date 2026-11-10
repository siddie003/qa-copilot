import { describe, expect, it } from "vitest";
import { FINDING_SOURCES, SEVERITIES } from "./domain";
import { explainIssue, SEVERITY_MEANINGS, SOURCE_DESCRIPTIONS, VERDICT_MEANINGS } from "./explain";

describe("plain-language explanations", () => {
  it("explains a known rule with its manual check followed by the re-scan step", () => {
    const e = explainIssue("accessibility", "image-alt");
    expect(e.specific).toBe(true);
    expect(e.meaning).toMatch(/no text alternative/);
    expect(e.impact).toMatch(/screen readers/);
    expect(e.verify).toMatch(/^Inspect each listed image/);
    expect(e.verify).toMatch(/Then run a new scan of the same pages/);
    // Without a manual check the re-scan step stands on its own.
    expect(explainIssue("content", "content-changed-wording").verify).toMatch(/^Run a new scan/);
  });

  it("falls back to the category wording for rules without a specific entry", () => {
    const e = explainIssue("accessibility", "some-future-axe-rule");
    expect(e.specific).toBe(false);
    expect(e.meaning).toMatch(/accessibility rule/);
    expect(explainIssue("seo", null).specific).toBe(false);
    // Prototype keys are not rules.
    expect(explainIssue("seo", "constructor").specific).toBe(false);
    expect(explainIssue("seo", "toString").meaning).toMatch(/search engines/);
  });

  it("has general wording for unknown categories and category-specific re-scan advice", () => {
    expect(explainIssue("unknown", "x").meaning).toMatch(/findings below/);
    expect(explainIssue("design", "design-color-mismatch").verify).toMatch(/design reference/);
    expect(explainIssue("content", "content-missing").verify).toMatch(/approved content/);
    expect(explainIssue("performance", "lcp-slow").verify).toMatch(/vary from run to run/);
  });

  it("treats every exposed-secret rule alike and never claims the key is real", () => {
    const e = explainIssue("security", "exposed-secret-github-token");
    expect(e.specific).toBe(true);
    expect(e.impact).toMatch(/If it is a real credential/);
  });

  it("contains no issue-specific facts (numbers, URLs or selectors) in rule wording", () => {
    for (const category of FINDING_SOURCES) {
      const e = explainIssue(category, null);
      for (const text of [e.meaning, e.impact, e.verify]) {
        expect(text).not.toMatch(/https?:\/\//);
        expect(text).not.toMatch(/\d/);
      }
    }
  });

  it("describes every severity, verdict and finding source", () => {
    for (const s of SEVERITIES) expect(SEVERITY_MEANINGS[s]).toBeTruthy();
    for (const v of ["confirmed", "potential", "inconclusive", "unable_to_verify"])
      expect(VERDICT_MEANINGS[v]?.meaning).toBeTruthy();
    for (const k of FINDING_SOURCES) expect(SOURCE_DESCRIPTIONS[k]).toBeTruthy();
  });
});
