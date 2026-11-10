import { describe, expect, it } from "vitest";
import { buildPdf, type PdfLine } from "../../../fixtures/documents/build.mjs";
import { chunkBlocks, chunkTokenBudget, type ChunkSourceBlock } from "./chunk";
import {
  decodeText,
  extractContentBlocks,
  extractPdfBatches,
  extractStreamInIsolation,
  ExtractionError,
  openPdf,
  type ExtractedBlock,
  type PdfBatch,
  type PdfPageSource,
  type StreamBatch,
} from "./extract";

/** Page n of a generated document: a heading every 10 pages, two paragraphs per page. */
const textPage = (n: number): PdfLine[] => [
  ...(n % 10 === 1 ? [{ text: `Chapter ${Math.ceil(n / 10)}`, size: 24 }] : []),
  { text: `Page ${n} first paragraph about topic${n}.`, size: 11, gap: 12 },
  { text: `Page ${n} second paragraph with more words.`, size: 11, gap: 12 },
];

/** 70 pages: page 5 is image-only (scanned), page 6 blank, the rest text. */
const bigPdf = () =>
  buildPdf(
    Array.from({ length: 70 }, (_, i) =>
      i + 1 === 5 ? { image: true as const } : i + 1 === 6 ? [] : textPage(i + 1),
    ),
  );

async function collect(gen: AsyncGenerator<PdfBatch>) {
  const batches: PdfBatch[] = [];
  for await (const b of gen) batches.push(b);
  return batches;
}

const strip = (b: ExtractedBlock) => ({ ...b, location: { ...b.location } });

describe("PDF extraction page by page", () => {
  it("reports every page, reads in batches and recovers headings", async () => {
    const src = await openPdf(bigPdf());
    expect(src.numPages).toBe(70);
    const batches = await collect(extractPdfBatches(src));
    await src.close();
    // First batch fixes the body size from 30 pages, then 25 per batch.
    expect(batches.map((b) => [b.pages[0]!.page, b.pages.at(-1)!.page])).toEqual([
      [1, 30],
      [31, 55],
      [56, 70],
    ]);
    const pages = batches.flatMap((b) => b.pages);
    expect(pages).toHaveLength(70);
    expect(pages.find((p) => p.page === 5)).toMatchObject({ status: "image_only", chars: 0 });
    expect(pages.find((p) => p.page === 6)).toMatchObject({ status: "blank" });
    expect(pages.filter((p) => p.status === "text")).toHaveLength(68);
    const blocks = batches.flatMap((b) => b.blocks);
    // Global, gap-free block indices across batches.
    expect(blocks.map((b) => b.location.index)).toEqual(blocks.map((_, i) => i));
    expect(blocks.filter((b) => b.type === "heading").map((b) => b.text)).toEqual(
      Array.from({ length: 7 }, (_, i) => `Chapter ${i + 1}`),
    );
    const p65 = blocks.find((b) => b.text.includes("topic65"))!;
    expect(p65.location).toMatchObject({ page: 65, headingPath: ["Chapter 7"] });
    expect(batches.at(-1)!.state.nextPage).toBe(71);
  });

  it("resumes from a checkpoint with exactly the blocks of an uninterrupted run", async () => {
    const bytes = bigPdf();
    const full = await collect(extractPdfBatches(await openPdf(bytes)));
    const first = (await extractPdfBatches(await openPdf(bytes)).next()).value as PdfBatch;
    const rest = await collect(extractPdfBatches(await openPdf(bytes), { state: first.state }));
    expect([...first.blocks, ...rest.flatMap((b) => b.blocks)].map(strip)).toEqual(
      full.flatMap((b) => b.blocks).map(strip),
    );
    expect(rest[0]!.pages[0]!.page).toBe(31);
  });

  it("isolates a failing page: the others are still read", async () => {
    const real = await openPdf(buildPdf([textPage(1), textPage(2), textPage(3), textPage(4)]));
    const src: PdfPageSource = {
      ...real,
      numPages: real.numPages,
      async textItems(n) {
        if (n === 3) throw new Error("Invalid content stream\nstack…");
        return real.textItems(n);
      },
    };
    const batches = await collect(extractPdfBatches(src));
    const pages = batches.flatMap((b) => b.pages);
    expect(pages.map((p) => p.status)).toEqual(["text", "text", "failed", "text"]);
    expect(pages[2]!.error).toBe("Invalid content stream");
    expect(batches.flatMap((b) => b.blocks).some((b) => b.text.includes("Page 4"))).toBe(true);
    await real.close();
  });

  it("stops at the block cap and says which page comes next (nothing silently dropped)", async () => {
    const src = await openPdf(bigPdf());
    const batches = await collect(extractPdfBatches(src, { maxBlocks: 25 }));
    await src.close();
    const blocks = batches.flatMap((b) => b.blocks);
    expect(blocks).toHaveLength(25);
    expect(batches.at(-1)!.truncated).toBe(true);
    const lastPage = blocks.at(-1)!.location.page!;
    expect(batches.at(-1)!.state.nextPage).toBe(lastPage + 1);
    // Pages after the cap are not reported as read.
    expect(Math.max(...batches.flatMap((b) => b.pages).map((p) => p.page))).toBeLessThanOrEqual(
      lastPage,
    );
  });

  it("explains PDFs without text and encrypted/corrupt files", async () => {
    await expect(
      extractContentBlocks("pdf", buildPdf([{ image: true }, { image: true }])),
    ).rejects.toThrow(/2 of 2 page\(s\) contain only images.*OCR is not available/);
    await expect(extractContentBlocks("pdf", Buffer.from("%PDF-1.4 broken"))).rejects.toThrow(
      ExtractionError,
    );
  });
});

describe("streaming extraction in an isolated thread", () => {
  it("streams PDF batches with page reports, then finishes", async () => {
    const got: StreamBatch[] = [];
    let total: number | null = null;
    const outcome = await extractStreamInIsolation("pdf", bigPdf(), {
      onStart: ({ totalPages }) => {
        total = totalPages;
      },
      onBatch: async (b) => {
        got.push(b);
      },
    });
    expect(outcome).toMatchObject({ status: "done", totalPages: 70, truncated: false });
    expect(total).toBe(70);
    expect(got).toHaveLength(3);
    expect(got.every((b) => b.state !== null)).toBe(true);
  });

  it("is cancelled between batches; later batches are not delivered", async () => {
    const controller = new AbortController();
    const got: StreamBatch[] = [];
    const outcome = await extractStreamInIsolation("pdf", bigPdf(), {
      signal: controller.signal,
      onBatch: async (b) => {
        got.push(b);
        controller.abort();
      },
    });
    expect(outcome).toMatchObject({ status: "cancelled", totalPages: 70 });
    expect(got).toHaveLength(1);
    expect(got[0]!.state!.nextPage).toBe(31);
  });

  it("streams other formats in slices and keeps the order", async () => {
    const md = Array.from({ length: 2_500 }, (_, i) => `Paragraph number ${i}.`).join("\n\n");
    const got: StreamBatch[] = [];
    const outcome = await extractStreamInIsolation("md", Buffer.from(md), {
      onBatch: async (b) => {
        got.push(b);
      },
    });
    expect(outcome.status).toBe("done");
    expect(got.map((b) => b.blocks.length)).toEqual([1_000, 1_000, 500]);
    expect(got.flatMap((b) => b.blocks).map((b) => b.location.index)).toEqual(
      Array.from({ length: 2_500 }, (_, i) => i),
    );
  });

  it("keeps documents beyond the old 5000-block cap and reports a configured cap", async () => {
    const md = Array.from({ length: 6_000 }, (_, i) => `Line ${i}.`).join("\n\n");
    const all = await extractContentBlocks("md", Buffer.from(md));
    expect(all.blocks).toHaveLength(6_000);
    expect(all.meta.truncated).toBe(false);
    const capped = await extractContentBlocks("md", Buffer.from(md), { maxBlocks: 1_000 });
    expect(capped.blocks).toHaveLength(1_000);
    expect(capped.meta).toMatchObject({ truncated: true });
    expect(capped.meta.warnings.join(" ")).toMatch(/first 1000 blocks.*DOCUMENT_MAX_BLOCKS/);
  });
});

describe("text encodings", () => {
  it("reads UTF-8 (with or without BOM) and UTF-16 with a byte-order mark", () => {
    const text = "Über uns — café";
    expect(decodeText(Buffer.from(text, "utf8"))).toBe(text);
    expect(decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]))).toBe(
      text,
    );
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
    expect(decodeText(le)).toBe(text);
    const be = Buffer.from(le);
    for (let i = 0; i < be.length; i += 2) [be[i], be[i + 1]] = [be[i + 1]!, be[i]!];
    expect(decodeText(be)).toBe(text);
  });

  it("refuses invalid UTF-8 instead of replacing characters", () => {
    expect(() => decodeText(Buffer.from([0x48, 0xc3, 0x28]))).toThrow(/not valid UTF-8/);
  });
});

describe("chunking for retrieval", () => {
  const block = (
    order: number,
    text: string,
    over: Partial<ChunkSourceBlock> = {},
  ): ChunkSourceBlock => ({
    order,
    type: "paragraph",
    level: null,
    text,
    pageHint: null,
    location: { index: order, page: Math.floor(order / 3) + 1 },
    ...over,
  });

  it("puts every block in exactly one chunk, split at sections, page markers and size", () => {
    const blocks = [
      block(0, "Intro", { type: "heading", level: 1 }),
      ...Array.from({ length: 8 }, (_, i) => block(i + 1, `Sentence ${i} ${"x".repeat(80)}`)),
      block(9, "Pricing", {
        type: "heading",
        level: 2,
        location: { index: 9, page: 4, headingPath: ["Intro"] },
      }),
      block(10, "Plans", { location: { index: 10, page: 4, headingPath: ["Intro", "Pricing"] } }),
      block(11, "Careers text", { pageHint: "/careers", location: { index: 11, page: 4 } }),
    ];
    const chunks = chunkBlocks(blocks, 100); // 300 characters per chunk
    const covered = chunks.flatMap((c) =>
      Array.from({ length: c.blockEnd - c.blockStart + 1 }, (_, i) => c.blockStart + i),
    );
    expect(covered).toEqual(blocks.map((b) => b.order));
    expect(chunks.every((c) => c.text.length <= 300 || c.blockStart === c.blockEnd)).toBe(true);
    const pricing = chunks.find((c) => c.text.startsWith("Pricing"))!;
    expect(pricing).toMatchObject({ headingText: "Intro › Pricing", pageStart: 4, pageEnd: 4 });
    expect(chunks.at(-1)).toMatchObject({ pageHint: "/careers", text: "Careers text" });
    expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i));
    // Offsets refer to the block texts joined by newlines.
    const doc = blocks.map((b) => b.text).join("\n");
    for (const c of chunks) expect(doc.slice(c.charStart, c.charEnd)).toBe(c.text);
    expect(chunks[0]!.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sizes chunks from the configured tokens, at most a quarter of an AI request", () => {
    expect(chunkTokenBudget(600, 20_000)).toBe(600);
    expect(chunkTokenBudget(600, 1_200)).toBe(300);
    expect(chunkTokenBudget(600, 100)).toBe(100);
  });
});
