import { describe, expect, it } from "vitest";
import {
  buildReportData,
  mdCode,
  mdText,
  renderHtml,
  renderJson,
  renderMarkdown,
  type ReportSource,
} from "./index";

const INJECT = `<script>alert(1)</script> [click](javascript:alert(1)) ![x](http://evil.test/x.png)`;

function evidence(kind: string, data: Record<string, unknown>, storageKey: string | null = null) {
  return { kind, data, storageKey };
}

function source(): ReportSource {
  const finding = (
    id: string,
    displayId: string,
    over: Partial<ReportSource["findings"][number]> = {},
  ): ReportSource["findings"][number] => ({
    id,
    displayId,
    scanner: "seo",
    ruleId: "title-missing",
    title: "Page has no title",
    message: "The page has no <title> element.",
    severity: "medium",
    verdict: "confirmed",
    confidence: 0.95,
    pageUrl: "http://localhost:4100/about",
    selector: "head",
    viewport: null,
    expected: null,
    actual: null,
    evidence: [evidence("document", { title: null })],
    ...over,
  });
  return {
    project: { id: "p1", name: "Demo `site` | *bold*", websiteUrl: "http://localhost:4100" },
    scan: {
      id: "s1",
      number: 3,
      status: "completed_with_failures",
      createdAt: new Date("2026-10-05T10:00:00Z"),
      startedAt: new Date("2026-10-05T10:00:05Z"),
      finishedAt: new Date("2026-10-05T10:02:10Z"),
      error: null,
      configSnapshot: {
        websiteUrl: "http://localhost:4100",
        scanners: ["accessibility", "seo"],
        viewports: [{ name: "desktop", width: 1440, height: 900 }],
        maxPages: 25,
        maxDepth: 3,
        respectRobots: true,
        authType: null,
        designSpecVersion: 2,
        contentDocuments: [{ filename: "approved.md" }],
      },
      technology: {
        detected: [
          { name: "Express", category: "framework" },
          { name: "nginx", category: "server" },
        ],
      },
    },
    pageCount: 19,
    steps: [
      {
        stepKey: "seo",
        status: "completed",
        statusReason: null,
        error: null,
        findingCount: 3,
        durationMs: 1200,
        toolName: "QA Copilot SEO",
        toolVersion: "1",
        checks: {
          evaluated: 40,
          inconclusive: [{ check: "sitemap", reason: "HTTP 403", pageUrl: null }],
          inconclusiveTotal: 1,
          notes: [],
        },
      },
      {
        stepKey: "performance",
        status: "failed",
        statusReason: null,
        error: "Timed out after 120 s",
        findingCount: 0,
        durationMs: 120000,
        toolName: null,
        toolVersion: null,
        checks: null,
      },
      {
        stepKey: "links",
        status: "inconclusive",
        statusReason: "3/10 links blocked (HTTP 429)",
        error: null,
        findingCount: 0,
        durationMs: 800,
        toolName: null,
        toolVersion: null,
        checks: null,
      },
      {
        stepKey: "design",
        status: "completed",
        statusReason: null,
        error: null,
        findingCount: 1,
        durationMs: 30,
        toolName: null,
        toolVersion: null,
        checks: {
          evaluated: 5,
          inconclusive: [],
          comparison: {
            matched: 2,
            confirmedMismatch: 1,
            potentialMismatch: 1,
            unableToVerify: 1,
            items: [],
          },
        },
      },
      {
        stepKey: "ai",
        status: "skipped",
        statusReason: "No AI provider configured",
        error: null,
        findingCount: 0,
        durationMs: null,
        toolName: null,
        toolVersion: null,
        checks: null,
      },
    ],
    issues: [
      {
        trackId: "t2",
        displayNo: 2,
        trackStatus: "in_progress",
        category: "seo",
        subcategory: null,
        ruleId: "title-missing",
        severity: "medium",
        severityRationale: "Severity assigned by the scanner rule (medium).",
        title: `Missing title ${INJECT}`,
        description: "# Not a heading\n- not a list\nSecond line",
        affectedUrls: ["http://localhost:4100/about", "http://localhost:4100/a`b"],
        affectedElement: "head",
        expected: null,
        actual: null,
        recommendation: "Add a <title>.",
        confidence: 0.95,
        verdict: "confirmed",
        origin: "deterministic",
        groundingStatus: "not_applicable",
        checks: [],
        findingIds: ["f2", "f1"],
      },
      {
        trackId: "t1",
        displayNo: 1,
        trackStatus: "inconclusive",
        category: "design",
        subcategory: null,
        ruleId: "design-color",
        severity: "high",
        severityRationale: null,
        title: "Primary button color differs",
        description: "Unable to verify from available evidence. The button could not be mapped.",
        affectedUrls: [],
        affectedElement: null,
        expected: "#1a56db",
        actual: "#1a56dc",
        recommendation: null,
        confidence: 0.5,
        verdict: "inconclusive",
        origin: "ai",
        groundingStatus: "partial",
        checks: [{ checkType: "field:title", passed: false, detail: { unsupported: ["#ff0000"] } }],
        findingIds: ["f3"],
      },
    ],
    findings: [
      finding("f1", "SEO-001"),
      finding("f2", "SEO-002", { pageUrl: "http://localhost:4100/a`b", title: INJECT }),
      finding("f3", "DESIGN-001", {
        scanner: "design",
        ruleId: "design-color",
        severity: "high",
        verdict: "inconclusive",
        pageUrl: null,
        expected: "#1a56db",
        actual: "#1a56dc",
        evidence: [evidence("screenshot", { viewport: "desktop" }, "scans/s1/x.png")],
      }),
      finding("f4", "SEO-010", { severity: "low", verdict: "potential" }),
    ],
    aiRuns: [
      {
        provider: "anthropic",
        model: "claude-opus-5-5",
        status: "completed",
        inputTokens: 10,
        outputTokens: 5,
      },
      {
        provider: "anthropic",
        model: "claude-opus-5-5",
        status: "failed",
        inputTokens: null,
        outputTokens: null,
      },
    ],
  };
}

const opts = {
  generatedAt: new Date("2026-10-05T12:00:00Z"),
  generator: { name: "QA Copilot", version: "0.1.0" },
};

describe("buildReportData", () => {
  const d = buildReportData(source(), opts);

  it("is versioned and deterministic", () => {
    expect(d.format).toBe("qa-copilot-report");
    expect(d.schemaVersion).toBe(1);
    expect(buildReportData(source(), opts)).toEqual(d);
  });

  it("orders issues by severity, then tracking number, with findings by id", () => {
    expect(d.issues.map((i) => i.id)).toEqual(["ISSUE-1", "ISSUE-2"]);
    expect(d.issues[1]!.findings.map((f) => f.id)).toEqual(["SEO-001", "SEO-002"]);
  });

  it("keeps verdicts, statuses and text origin from the stored rows", () => {
    expect(d.issues[0]).toMatchObject({
      status: "inconclusive",
      verdict: "inconclusive",
      textOrigin: "ai",
      grounding: "partial",
      categoryLabel: "Design comparison",
    });
    expect(d.issues[1]).toMatchObject({ status: "in_progress", categoryLabel: "SEO" });
  });

  it("counts issues and findings from the data only", () => {
    expect(d.summary.issues).toMatchObject({
      total: 2,
      outstanding: 1,
      bySeverity: { critical: 0, high: 1, medium: 1, low: 0, info: 0 },
      byStatus: { in_progress: 1, inconclusive: 1 },
      byVerdict: { confirmed: 1, inconclusive: 1 },
      byCategory: { seo: 1, design: 1 },
    });
    expect(d.summary.findings).toEqual({
      total: 4,
      byVerdict: { confirmed: 2, inconclusive: 1, potential: 1 },
      notInAnyIssue: 1,
    });
    expect(d.unassignedFindings.map((f) => f.id)).toEqual(["SEO-010"]);
  });

  it("reports failed, inconclusive and skipped steps with their reasons", () => {
    expect(d.summary.steps).toEqual({
      failed: ["performance"],
      inconclusive: ["links"],
      skipped: ["ai"],
    });
    const perf = d.steps.find((s) => s.key === "performance")!;
    expect(perf).toMatchObject({ label: "Performance", error: "Timed out after 120 s" });
    expect(d.steps.find((s) => s.key === "seo")).toMatchObject({
      evaluated: 40,
      inconclusiveTotal: 1,
      inconclusiveChecks: [{ check: "sitemap", reason: "HTTP 403", pageUrl: null }],
      tool: "QA Copilot SEO 1",
    });
    expect(d.steps.find((s) => s.key === "design")!.comparison).toEqual({
      matched: 2,
      confirmedMismatch: 1,
      potentialMismatch: 1,
      unableToVerify: 1,
    });
  });

  it("summarizes scan settings and AI usage", () => {
    expect(d.scan).toMatchObject({
      number: 3,
      statusLabel: "Completed with failures",
      durationMs: 125_000,
      pagesCrawled: 19,
      designReferenceVersion: 2,
      contentDocuments: ["approved.md"],
      technology: "Express; server: nginx",
    });
    expect(d.summary.ai).toEqual({
      used: true,
      requests: 2,
      failedRequests: 1,
      models: ["anthropic/claude-opus-5-5"],
      issuesWithAiText: 1,
      groundingOutcomes: { partial: 1, not_applicable: 1 },
    });
  });

  it("references stored files without embedding them", () => {
    const ev = d.issues[0]!.findings[0]!.evidence[0]!;
    expect(ev).toEqual({ kind: "screenshot", data: { viewport: "desktop" }, hasStoredFile: true });
    expect(renderJson(d)).not.toContain("scans/s1/x.png");
  });
});

describe("Markdown report", () => {
  const md = renderMarkdown(buildReportData(source(), opts));

  it("escapes website text so it cannot inject markup, links or images", () => {
    expect(mdText(INJECT)).toBe(
      "&lt;script&gt;alert\\(1\\)&lt;/script&gt; \\[click\\]\\(javascript:alert\\(1\\)\\) \\!\\[x\\]\\(http://evil.test/x.png\\)",
    );
    expect(md).not.toContain("<script>");
    expect(md).not.toMatch(/(?<!\\)\[click(?<!\\)\]\(/);
    expect(md).not.toMatch(/(?<!\\)!\[x/);
    // A description line cannot become a heading or a list item.
    expect(md).toContain("\\# Not a heading  \n\\- not a list  \nSecond line");
    expect(md).toContain("# QA report: Demo \\`site\\` \\| \\*bold\\* · Scan #3");
  });

  it("uses code spans that survive backticks", () => {
    expect(mdCode("a`b")).toBe("``a`b``");
    expect(mdCode("`x")).toBe("`` `x ``");
    expect(md).toContain("``http://localhost:4100/a`b``");
  });

  it("lists every issue, its findings and evidence-based states", () => {
    expect(md).toContain("### ISSUE-1: Primary button color differs");
    expect(md).toContain("### ISSUE-2: Missing title");
    expect(md).toContain(
      "Unable to verify from available evidence. Review manually before acting.",
    );
    expect(md).toMatch(
      /`SEO-001` Page has no title · Confirmed · page `http:\/\/localhost:4100\/about`/,
    );
    expect(md).toContain("| Status | In progress |");
    expect(md).toContain("| Text | AI text, unsupported parts replaced with scanner wording |");
    expect(md).toContain("## Findings not grouped into issues (1)");
  });

  it("shows failed and inconclusive steps and inconclusive checks", () => {
    expect(md).toContain(
      "| Performance | **Failed** | 0 | 2 min 0 s | Error: Timed out after 120 s |",
    );
    expect(md).toContain("| Broken links / mixed content | Inconclusive |");
    expect(md).toContain("## Inconclusive checks");
    expect(md).toContain("- sitemap: HTTP 403");
    expect(md).toContain("matched 2, mismatched 1, needs review 1, unable to verify 1");
    expect(md).toContain("| Failed steps | Performance |");
  });
});

describe("HTML (PDF) report", () => {
  const html = renderHtml(buildReportData(source(), opts));

  it("escapes all scanned content and loads nothing external", () => {
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toMatch(/<(img|link|iframe|object|embed)\b/i);
    expect(html).not.toMatch(/\b(src|href)=/i);
    expect(html).not.toMatch(/url\(/i);
    expect(html).toContain("Demo `site` | *bold*");
  });

  it("contains the summary, steps and every issue", () => {
    expect(html).toContain("<b>2</b><span>Issues</span>");
    expect(html).toContain('<td class="nowrap failed">Failed</td>');
    expect(html).toContain('<td class="nowrap inconclusive">Inconclusive</td>');
    expect(html).toContain("ISSUE-1");
    expect(html).toContain("ISSUE-2");
    expect(html).toContain("Unable to verify from available evidence.");
    expect(html).toContain("# Not a heading<br>- not a list<br>Second line");
  });
});

describe("empty scans", () => {
  it("states that there were no findings instead of an empty list", () => {
    const src = { ...source(), issues: [], findings: [], aiRuns: [] };
    const d = buildReportData(src, opts);
    expect(renderMarkdown(d)).toContain(
      "No issues: the scanners reported no findings in this scan.",
    );
    expect(d.summary.ai.used).toBe(false);
    expect(renderMarkdown(d)).toContain("Not used: issue text is the scanners' own wording");
  });
});

describe("finding values in Markdown and PDF", () => {
  it("does not repeat the issue's expected/actual values and clips very long ones", () => {
    const src = source();
    const long = `contrast ${"x".repeat(400)} END`;
    src.findings[1] = { ...src.findings[1]!, actual: long };
    const d = buildReportData(src, opts);
    const md = renderMarkdown(d);
    const html = renderHtml(d);
    // DESIGN-001 has the same expected/actual as ISSUE-1, so only the issue shows them.
    expect(md.match(/#1a56dc/g)).toHaveLength(1);
    expect(html.match(/#1a56dc/g)).toHaveLength(1);
    // The long value is clipped for reading; the JSON report keeps it whole.
    expect(md).toContain(`actual: contrast ${"x".repeat(100)}`);
    expect(md).not.toContain(" END");
    expect(md).toContain("…");
    expect(html).not.toContain(" END");
    expect(renderJson(d)).toContain(long);
  });
});
