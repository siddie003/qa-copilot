import { describe, expect, it } from "vitest";
import { issueCorpus } from "./grounding";
import { groupFacts, groupFindings } from "./grouping";
import { deterministicIssue } from "./deterministic";
import { buildBatchInput, groupInput, MAX_SECTION_CHARS, type PreparedGroup } from "./prompt";
import type { ScanFinding } from "./types";
import { unsupportedFacts } from "./values";

/** A content-comparison finding as the scanner stores it (evidence names its source block). */
const finding: ScanFinding = {
  id: "f1",
  displayId: "CNT-001",
  scanner: "content",
  ruleId: "content-missing",
  title: "Content missing: “Free shipping on all orders over $50.”",
  message:
    "The approved paragraph “Free shipping on all orders over $50.” was not found on /about.",
  category: "content",
  subcategory: null,
  severity: "medium",
  verdict: "confirmed",
  confidence: 0.95,
  pageUrl: "https://example.com/about",
  selector: null,
  viewport: null,
  expected: "Free shipping on all orders over $50.",
  actual: null,
  fingerprint: "fp",
  evidence: [
    {
      kind: "document",
      data: {
        document: "handbook.pdf",
        documentId: "11111111-1111-4111-8111-111111111111",
        blockOrder: 412,
        location: "handbook.pdf, page 37",
        referenceText: "Free shipping on all orders over $50.",
      },
    },
  ],
} as unknown as ScanFinding;

function prepared(sectionText: string): PreparedGroup {
  const [group] = groupFindings([finding]);
  const facts = groupFacts(group!);
  return {
    group: group!,
    facts,
    deterministic: deterministicIssue(group!, facts),
    context: {
      approvedSections: [
        {
          document: "handbook.pdf",
          section: "Shipping › Offers",
          pages: "PDF page 37",
          text: sectionText,
        },
      ],
    },
  };
}

describe("approved sections for content issues", () => {
  it("sends the retrieved section (bounded, secrets removed), never the whole document", () => {
    const long = `Shipping offers. Free shipping on all orders over $50. Returns within 30 days. Token ghp_${"a".repeat(36)} ${"More text. ".repeat(200)}`;
    const p = prepared(long);
    const input = groupInput(p) as {
      approvedSections: Array<{ document: string; section: string; pages: string; text: string }>;
    };
    expect(input.approvedSections).toHaveLength(1);
    expect(input.approvedSections[0]).toMatchObject({
      document: "handbook.pdf",
      section: "Shipping › Offers",
      pages: "PDF page 37",
    });
    expect(input.approvedSections[0]!.text.length).toBeLessThanOrEqual(MAX_SECTION_CHARS + 1);
    expect(input.approvedSections[0]!.text).not.toContain("ghp_");
    expect(buildBatchInput([p]).length).toBeLessThan(long.length + 4_000);
  });

  it("lets the AI quote the section, but nothing that is not in it", () => {
    const p = prepared("Free shipping on all orders over $50. Returns within 30 days.");
    const corpus = issueCorpus(p);
    expect(
      unsupportedFacts("The approved section also promises returns within 30 days.", corpus),
    ).toEqual([]);
    expect(unsupportedFacts("Returns are accepted within 45 days.", corpus)).not.toEqual([]);
  });

  it("adds nothing for groups without retrieved sections", () => {
    const p = prepared("x");
    delete p.context;
    expect(groupInput(p)).not.toHaveProperty("approvedSections");
  });
});
