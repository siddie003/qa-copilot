import { describe, expect, it } from "vitest";
import { UNABLE_TO_VERIFY } from "./deterministic";
import { groundAiIssue } from "./grounding";
import { interpretGroups, planBatches, type BatchResult } from "./interpret";
import { buildIssueDrafts, prepareGroups } from "./issues";
import type { PreparedGroup } from "./prompt";
import {
  AIProviderError,
  NO_USAGE,
  type AIProvider,
  type StructuredRequest,
} from "./providers/types";
import type { AiBatch, AiIssue } from "./schema";
import { finding, groundedContrastIssue, scanFindings } from "./test-helpers";

const prepared = () => prepareGroups(scanFindings());
const scanIds = (p: PreparedGroup[]) =>
  new Set(p.flatMap((g) => g.group.findings.map((f) => f.displayId)));
const contrastOf = (p: PreparedGroup[]) => p.find((g) => g.group.ruleId === "color-contrast")!;
const check = (r: ReturnType<typeof groundAiIssue>, type: string) =>
  r.checks.filter((c) => c.checkType === type);

function ground(mutate: (i: AiIssue) => void = () => {}, p = prepared()) {
  const group = contrastOf(p);
  const ai = groundedContrastIssue(group.group.id);
  mutate(ai);
  return { result: groundAiIssue(ai, { prepared: group, scanFindingIds: scanIds(p) }), group };
}

describe("grounding: accepted AI text", () => {
  it("passes an issue whose every value, URL, quote and claim is in the evidence", () => {
    const { result } = ground();
    expect(result.origin).toBe("ai");
    expect(result.status).toBe("passed");
    expect(result.checks.every((c) => c.passed)).toBe(true);
    expect(result.fields.title).toBe("Low-contrast text on the products page");
    expect(result.fields.expected).toBe("Expected contrast ratio of 4.5:1");
    // Affected URLs and actual values the AI left out come from the findings, never from AI.
    expect(result.fields.affectedUrls).toEqual(["http://localhost:4100/products"]);
    expect(check(result, "claim")).toHaveLength(2);
  });

  it("accepts a severity one level lower and a selector that matches a finding", () => {
    const { result } = ground((i) => {
      i.severity = "medium";
      i.affectedElement = "p.muted";
    });
    expect(result.status).toBe("passed");
    expect(result.fields).toMatchObject({ severity: "medium", affectedElement: "p.muted" });
  });
});

describe("grounding: fabricated finding ids reject the AI text", () => {
  it("rejects an issue citing a finding that does not exist", () => {
    const { result, group } = ground((i) => (i.sourceFindingIds = ["A11Y-001", "A11Y-999"]));
    expect(result).toMatchObject({ origin: "deterministic", status: "rejected" });
    expect(result.fields).toEqual(group.deterministic);
    expect(check(result, "source_findings")[0]).toMatchObject({
      passed: false,
      detail: { unknown: ["A11Y-999"] },
    });
  });

  it("rejects an issue citing another issue's finding", () => {
    const { result } = ground((i) => (i.sourceFindingIds = ["A11Y-001", "SEO-001"]));
    expect(result.status).toBe("rejected");
    expect(check(result, "source_findings")[0]!.detail).toMatchObject({ otherIssue: ["SEO-001"] });
  });

  it("rejects an issue that cites no findings", () => {
    const { result } = ground((i) => (i.sourceFindingIds = []));
    expect(result.status).toBe("rejected");
  });

  it("rejects a finding cited without evidence", () => {
    const p = prepared();
    contrastOf(p).group.findings[1]!.evidence = [];
    const { result } = ground(undefined, p);
    expect(check(result, "source_findings")[0]!.detail).toMatchObject({
      withoutEvidence: ["A11Y-002"],
    });
  });
});

describe("grounding: unsupported values replace the field with the scanner's wording", () => {
  const cases: Array<[string, (i: AiIssue) => void, string, string]> = [
    [
      "a fabricated URL",
      (i) => (i.description += " Details: https://contrast-fixer.example/report"),
      "field:description",
      "https://contrast-fixer.example/report",
    ],
    [
      "a fabricated color",
      (i) => (i.recommendation = "Change the text color of p.muted to #333333."),
      "field:recommendation",
      "#333333",
    ],
    [
      "a fabricated measurement",
      (i) => (i.title = "Contrast of 1.2 on 3 pages"),
      "field:title",
      "1.2",
    ],
    [
      "a fabricated quotation",
      (i) => (i.description = "The text “Sale ends today” is hard to read."),
      "field:description",
      "“Sale ends today”",
    ],
    [
      "a fabricated finding id in the text",
      (i) => (i.recommendation += " Same as A11Y-077."),
      "field:recommendation",
      "A11Y-077",
    ],
    [
      "a fabricated page path",
      (i) => (i.description = "Also affects /checkout."),
      "field:description",
      "/checkout",
    ],
  ];
  for (const [label, mutate, type, token] of cases)
    it(`replaces a field containing ${label}`, () => {
      const { result, group } = ground(mutate);
      expect(result).toMatchObject({ origin: "ai", status: "partial" });
      const c = check(result, type)[0]!;
      expect(c).toMatchObject({ passed: false, detail: { replacedWith: "scanner wording" } });
      expect(c.detail.unsupported).toContain(token);
      const field = type.split(":")[1] as "title" | "description" | "recommendation";
      expect(result.fields[field]).toBe(group.deterministic[field]);
      expect(JSON.stringify(result.fields)).not.toContain(token);
    });

  it("replaces over-long and empty fields", () => {
    const { result } = ground((i) => {
      i.title = "x".repeat(161);
      i.recommendation = "  ";
    });
    expect(check(result, "field:title")[0]!.detail).toMatchObject({
      reason: "longer than 160 characters",
    });
    expect(check(result, "field:recommendation")[0]!.detail).toMatchObject({ reason: "empty" });
  });

  it("rejects the issue when title, description and recommendation are all unsupported", () => {
    const { result, group } = ground((i) => {
      i.title = "Contrast 0.5";
      i.description = "See https://x.example";
      i.recommendation = "Use #010203";
    });
    expect(result).toMatchObject({ origin: "deterministic", status: "rejected" });
    expect(result.fields).toEqual(group.deterministic);
  });
});

describe("grounding: severity, element and claims", () => {
  it("keeps severity within one level and never raises unconfirmed findings", () => {
    const { result } = ground((i) => (i.severity = "low"));
    expect(result.fields.severity).toBe("high");
    expect(check(result, "severity")[0]).toMatchObject({
      passed: false,
      detail: { allowed: ["critical", "high", "medium"], replacedWith: "high" },
    });
    // The rationale for a rejected severity is not used either.
    expect(check(result, "field:severityRationale")).toHaveLength(0);
    expect(result.fields.severityRationale).toMatch(/Highest severity assigned by the scanner/);

    const p = prepared();
    const tap = p.find((g) => g.group.ruleId === "tap-target-small")!;
    const raised = groundAiIssue(
      {
        ...groundedContrastIssue(tap.group.id),
        sourceFindingIds: ["RSP-001"],
        severity: "high",
        claims: [],
      },
      { prepared: tap, scanFindingIds: scanIds(p) },
    );
    expect(raised.fields.severity).toBe("medium");
  });

  it("replaces an affected element that is not one of the findings' elements", () => {
    const { result } = ground((i) => (i.affectedElement = "div.hero"));
    expect(result.fields.affectedElement).toBeNull();
    expect(check(result, "affected_element")[0]!.passed).toBe(false);
  });

  it("checks each claim against the field of the finding it cites", () => {
    const { result } = ground((i) => {
      i.claims = [
        { text: "p.muted has a contrast of 1.66", findingId: "A11Y-001", evidenceField: "actual" },
        { text: "p.muted has a contrast of 1.2", findingId: "A11Y-001", evidenceField: "actual" },
        { text: "The meta description is missing", findingId: "SEO-001", evidenceField: "title" },
        { text: "Contrast is low", findingId: "A11Y-404", evidenceField: "message" },
        { text: "It is on the page", findingId: "A11Y-002", evidenceField: "pageUrl" },
        {
          text: "Unrelated statement about kittens",
          findingId: "A11Y-001",
          evidenceField: "message",
        },
      ];
    });
    const claims = check(result, "claim");
    expect(claims.map((c) => c.passed)).toEqual([true, false, false, false, false, false]);
    expect(claims.map((c) => c.detail.reason ?? null)).toEqual([
      null,
      null,
      "cites a finding of another issue",
      "cites a finding that does not exist",
      "nothing in the claim appears in the cited field",
      "nothing in the claim appears in the cited field",
    ]);
    expect(claims[1]!.detail.unsupported).toEqual(["1.2"]);
    expect(result.status).toBe("partial");
  });

  it("enforces the unable-to-verify wording for inconclusive issues", () => {
    const p = prepareGroups([
      finding({
        displayId: "SEO-050",
        verdict: "inconclusive",
        title: "Robots",
        message: "Unknown",
      }),
    ]);
    const r = groundAiIssue(
      {
        ...groundedContrastIssue(p[0]!.group.id),
        sourceFindingIds: ["SEO-050"],
        title: "Robots rules could not be read",
        description: "The robots rules could not be checked.",
        recommendation: "Check the robots rules manually.",
        severity: "medium",
        expected: null,
        claims: [],
      },
      { prepared: p[0]!, scanFindingIds: scanIds(p) },
    );
    expect(r.fields.description).toBe(`${UNABLE_TO_VERIFY} The robots rules could not be checked.`);
  });

  it("lets design issues cite the design reference", () => {
    const p = prepared();
    const design = p.find((g) => g.group.category === "design")!;
    const ai: AiIssue = {
      ...groundedContrastIssue(design.group.id),
      sourceFindingIds: ["DSN-001"],
      title: "H1 is 40px instead of 48px",
      description: "The brand primary color is #1a56db and the H1 should be 48px.",
      recommendation: "Set h1 to 48px.",
      severity: "medium",
      expected: "48px",
      claims: [],
    };
    const without = groundAiIssue(ai, { prepared: design, scanFindingIds: scanIds(p) });
    expect(check(without, "field:description")[0]!.detail.unsupported).toEqual(["#1a56db"]);
    const withSpec = groundAiIssue(ai, {
      prepared: design,
      scanFindingIds: scanIds(p),
      referenceValues: [{ colors: { Primary: { value: "#1a56db" } } }],
    });
    expect(withSpec.status).toBe("passed");
  });
});

/** A provider that answers from a script and records the requests. */
function scripted(
  answer: (batchIndex: number, groupIds: string[]) => AiBatch | Error,
): AIProvider & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    id: "anthropic",
    model: "test-model",
    label: "Scripted",
    calls,
    async generateStructured<T>(req: StructuredRequest<T>) {
      const ids = [...req.input.matchAll(/"groupId":"(G\d+)"/g)].map((m) => m[1]!);
      calls.push(ids);
      const r = answer(calls.length - 1, ids);
      if (r instanceof Error) throw r;
      return {
        data: req.schema.parse(r),
        usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0 },
        model: "test-model",
        latencyMs: 5,
        stopReason: "end_turn",
        fallbackUsed: false,
      };
    },
  };
}

describe("interpretation batches", () => {
  it("batches by category and never mixes categories", () => {
    const batches = planBatches(prepared(), { maxGroups: 1 });
    expect(batches.every((b) => b.groups.every((g) => g.group.category === b.category))).toBe(true);
    expect(batches).toHaveLength(prepared().length);
  });

  it("isolates a failed batch and stops after a configuration error", async () => {
    const p = prepared();
    const provider = scripted((i) =>
      i === 0
        ? new AIProviderError("timeout", "The AI request timed out")
        : i === 1
          ? new AIProviderError("auth", "The Anthropic API rejected the credentials")
          : { issues: [] },
    );
    const results = await interpretGroups({ provider, prepared: p, concurrency: 1 });
    expect(results.map((r) => r.status)).toEqual([
      "failed",
      "failed",
      ...results.slice(2).map(() => "skipped"),
    ]);
    expect(results[2]!.error!.message).toMatch(/Not sent after an earlier request failed/);
    expect(provider.calls).toHaveLength(2);
  });

  it("does not send batches after the signal aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = scripted(() => ({ issues: [] }));
    const results = await interpretGroups({
      provider,
      prepared: prepared(),
      concurrency: 2,
      signal: controller.signal,
    });
    expect(provider.calls).toHaveLength(0);
    expect(results.every((r) => r.status === "skipped")).toBe(true);
  });
});

describe("issue drafts", () => {
  const completed = (p: PreparedGroup[], issues: AiIssue[]): BatchResult => ({
    index: 0,
    category: "mixed",
    groupIds: p.map((g) => g.group.id),
    status: "completed",
    issues,
    error: null,
    usage: NO_USAGE,
    latencyMs: 1,
    model: "m",
    stopReason: "end_turn",
    fallbackUsed: false,
    inputChars: 1,
  });

  it("without AI: one deterministic issue per group, every finding exactly once", () => {
    const p = prepared();
    const { drafts, stats } = buildIssueDrafts({ prepared: p, batches: [] });
    expect(drafts).toHaveLength(p.length);
    expect(
      drafts.every((d) => d.origin === "deterministic" && d.groundingStatus === "not_applicable"),
    ).toBe(true);
    expect(drafts.every((d) => d.checks.length === 0)).toBe(true);
    const ids = drafts.flatMap((d) => d.findingIds);
    expect(new Set(ids).size).toBe(scanFindings().length);
    expect(stats).toMatchObject({ issues: p.length, findings: 8, ai: 0, deterministic: p.length });
    expect(drafts.find((d) => d.ruleId === "tap-target-small")).toMatchObject({
      verdict: "potential",
      status: "open",
    });
  });

  it("uses grounded AI text, and the scanners' wording where AI output is missing or invalid", () => {
    const p = prepared();
    const contrast = contrastOf(p);
    const fabricated = { ...groundedContrastIssue("G999"), sourceFindingIds: ["A11Y-001"] };
    const batch = completed(p, [
      groundedContrastIssue(contrast.group.id),
      groundedContrastIssue(contrast.group.id), // duplicate: discarded
      fabricated, // unknown group: discarded
    ]);
    const { drafts, stats } = buildIssueDrafts({ prepared: p, batches: [batch] });
    const c = drafts.find((d) => d.groupId === contrast.group.id)!;
    expect(c).toMatchObject({ origin: "ai", groundingStatus: "passed", batchIndex: 0 });
    expect(stats).toMatchObject({ ai: 1, passed: 1, discarded: 2, missing: p.length - 1 });
    const other = drafts.find((d) => d.groupId !== contrast.group.id)!;
    expect(other).toMatchObject({ origin: "deterministic", groundingStatus: "not_applicable" });
    expect(other.checks).toEqual([
      {
        checkType: "ai_output",
        passed: false,
        detail: { reason: "The AI response did not include this issue" },
      },
    ]);
  });

  it("explains failed requests on the issues they covered", () => {
    const p = prepared();
    const failed: BatchResult = {
      ...completed(p, []),
      status: "failed",
      error: { code: "refusal", message: "The model declined the request" },
    };
    const { drafts } = buildIssueDrafts({ prepared: p, batches: [failed] });
    expect(drafts[0]!.checks[0]).toMatchObject({
      checkType: "ai_output",
      detail: { reason: "The model declined the request", code: "refusal" },
    });
    expect(drafts.every((d) => d.origin === "deterministic")).toBe(true);
  });

  it("never lets AI change the category, fingerprint, findings or affected URLs", () => {
    const p = prepared();
    const contrast = contrastOf(p);
    const plain = buildIssueDrafts({ prepared: p, batches: [] }).drafts;
    const withAi = buildIssueDrafts({
      prepared: p,
      batches: [completed(p, [groundedContrastIssue(contrast.group.id)])],
    }).drafts;
    for (const [a, b] of plain.map((d, i) => [d, withAi[i]!] as const))
      expect(b).toMatchObject({
        fingerprint: a.fingerprint,
        category: a.category,
        findingIds: a.findingIds,
        affectedUrls: a.affectedUrls,
        verdict: a.verdict,
        confidence: a.confidence,
      });
  });
});
