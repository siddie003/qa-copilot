import { canonicalText, normalizeText, type ContentBlockType } from "@qa/core";

export interface BlockLocation {
  /** 1-based page number (PDF). */
  page?: number;
  /** 1-based source line (TXT, Markdown). */
  line?: number;
  /** Position among the document's blocks. */
  index: number;
  /** Headings above this block, outermost first. */
  headingPath?: string[];
}

export interface ExtractedBlock {
  type: ContentBlockType;
  level: number | null;
  text: string;
  normalizedText: string;
  href: string | null;
  /** Website page this block belongs to, from a "Page: About" / "URL: /about" marker. */
  pageHint: string | null;
  location: BlockLocation;
}

export interface ExtractionResult {
  blocks: ExtractedBlock[];
  meta: { pages?: number; warnings: string[]; truncated: boolean };
}

export class ExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractionError";
  }
}

export const MAX_BLOCKS = 5_000;
const MAX_BLOCK_CHARS = 5_000;

const MARKER = /^(?:page|url|web\s*page|screen)\s*[:=]\s*([^.!?]{1,80})$/i;
const COMMENT_MARKER = /^<!--\s*(?:page|url)\s*[:=]\s*(.{1,200}?)\s*-->$/i;
const CTA = /^(?:cta|button|call\s*to\s*action)\s*[:=]\s*(.+)$/i;
/** Trailing link target written in plain text: "Get started → /signup", "Buy now (https://…)". */
const ARROW_HREF =
  /\s*(?:→|->|=>|\||–>)\s*(\S+)\s*$|\s*\((\/\S*|https?:\/\/\S+)\)\s*$|\s*\[(\/\S*|https?:\/\/\S+)\]\s*$/;

/** Detects a page marker ("Page: About", "URL: /about", `<!-- page: /about -->`). */
export function parsePageMarker(text: string): string | null {
  const t = canonicalText(text);
  const m = t.match(COMMENT_MARKER) ?? t.match(MARKER);
  return m ? m[1]!.trim() : null;
}

/** Lines that must stay on their own (never merged into a paragraph): page markers and CTAs. */
export function isStandaloneLine(text: string): boolean {
  return parsePageMarker(text) !== null || CTA.test(canonicalText(text));
}

/** Detects a CTA line ("CTA: Get started → /signup"); returns its text and href. */
export function parseCta(
  text: string,
  href: string | null = null,
): { text: string; href: string | null } | null {
  const m = canonicalText(text).match(CTA);
  if (!m) return null;
  let label = m[1]!.trim();
  let target = href;
  const arrow = label.match(ARROW_HREF);
  if (arrow) {
    target ??= arrow[1] ?? arrow[2] ?? arrow[3] ?? null;
    label = label.slice(0, arrow.index).trim();
  }
  label = label.replace(/^["'[]|["'\]]$/g, "").trim();
  return label ? { text: label, href: target } : null;
}

export function safeHref(href: string | null | undefined): string | null {
  if (!href) return null;
  const h = href.trim();
  if (/^(https?:\/\/|\/|#|mailto:|tel:)/i.test(h) && h.length <= 2000) return h;
  return null;
}

/** Collects blocks in document order, tracking page markers and the heading path. */
export class BlockCollector {
  readonly blocks: ExtractedBlock[] = [];
  readonly warnings: string[] = [];
  truncated = false;
  private pageHint: string | null = null;
  private headings: Array<{ level: number; text: string }> = [];

  /** Returns true if the text was a page marker (consumed, not stored as content). */
  marker(text: string): boolean {
    const hint = parsePageMarker(text);
    if (hint === null) return false;
    this.pageHint = hint;
    this.headings = [];
    return true;
  }

  add(
    type: ContentBlockType,
    rawText: string,
    opts: { level?: number | null; href?: string | null; page?: number; line?: number } = {},
  ) {
    let text = canonicalText(rawText);
    if (!text) return;
    if (this.blocks.length >= MAX_BLOCKS) {
      this.truncated = true;
      return;
    }
    if (text.length > MAX_BLOCK_CHARS) {
      text = text.slice(0, MAX_BLOCK_CHARS);
      if (this.warnings.length < 20)
        this.warnings.push(`A block longer than ${MAX_BLOCK_CHARS} characters was shortened.`);
    }
    const level = opts.level ?? null;
    if (type === "heading" && level !== null) {
      this.headings = this.headings.filter((h) => h.level < level);
    }
    this.blocks.push({
      type,
      level,
      text,
      normalizedText: normalizeText(text),
      href: safeHref(opts.href),
      pageHint: this.pageHint,
      location: {
        index: this.blocks.length,
        ...(opts.page ? { page: opts.page } : {}),
        ...(opts.line ? { line: opts.line } : {}),
        ...(this.headings.length ? { headingPath: this.headings.map((h) => h.text) } : {}),
      },
    });
    if (type === "heading" && level !== null) this.headings.push({ level, text });
  }

  /** Adds a paragraph-like text, recognizing markers and CTA lines. */
  addText(
    rawText: string,
    opts: { href?: string | null; page?: number; line?: number; linkOnly?: boolean } = {},
  ) {
    if (this.marker(rawText)) return;
    const cta = parseCta(rawText, opts.href ?? null);
    if (cta) return this.add("cta", cta.text, { href: cta.href, page: opts.page, line: opts.line });
    this.add(opts.linkOnly ? "link" : "paragraph", rawText, {
      href: opts.linkOnly ? (opts.href ?? null) : null,
      page: opts.page,
      line: opts.line,
    });
  }

  result(pages?: number): ExtractionResult {
    if (this.truncated)
      this.warnings.push(`Only the first ${MAX_BLOCKS} blocks of the document were kept.`);
    return {
      blocks: this.blocks,
      meta: { ...(pages ? { pages } : {}), warnings: this.warnings, truncated: this.truncated },
    };
  }
}
