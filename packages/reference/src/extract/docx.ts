import { load } from "cheerio";
import mammoth from "mammoth";
import { BlockCollector, ExtractionError, type ExtractionResult } from "./blocks";

/**
 * Word documents: mammoth converts the document to semantic HTML (Heading 1–6 styles become
 * h1–h6, lists become li, hyperlinks keep their targets); the HTML is read in document order.
 * The archive itself has already passed the zip-bomb guard in upload validation.
 */
export async function extractDocx(
  bytes: Buffer,
  opts: { maxBlocks?: number } = {},
): Promise<ExtractionResult> {
  let html: string;
  let messages: Array<{ type: string; message: string }>;
  try {
    const result = await mammoth.convertToHtml({ buffer: bytes });
    html = result.value;
    messages = result.messages;
  } catch (err) {
    throw new ExtractionError(
      `The Word document could not be read: ${(err as Error).message.split("\n")[0]}`,
    );
  }
  const c = new BlockCollector({ maxBlocks: opts.maxBlocks });
  for (const m of messages.slice(0, 10))
    if (m.type === "error") c.warnings.push(`Word conversion: ${m.message}`);

  const $ = load(html);
  $("h1, h2, h3, h4, h5, h6, p, li").each((_, el) => {
    const node = $(el);
    const tag = el.tagName.toLowerCase();
    if (tag === "p" && node.parents("li").length) return;
    if (/^h[1-6]$/.test(tag)) {
      c.add("heading", node.text(), { level: Number(tag[1]) });
      return;
    }
    if (tag === "li") {
      const own = node.clone();
      own.find("ul, ol").remove();
      const text = own.text();
      if (!c.marker(text)) c.add("list_item", text);
      return;
    }
    const text = node.text();
    const links = node.find("a[href]");
    const sole = links.length === 1 && links.first().text().trim() === text.trim();
    c.addText(text, {
      href: links.first().attr("href") ?? null,
      linkOnly: sole,
    });
  });
  return c.result();
}
