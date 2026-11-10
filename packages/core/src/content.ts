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

/**
 * Terms for an OR full-text query: distinct words of at least 3 letters/digits (any script),
 * longest first, at most `max`. Returned as a to_tsquery string ("a | b | c") or null when the
 * text has no usable word. Only letters and digits reach the query (no tsquery syntax).
 */
export function searchTerms(text: string, max = 24): string | null {
  const words = new Set<string>();
  for (const w of text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []) {
    if (SEARCH_STOPWORDS.has(w)) continue;
    words.add(w.slice(0, 64));
  }
  const picked = [...words].sort((a, b) => b.length - a.length).slice(0, max);
  return picked.length ? picked.join(" | ") : null;
}

const SEARCH_STOPWORDS = new Set(
  "the and for are but not you all any can her was one our out his has had how its may new now old see two way who did get him let say she too use with that this from have they will your what when were there their which would about into than them then these some could other only more also been just like over such".split(
    " ",
  ),
);

// ---- Large-document processing: coverage and states (Phase 13) --------------------------------

/**
 * What processing a document read, persisted on `content_document.coverage`. PDFs are reported
 * per page; other formats as a whole ("document"). Page lists are 1-based page numbers.
 */
export interface DocumentCoverage {
  unit: "page" | "document";
  /** Pages in the PDF (null for other formats or before the PDF was opened). */
  pagesDetected: number | null;
  pagesWithText: number;
  /** Pages without any content (no text, no images). */
  pagesBlank: number;
  /** Pages with images but no text layer: probably scanned; not readable without OCR. */
  pagesImageOnly: number;
  pagesFailed: number;
  imageOnlyPages: number[];
  blankPages: number[];
  /** First failures with their error (at most 100 listed; `pagesFailed` has the total). */
  failedPages: Array<{ page: number; error: string }>;
  /** First page not read (time limit, block limit, interruption), or null when all were read. */
  notProcessedFrom: number | null;
  blocks: number;
  blocksShortened: number;
  blockLimitReached: boolean;
  /** Indexed sections (retrieval chunks). */
  chunks: number;
  timeLimitReached: boolean;
  /** Why reading stopped early (time limit, memory limit, error), if it did. */
  stoppedReason: string | null;
  warnings: string[];
}

export function emptyCoverage(unit: "page" | "document"): DocumentCoverage {
  return {
    unit,
    pagesDetected: null,
    pagesWithText: 0,
    pagesBlank: 0,
    pagesImageOnly: 0,
    pagesFailed: 0,
    imageOnlyPages: [],
    blankPages: [],
    failedPages: [],
    notProcessedFrom: null,
    blocks: 0,
    blocksShortened: 0,
    blockLimitReached: false,
    chunks: 0,
    timeLimitReached: false,
    stoppedReason: null,
    warnings: [],
  };
}

export type DocumentOutcome = "completed" | "completed_with_warnings" | "partial";

/** Pages that were never read (from `notProcessedFrom` to the last page). */
export function pagesNotProcessed(c: DocumentCoverage): number {
  if (c.notProcessedFrom === null || c.pagesDetected === null) return 0;
  return Math.max(0, c.pagesDetected - c.notProcessedFrom + 1);
}

/**
 * Partial: some content could not be read (image-only or failed pages, pages not reached, block
 * limit). With warnings: everything was read but something was adjusted (shortened blocks,
 * converter messages). Blank pages are listed but are not a warning.
 */
export function documentOutcome(c: DocumentCoverage): DocumentOutcome {
  if (
    c.pagesImageOnly > 0 ||
    c.pagesFailed > 0 ||
    pagesNotProcessed(c) > 0 ||
    c.blockLimitReached ||
    c.timeLimitReached ||
    c.stoppedReason
  )
    return "partial";
  if (c.warnings.length || c.blocksShortened > 0) return "completed_with_warnings";
  return "completed";
}

/** Compact page list: "1–3, 7, 9–12". */
export function formatPageList(pages: number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i]!;
    while (sorted[i + 1] === sorted[i]! + 1) i++;
    out.push(start === sorted[i] ? String(start) : `${start}–${sorted[i]}`);
  }
  return out.join(", ");
}

/** One sentence on what was not read, or null when everything was read. */
export function coverageGapNote(c: DocumentCoverage | null | undefined): string | null {
  if (!c) return null;
  const parts: string[] = [];
  if (c.pagesImageOnly)
    parts.push(
      `${c.pagesImageOnly} image-only page(s) (${formatPageList(c.imageOnlyPages)}) could not be read without OCR`,
    );
  if (c.pagesFailed)
    parts.push(
      `${c.pagesFailed} page(s) could not be read (${formatPageList(c.failedPages.map((p) => p.page))}${c.pagesFailed > c.failedPages.length ? ", …" : ""})`,
    );
  const notRead = pagesNotProcessed(c);
  if (notRead)
    parts.push(
      `pages ${c.notProcessedFrom}–${c.pagesDetected} were not read (${c.stoppedReason ?? "processing stopped"})`,
    );
  else if (c.stoppedReason) parts.push(c.stoppedReason);
  if (c.blockLimitReached)
    parts.push(`only the first ${c.blocks} blocks were kept (DOCUMENT_MAX_BLOCKS)`);
  return parts.length ? `${parts.join("; ")}.` : null;
}

export const DOCUMENT_STATES = {
  queued: { label: "Upload received", tone: "neutral" },
  extracting: { label: "Extracting text", tone: "info" },
  indexing: { label: "Indexing sections", tone: "info" },
  completed: { label: "Completed", tone: "success" },
  completed_with_warnings: { label: "Completed with warnings", tone: "warning" },
  partial: { label: "Partial", tone: "warning" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral" },
} as const;
export type DocumentState = keyof typeof DOCUMENT_STATES;

/** The state shown to users, from the persisted job status, stage and outcome. */
export function documentState(d: {
  parseStatus: string;
  stage?: string | null;
  outcome?: string | null;
}): DocumentState {
  switch (d.parseStatus) {
    case "pending":
      return "queued";
    case "parsing":
      return d.stage === "indexing" ? "indexing" : "extracting";
    case "parsed":
      return d.outcome === "partial" || d.outcome === "completed_with_warnings"
        ? d.outcome
        : "completed";
    case "cancelled":
      return "cancelled";
    default:
      return "failed";
  }
}
