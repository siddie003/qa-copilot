import { extractTextItems } from "unpdf";
import { BlockCollector, ExtractionError, isStandaloneLine, type ExtractionResult } from "./blocks";

interface Line {
  page: number;
  text: string;
  fontSize: number;
  y: number;
}

const BULLET = /^\s*(?:[-*•·‣◦▪]|\d{1,3}[.)])\s+(.+)$/;

/**
 * PDF: text items from pdf.js (via unpdf) are assembled into lines and paragraphs by position.
 * Headings are recovered from font size: lines at least 20% larger than the body text size
 * (the most common size) become headings, ranked by size. Image-only PDFs have no text and are
 * reported as such (no OCR).
 */
export async function extractPdf(bytes: Buffer): Promise<ExtractionResult> {
  let pages: Awaited<ReturnType<typeof extractTextItems>>;
  try {
    pages = await extractTextItems(new Uint8Array(bytes));
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    throw new ExtractionError(
      /password/i.test(msg)
        ? "The PDF is password-protected and cannot be read."
        : `The PDF could not be read: ${msg.split("\n")[0]}`,
    );
  }

  const lines: Line[] = [];
  pages.items.forEach((items, p) => {
    let current: Line | null = null;
    for (const item of items) {
      const sameLine =
        current && Math.abs(current.y - item.y) <= Math.max(1, item.fontSize * 0.4) && !!item.str;
      if (!current || !sameLine) {
        if (current && current.text.trim()) lines.push(current);
        current = { page: p + 1, text: "", fontSize: item.fontSize, y: item.y };
      }
      current.text += item.str;
      current.fontSize = Math.max(current.fontSize, item.fontSize);
      if (item.hasEOL) {
        if (current.text.trim()) lines.push(current);
        current = null;
      }
    }
    if (current && current.text.trim()) lines.push(current);
  });

  if (!lines.length)
    throw new ExtractionError(
      "No text could be extracted from this PDF. Scanned (image-only) PDFs are not supported because OCR is not available.",
    );

  // Body size = the font size carrying the most characters.
  const weight = new Map<number, number>();
  for (const l of lines) {
    const k = Math.round(l.fontSize * 2) / 2;
    weight.set(k, (weight.get(k) ?? 0) + l.text.length);
  }
  const bodySize = [...weight.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  const isHeadingSize = (s: number) => s >= bodySize * 1.2;
  const headingSizes = [
    ...new Set(lines.filter((l) => isHeadingSize(l.fontSize)).map((l) => Math.round(l.fontSize))),
  ].sort((a, b) => b - a);

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

  const c = new BlockCollector();
  for (const g of groups) {
    const first = g[0]!;
    const text = g.map((l) => l.text.trim()).join(" ");
    const bullet = text.match(BULLET);
    if (isHeadingSize(first.fontSize) && text.length <= 160) {
      if (c.marker(text)) continue;
      c.add("heading", text, {
        level: Math.min(6, headingSizes.indexOf(Math.round(first.fontSize)) + 1),
        page: first.page,
      });
    } else if (bullet) c.add("list_item", bullet[1]!, { page: first.page });
    else c.addText(text, { page: first.page });
  }
  return c.result(pages.totalPages);
}
