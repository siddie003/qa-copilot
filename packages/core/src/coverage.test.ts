import { describe, expect, it } from "vitest";
import {
  coverageGapNote,
  documentOutcome,
  documentState,
  emptyCoverage,
  formatPageList,
  pagesNotProcessed,
  searchTerms,
  type DocumentCoverage,
} from "./content";

const cov = (over: Partial<DocumentCoverage>): DocumentCoverage => ({
  ...emptyCoverage("page"),
  pagesDetected: 10,
  pagesWithText: 10,
  blocks: 40,
  ...over,
});

describe("document coverage", () => {
  it("is complete only when every page was read", () => {
    expect(documentOutcome(cov({}))).toBe("completed");
    // Blank pages are listed but are not a problem.
    expect(documentOutcome(cov({ pagesWithText: 8, pagesBlank: 2, blankPages: [3, 4] }))).toBe(
      "completed",
    );
    expect(documentOutcome(cov({ blocksShortened: 1 }))).toBe("completed_with_warnings");
    expect(documentOutcome(cov({ warnings: ["Word conversion: x"] }))).toBe(
      "completed_with_warnings",
    );
    for (const partial of [
      { pagesImageOnly: 1, imageOnlyPages: [5] },
      { pagesFailed: 1, failedPages: [{ page: 2, error: "bad" }] },
      { notProcessedFrom: 7 },
      { blockLimitReached: true },
      { timeLimitReached: true },
      { stoppedReason: "Reading this document needed more than 512 MB of memory" },
    ])
      expect(documentOutcome(cov(partial))).toBe("partial");
  });

  it("states what was not read", () => {
    expect(coverageGapNote(cov({}))).toBeNull();
    expect(coverageGapNote(null)).toBeNull();
    const note = coverageGapNote(
      cov({
        pagesImageOnly: 3,
        imageOnlyPages: [2, 3, 4],
        notProcessedFrom: 8,
        stoppedReason: "Text extraction took longer than 300 s and was stopped.",
      }),
    )!;
    expect(note).toContain("3 image-only page(s) (2–4) could not be read without OCR");
    expect(note).toContain("pages 8–10 were not read (Text extraction took longer than 300 s");
    expect(pagesNotProcessed(cov({ notProcessedFrom: 8 }))).toBe(3);
  });

  it("maps persisted job fields to the states users see", () => {
    expect(documentState({ parseStatus: "pending" })).toBe("queued");
    expect(documentState({ parseStatus: "parsing", stage: "extracting" })).toBe("extracting");
    expect(documentState({ parseStatus: "parsing", stage: "indexing" })).toBe("indexing");
    expect(documentState({ parseStatus: "parsed", outcome: "completed" })).toBe("completed");
    expect(documentState({ parseStatus: "parsed", outcome: "partial" })).toBe("partial");
    expect(documentState({ parseStatus: "parsed", outcome: "completed_with_warnings" })).toBe(
      "completed_with_warnings",
    );
    expect(documentState({ parseStatus: "parsed", outcome: null })).toBe("completed");
    expect(documentState({ parseStatus: "failed" })).toBe("failed");
    expect(documentState({ parseStatus: "cancelled" })).toBe("cancelled");
  });

  it("formats page lists as ranges", () => {
    expect(formatPageList([9, 1, 2, 3, 7, 10, 3])).toBe("1–3, 7, 9–10");
    expect(formatPageList([])).toBe("");
  });
});

describe("search terms", () => {
  it("builds a safe OR query from words of any script", () => {
    expect(searchTerms("The pricing PLANS for teams & (enterprise) | !")).toBe(
      "enterprise | pricing | plans | teams",
    );
    expect(searchTerms("Über uns: Preise")).toBe("preise | über | uns");
    expect(searchTerms("a & | ! :*")).toBeNull();
    // Only letters and digits reach to_tsquery.
    expect(searchTerms("x' or 1=1 -- ; drop")).toBe("drop");
  });
});
