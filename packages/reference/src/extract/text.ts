import { BlockCollector, isStandaloneLine, type ExtractionResult } from "./blocks";

const BULLET = /^\s*(?:[-*•·‣◦]|\d{1,3}[.)])\s+(.+)$/;

/**
 * Plain text: paragraphs are separated by blank lines. Lines starting with "#" are headings;
 * a short single-line paragraph without closing punctuation followed by more text is treated as
 * a heading too. Bullet lines become list items.
 */
export function extractPlainText(
  input: string,
  opts: { maxBlocks?: number } = {},
): ExtractionResult {
  const c = new BlockCollector({ maxBlocks: opts.maxBlocks });
  const lines = input.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/);
  const paragraphs: Array<{ lines: string[]; start: number }> = [];
  let current: { lines: string[]; start: number } | null = null;
  lines.forEach((line, i) => {
    if (!line.trim()) {
      current = null;
      return;
    }
    // Page markers and CTA lines are always paragraphs of their own.
    if (isStandaloneLine(line)) {
      paragraphs.push({ lines: [line], start: i + 1 });
      current = null;
      return;
    }
    if (!current) {
      current = { lines: [], start: i + 1 };
      paragraphs.push(current);
    }
    current.lines.push(line);
  });

  paragraphs.forEach((p, idx) => {
    if (p.lines.every((l) => BULLET.test(l))) {
      p.lines.forEach((l, j) => c.add("list_item", l.match(BULLET)![1]!, { line: p.start + j }));
      return;
    }
    const text = p.lines.map((l) => l.trim()).join(" ");
    const md = text.match(/^(#{1,6})\s+(.+)$/);
    if (md) return c.add("heading", md[2]!, { level: md[1]!.length, line: p.start });
    const looksLikeHeading =
      p.lines.length === 1 &&
      text.length <= 80 &&
      text.split(/\s+/).length <= 12 &&
      !/[.!?,;:]$/.test(text) &&
      idx < paragraphs.length - 1 &&
      !/^(?:page|url|cta|button)\s*[:=]/i.test(text);
    if (looksLikeHeading)
      return c.add("heading", text, { level: c.blocks.length === 0 ? 1 : 2, line: p.start });
    c.addText(text, { line: p.start });
  });
  return c.result();
}
