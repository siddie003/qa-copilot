import * as cheerio from "cheerio";

export interface ExtractedLink {
  /** Absolute URL (fragment kept so callers can see in-page anchors). */
  url: string;
  /** Attribute value as written in the HTML. */
  raw: string;
  text: string;
  rel: string | null;
}

/**
 * Extracts navigational links (<a href>, <area href>) from HTML, resolved against the document's
 * <base href> or URL. Non-navigational schemes (mailto:, tel:, javascript:, data:) are skipped.
 */
export function extractLinks(html: string, documentUrl: string): ExtractedLink[] {
  const $ = cheerio.load(html);
  let base = documentUrl;
  const baseHref = $("base[href]").first().attr("href");
  if (baseHref) {
    try {
      base = new URL(baseHref, documentUrl).toString();
    } catch {
      // Invalid <base>: browsers fall back to the document URL as well.
    }
  }
  const out: ExtractedLink[] = [];
  $("a[href], area[href]").each((_, el) => {
    const raw = ($(el).attr("href") ?? "").trim();
    if (!raw || /^(mailto|tel|javascript|data|sms|ftp):/i.test(raw)) return;
    let url: string;
    try {
      url = new URL(raw, base).toString();
    } catch {
      return;
    }
    if (!/^https?:/i.test(url)) return;
    out.push({
      url,
      raw,
      text: $(el).text().replace(/\s+/g, " ").trim().slice(0, 200),
      rel: $(el).attr("rel") ?? null,
    });
  });
  return out;
}

/** <title> text of an HTML document, if any. */
export function extractTitle(html: string): string | null {
  const title = cheerio.load(html)("title").first().text().replace(/\s+/g, " ").trim();
  return title || null;
}
