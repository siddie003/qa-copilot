import { formatPageList } from "@qa/core";
import { getDocumentProxy, getResolvedPDFJS } from "unpdf";
import {
  BlockCollector,
  ExtractionError,
  isStandaloneLine,
  type CollectorState,
  type ExtractedBlock,
  type ExtractionResult,
} from "./blocks";

/** One text item of a page (pdf.js text content, positioned). */
export interface PdfTextItem {
  str: string;
  y: number;
  fontSize: number;
  hasEOL: boolean;
}

/** Page-level access to a PDF; the real one wraps pdf.js, tests can supply their own. */
export interface PdfPageSource {
  numPages: number;
  textItems(page: number): Promise<PdfTextItem[]>;
  /** Whether the page paints images (an image-only page is probably a scan). */
  hasImages(page: number): Promise<boolean>;
  close(): Promise<void>;
}

export type PdfPageStatus = "text" | "blank" | "image_only" | "failed";

export interface PdfPageReport {
  page: number;
  status: PdfPageStatus;
  /** Characters of text read from the page. */
  chars: number;
  error?: string;
}

/** Resume state of a PDF extraction (stored as the document's checkpoint). */
export interface PdfState {
  /** First page not processed yet (1-based). */
  nextPage: number;
  /** Body font size, fixed from the first pages with text (headings are ≥ 1.2×). */
  bodySize: number | null;
  /** Distinct heading font sizes seen so far, largest first (heading level = rank). */
  headingSizes: number[];
  collector: CollectorState;
}

export interface PdfBatch {
  blocks: ExtractedBlock[];
  pages: PdfPageReport[];
  state: PdfState;
  /** True when the block cap was reached: later pages were not read. */
  truncated: boolean;
  /** Blocks shortened to the per-block character limit in this batch. */
  shortened: number;
}

/** Pages read before the body font size is fixed (all pages of short documents). */
export const PDF_SAMPLE_PAGES = 30;
/** Pages per batch after the first (each batch is stored with a checkpoint). */
export const PDF_BATCH_PAGES = 25;

interface Line {
  page: number;
  text: string;
  fontSize: number;
  y: number;
}

const BULLET = /^\s*(?:[-*•·‣◦▪]|\d{1,3}[.)])\s+(.+)$/;
const firstLine = (err: unknown) =>
  ((err as Error)?.message ?? String(err)).split("\n")[0]!.slice(0, 200);

/** Opens a PDF with pdf.js. Password-protected and unreadable files fail with an explanation. */
export async function openPdf(bytes: Buffer): Promise<PdfPageSource> {
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    pdf = await getDocumentProxy(new Uint8Array(bytes));
  } catch (err) {
    const msg = firstLine(err);
    throw new ExtractionError(
      /password/i.test(msg)
        ? "The PDF is password-protected and cannot be read."
        : `The PDF could not be read: ${msg}`,
    );
  }
  const { OPS } = await getResolvedPDFJS();
  const imageOps = new Set(
    [
      OPS.paintImageXObject,
      OPS.paintInlineImageXObject,
      OPS.paintImageMaskXObject,
      OPS.paintImageXObjectRepeat,
      OPS.paintInlineImageXObjectGroup,
      OPS.paintImageMaskXObjectGroup,
      OPS.paintImageMaskXObjectRepeat,
    ].filter((v): v is number => typeof v === "number"),
  );
  return {
    numPages: pdf.numPages,
    async textItems(n) {
      const page = await pdf.getPage(n);
      try {
        const content = await page.getTextContent();
        return content.items.flatMap((item) => {
          if (!("str" in item) || item.str == null) return [];
          const [, , c, d, , f] = item.transform as number[];
          return [{ str: item.str, y: f!, fontSize: Math.hypot(c!, d!), hasEOL: item.hasEOL }];
        });
      } finally {
        page.cleanup();
      }
    },
    async hasImages(n) {
      const page = await pdf.getPage(n);
      try {
        const ops = await page.getOperatorList();
        return ops.fnArray.some((fn) => imageOps.has(fn));
      } finally {
        page.cleanup();
      }
    },
    async close() {
      await pdf.loadingTask.destroy();
    },
  };
}

/** Lines of one page from positioned text items. */
function pageLines(page: number, items: PdfTextItem[]): Line[] {
  const lines: Line[] = [];
  let current: Line | null = null;
  for (const item of items) {
    const sameLine =
      current && Math.abs(current.y - item.y) <= Math.max(1, item.fontSize * 0.4) && !!item.str;
    if (!current || !sameLine) {
      if (current && current.text.trim()) lines.push(current);
      current = { page, text: "", fontSize: item.fontSize, y: item.y };
    }
    current.text += item.str;
    current.fontSize = Math.max(current.fontSize, item.fontSize);
    if (item.hasEOL) {
      if (current.text.trim()) lines.push(current);
      current = null;
    }
  }
  if (current && current.text.trim()) lines.push(current);
  return lines;
}

/** Body size = the font size carrying the most characters. */
function bodySizeOf(lines: Line[]): number {
  const weight = new Map<number, number>();
  for (const l of lines) {
    const k = Math.round(l.fontSize * 2) / 2;
    weight.set(k, (weight.get(k) ?? 0) + l.text.length);
  }
  return [...weight.entries()].sort((a, b) => b[1] - a[1])[0]![0];
}

/**
 * Reads a PDF page by page, in batches. Each page is reported (text, blank, image-only — no
 * OCR — or failed with its error); one page failing does not stop the others. Headings are
 * recovered from font size: lines at least 20% larger than the body size become headings, ranked
 * by size. The body size is fixed from the first PDF_SAMPLE_PAGES pages (the whole document when
 * it is shorter), so a resumed extraction produces the same structure.
 */
export async function* extractPdfBatches(
  src: PdfPageSource,
  opts: {
    state?: PdfState | null;
    maxBlocks?: number;
    samplePages?: number;
    batchPages?: number;
  } = {},
): AsyncGenerator<PdfBatch> {
  const state: PdfState = opts.state
    ? structuredClone(opts.state)
    : {
        nextPage: 1,
        bodySize: null,
        headingSizes: [],
        collector: { nextIndex: 0, pageHint: null, headings: [] },
      };
  const c = new BlockCollector({ state: state.collector, maxBlocks: opts.maxBlocks });
  let shortenedBefore = 0;
  while (state.nextPage <= src.numPages && !c.truncated) {
    const size =
      state.bodySize === null
        ? (opts.samplePages ?? PDF_SAMPLE_PAGES)
        : (opts.batchPages ?? PDF_BATCH_PAGES);
    const last = Math.min(src.numPages, state.nextPage + size - 1);
    const reports: PdfPageReport[] = [];
    const lines: Line[] = [];
    for (let p = state.nextPage; p <= last; p++) {
      try {
        const pl = pageLines(p, await src.textItems(p));
        if (pl.length) {
          lines.push(...pl);
          reports.push({
            page: p,
            status: "text",
            chars: pl.reduce((s, l) => s + l.text.length, 0),
          });
        } else
          reports.push({
            page: p,
            status: (await src.hasImages(p).catch(() => false)) ? "image_only" : "blank",
            chars: 0,
          });
      } catch (err) {
        reports.push({ page: p, status: "failed", chars: 0, error: firstLine(err) });
      }
    }
    if (lines.length) {
      state.bodySize ??= bodySizeOf(lines);
      const bodySize = state.bodySize;
      const isHeadingSize = (s: number) => s >= bodySize * 1.2;
      const sizes = new Set(state.headingSizes);
      for (const l of lines) if (isHeadingSize(l.fontSize)) sizes.add(Math.round(l.fontSize));
      state.headingSizes = [...sizes].sort((a, b) => b - a);

      // Group consecutive lines with the same size and a normal line gap into paragraphs.
      const groups: Line[][] = [];
      for (const l of lines) {
        const g = groups[groups.length - 1];
        const prev = g?.[g.length - 1];
        const continues =
          prev &&
          prev.page === l.page &&
          Math.abs(prev.fontSize - l.fontSize) < 0.5 &&
          prev.y - l.y > 0 &&
          prev.y - l.y <= l.fontSize * 1.8 &&
          !BULLET.test(l.text) &&
          !isHeadingSize(l.fontSize) &&
          !isStandaloneLine(l.text) &&
          !isStandaloneLine(prev.text);
        if (continues) g!.push(l);
        else groups.push([l]);
      }
      for (const g of groups) {
        const first = g[0]!;
        const text = g.map((l) => l.text.trim()).join(" ");
        const bullet = text.match(BULLET);
        if (isHeadingSize(first.fontSize) && text.length <= 160) {
          if (c.marker(text)) continue;
          c.add("heading", text, {
            level: Math.min(6, state.headingSizes.indexOf(Math.round(first.fontSize)) + 1),
            page: first.page,
          });
        } else if (bullet) c.add("list_item", bullet[1]!, { page: first.page });
        else c.addText(text, { page: first.page });
      }
    }
    // With the block cap reached mid-batch, later pages of the batch count as not processed.
    const truncatedAt = c.truncated
      ? Math.max(state.nextPage, (c.blocks[c.blocks.length - 1]?.location.page ?? last) + 1)
      : null;
    state.nextPage = truncatedAt ?? last + 1;
    const blocks = c.drain();
    state.collector = c.state();
    yield {
      blocks,
      pages: truncatedAt ? reports.filter((r) => r.page < truncatedAt) : reports,
      state: structuredClone(state),
      truncated: c.truncated,
      shortened: c.shortenedCount - shortenedBefore,
    };
    shortenedBefore = c.shortenedCount;
  }
}

/** Whole-document extraction (guideline documents, tests): all batches collected. */
export async function extractPdf(
  bytes: Buffer,
  opts: { maxBlocks?: number } = {},
): Promise<ExtractionResult> {
  const src = await openPdf(bytes);
  try {
    const blocks: ExtractedBlock[] = [];
    const pages: PdfPageReport[] = [];
    let truncated = false;
    for await (const b of extractPdfBatches(src, opts)) {
      blocks.push(...b.blocks);
      pages.push(...b.pages);
      truncated ||= b.truncated;
    }
    if (!blocks.length) throw new ExtractionError(noTextMessage(pages, src.numPages));
    return {
      blocks,
      meta: { pages: src.numPages, warnings: pageWarnings(pages, src.numPages), truncated },
    };
  } finally {
    await src.close();
  }
}

/** Warnings for pages that were not read (never silently skipped). */
export function pageWarnings(pages: PdfPageReport[], total: number): string[] {
  const of = (s: PdfPageStatus) => pages.filter((p) => p.status === s).map((p) => p.page);
  const out: string[] = [];
  const image = of("image_only");
  const failed = pages.filter((p) => p.status === "failed");
  if (image.length)
    out.push(
      `${image.length} of ${total} page(s) contain only images and no text layer (scanned?): ${formatPageList(image)}. OCR is not available, so their content could not be read.`,
    );
  if (failed.length)
    out.push(
      `${failed.length} page(s) could not be read: ${failed
        .slice(0, 5)
        .map((p) => `page ${p.page} (${p.error})`)
        .join("; ")}${failed.length > 5 ? "; …" : ""}.`,
    );
  return out;
}

export function noTextMessage(pages: PdfPageReport[], total: number): string {
  const image = pages.filter((p) => p.status === "image_only").length;
  const failed = pages.filter((p) => p.status === "failed").length;
  if (failed === total && total > 0)
    return `None of the ${total} page(s) of this PDF could be read (${pages[0]?.error ?? "unknown error"}).`;
  return `No text could be extracted from this PDF${image ? ` (${image} of ${total} page(s) contain only images)` : ""}. Scanned (image-only) PDFs are not supported because OCR is not available.`;
}
