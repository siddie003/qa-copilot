import { z } from "zod";

/**
 * Shared content rules (browser-safe): accepted document types, block types, text normalization
 * and similarity. Document extraction and the content comparison must normalize text the same way.
 */

export const CONTENT_DOCUMENT_TYPES = {
  pdf: { label: "PDF", extensions: [".pdf"] },
  docx: { label: "Word (DOCX)", extensions: [".docx"] },
  txt: { label: "Plain text", extensions: [".txt"] },
  md: { label: "Markdown", extensions: [".md", ".markdown"] },
} as const;
export type ContentDocumentKind = keyof typeof CONTENT_DOCUMENT_TYPES;

export const CONTENT_ACCEPT = ".pdf,.docx,.txt,.md,.markdown";

export const CONTENT_BLOCK_TYPES = [
  "heading",
  "paragraph",
  "list_item",
  "cta",
  "link",
  "emphasis",
] as const;
export type ContentBlockType = (typeof CONTENT_BLOCK_TYPES)[number];

/** Extension of a file name (lowercase, with dot) if it is an accepted content document. */
export function contentKindForFilename(filename: string): ContentDocumentKind | null {
  const lower = filename.toLowerCase();
  for (const [kind, t] of Object.entries(CONTENT_DOCUMENT_TYPES))
    if ((t.extensions as readonly string[]).some((ext) => lower.endsWith(ext)))
      return kind as ContentDocumentKind;
  return null;
}

/**
 * The website page a document (or document section) describes, as a site-relative path such as
 * "/about". Empty string clears the mapping.
 */
export const targetPathSchema = z
  .string()
  .trim()
  .max(500)
  .refine(
    (v) => v === "" || /^\/[^\s]*$/.test(v),
    "use a site path that starts with /, e.g. /about",
  );

export const contentDocumentUpdateSchema = z.object({ targetPath: targetPathSchema });

/**
 * Unicode-normalizes text and makes typographic variants equal: curly quotes, dashes, ellipsis,
 * non-breaking and zero-width spaces. Case is preserved.
 */
export function canonicalText(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** canonicalText + lowercase: the form used for exact comparison and stored as normalized_text. */
export function normalizeText(s: string): string {
  return canonicalText(s).toLowerCase();
}

export function words(normalized: string): string[] {
  return normalized.match(/[\p{L}\p{N}]+(?:'[\p{L}]+)?/gu) ?? [];
}

function bigrams(s: string): string[] {
  const t = s.replace(/\s+/g, " ");
  const out: string[] = [];
  for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
  return out;
}

function dice(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  const counts = new Map<string, number>();
  for (const x of a) counts.set(x, (counts.get(x) ?? 0) + 1);
  let common = 0;
  for (const y of b) {
    const n = counts.get(y) ?? 0;
    if (n > 0) {
      common += 1;
      counts.set(y, n - 1);
    }
  }
  return (2 * common) / (a.length + b.length);
}

/**
 * Similarity of two normalized texts in [0, 1]: Sørensen–Dice over words (character bigrams for
 * short texts of fewer than four words, where word overlap is too coarse).
 */
export function textSimilarity(a: string, b: string): number {
  const wa = words(a);
  const wb = words(b);
  if (wa.length < 4 || wb.length < 4) return dice(bigrams(a), bigrams(b));
  return dice(wa, wb);
}

/** True if `needle` occurs in `haystack` on word boundaries (both normalized). */
export function containsPhrase(haystack: string, needle: string): boolean {
  if (!needle) return false;
  let from = 0;
  while (true) {
    const i = haystack.indexOf(needle, from);
    if (i < 0) return false;
    const before = i === 0 ? "" : haystack[i - 1]!;
    const after = haystack[i + needle.length] ?? "";
    const boundary = (c: string) => c === "" || !/[\p{L}\p{N}]/u.test(c);
    if (boundary(before) && boundary(after)) return true;
    from = i + 1;
  }
}
