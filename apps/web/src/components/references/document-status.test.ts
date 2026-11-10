import { emptyCoverage, type DocumentCoverage } from "@qa/core/content";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CoverageSummary, DocumentStatus, type DocumentStatusInput } from "./document-status";

const text = (el: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(el)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const coverage = (over: Partial<DocumentCoverage>): DocumentCoverage => ({
  ...emptyCoverage("page"),
  ...over,
});

describe("document status (rendered)", () => {
  it("shows real progress counts while extracting, never a percentage", () => {
    const doc: DocumentStatusInput = {
      parseStatus: "parsing",
      stage: "extracting",
      blockCount: 0,
      coverage: coverage({ pagesDetected: 400, pagesWithText: 118, pagesBlank: 2, blocks: 960 }),
    };
    const out = text(createElement(DocumentStatus, { doc }));
    expect(out).toBe("Extracting text 120 of 400 pages read · 960 blocks");
    expect(out).not.toMatch(/%/);
    expect(
      text(createElement(DocumentStatus, { doc: { ...doc, cancelRequestedAt: new Date() } })),
    ).toContain("Cancelling…");
  });

  it("names every outcome", () => {
    const label = (d: Partial<DocumentStatusInput>) =>
      text(createElement(DocumentStatus, { doc: { parseStatus: "parsed", blockCount: 1, ...d } }));
    expect(label({ parseStatus: "pending" })).toBe("Upload received");
    expect(label({ parseStatus: "parsing", stage: "indexing", blockCount: 6100 })).toBe(
      "Indexing sections 6,100 blocks",
    );
    expect(label({ outcome: "completed" })).toBe("Completed");
    expect(label({ outcome: "completed_with_warnings" })).toBe("Completed with warnings");
    expect(label({ outcome: "partial" })).toBe("Partial");
    expect(label({ parseStatus: "failed" })).toBe("Failed");
    expect(label({ parseStatus: "cancelled" })).toBe("Cancelled");
  });

  it("summarizes coverage, including what could not be read", () => {
    const out = text(
      createElement(CoverageSummary, {
        doc: {
          parseStatus: "parsed",
          outcome: "partial",
          blockCount: 950,
          chunkCount: 61,
          coverage: coverage({
            pagesDetected: 120,
            pagesWithText: 116,
            pagesBlank: 1,
            pagesImageOnly: 3,
            imageOnlyPages: [40, 41, 42],
            blocks: 950,
          }),
        },
      }),
    );
    expect(out).toContain(
      "120 pages detected · 116 with text · 1 blank · 950 blocks · 61 indexed sections",
    );
    expect(out).toContain("3 image-only pages (40–42): no text layer, and OCR is not available");
  });

  it("explains documents processed before coverage was recorded", () => {
    const out = text(
      createElement(CoverageSummary, {
        doc: { parseStatus: "parsed", blockCount: 34, chunkCount: 8, coverage: null },
      }),
    );
    expect(out).toBe(
      "34 blocks · 8 indexed sections · page-level coverage was not recorded (processed by an earlier version)",
    );
  });
});
