import type { ContentDocumentKind } from "@qa/core";
import { ExtractionError, type ExtractionResult } from "./blocks";
import { extractDocx } from "./docx";
import { extractMarkdown } from "./markdown";
import { extractPdf } from "./pdf";
import { extractPlainText } from "./text";

export * from "./blocks";
export {
  extractPdf,
  extractPdfBatches,
  noTextMessage,
  openPdf,
  pageWarnings,
  PDF_BATCH_PAGES,
  PDF_SAMPLE_PAGES,
  type PdfBatch,
  type PdfPageReport,
  type PdfPageSource,
  type PdfPageStatus,
  type PdfState,
  type PdfTextItem,
} from "./pdf";
export { extractDocx, extractMarkdown, extractPlainText };
export {
  extractInIsolation,
  extractStreamInIsolation,
  type IsolationOptions,
  type StreamBatch,
  type StreamOptions,
  type StreamOutcome,
} from "./isolated";

/**
 * Decodes an uploaded text file: UTF-8 (with or without BOM) or UTF-16 with a byte-order mark.
 * Invalid sequences fail instead of being replaced silently.
 */
export function decodeText(bytes: Buffer): string {
  const bom = (a: number, b: number) => bytes[0] === a && bytes[1] === b;
  const encoding = bom(0xff, 0xfe) ? "utf-16le" : bom(0xfe, 0xff) ? "utf-16be" : "utf-8";
  try {
    return new TextDecoder(encoding, { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new ExtractionError(
      `The text file is not valid ${encoding.toUpperCase()}. Save it as UTF-8 and upload it again.`,
    );
  }
}

/**
 * Extracts content blocks from a validated document in one piece. Runs with a time limit;
 * documents that yield no text fail with an explanation instead of producing an empty "success".
 * (The worker processes content documents with `extractStreamInIsolation`, page batch by batch.)
 */
export async function extractContentBlocks(
  kind: ContentDocumentKind,
  bytes: Buffer,
  opts: { timeoutMs?: number; maxBlocks?: number } = {},
): Promise<ExtractionResult> {
  const run = async (): Promise<ExtractionResult> => {
    switch (kind) {
      case "pdf":
        return extractPdf(bytes, { maxBlocks: opts.maxBlocks });
      case "docx":
        return extractDocx(bytes, { maxBlocks: opts.maxBlocks });
      case "md":
        return extractMarkdown(decodeText(bytes), { maxBlocks: opts.maxBlocks });
      case "txt":
        return extractPlainText(decodeText(bytes), { maxBlocks: opts.maxBlocks });
    }
  };
  const timeoutMs = opts.timeoutMs ?? 60_000;
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new ExtractionError(
                `Text extraction took longer than ${Math.round(timeoutMs / 1000)} s and was stopped.`,
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
    if (!result.blocks.length)
      throw new ExtractionError("The document contains no text that could be compared.");
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
