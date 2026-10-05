import type { ContentDocumentKind } from "@qa/core";
import { ExtractionError, type ExtractionResult } from "./blocks";
import { extractDocx } from "./docx";
import { extractMarkdown } from "./markdown";
import { extractPdf } from "./pdf";
import { extractPlainText } from "./text";

export * from "./blocks";
export { extractDocx, extractMarkdown, extractPdf, extractPlainText };

/**
 * Extracts content blocks from a validated document. Runs with a time limit; documents that
 * yield no text fail with an explanation instead of producing an empty "success".
 */
export async function extractContentBlocks(
  kind: ContentDocumentKind,
  bytes: Buffer,
  opts: { timeoutMs?: number } = {},
): Promise<ExtractionResult> {
  const run = async (): Promise<ExtractionResult> => {
    switch (kind) {
      case "pdf":
        return extractPdf(bytes);
      case "docx":
        return extractDocx(bytes);
      case "md":
        return extractMarkdown(bytes.toString("utf8"));
      case "txt":
        return extractPlainText(bytes.toString("utf8"));
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
