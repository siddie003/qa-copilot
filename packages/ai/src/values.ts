/**
 * Checkable facts in free text: numbers (with units), colors, URLs, site paths, quoted text and
 * finding ids. Grounding requires every such token in AI-written text to be supported by the
 * corpus of the issue (its findings, evidence, counts, rule guidance and design reference).
 * Prose without such tokens cannot be checked this way; claims add a second, cited check.
 */

export interface NumberToken {
  raw: string;
  value: number;
  decimals: number;
}

export interface FactTokens {
  numbers: NumberToken[];
  colors: Array<{ raw: string; hex: string }>;
  urls: Array<{ raw: string; normalized: string }>;
  paths: string[];
  quotes: Array<{ raw: string; normalized: string }>;
  findingIds: string[];
}

const URL_RE = /\bhttps?:\/\/[^\s<>"'“”‘’`)\]}]+/gi;
const HEX_RE = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![0-9a-z])/gi;
const RGB_RE =
  /\brgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})(?:\s*[,/]\s*([\d.]+%?))?\s*\)/gi;
/** Finding id prefixes of the scanners (Scanner.idPrefix); ids in AI text must exist in the issue. */
export const FINDING_ID_PREFIXES = ["A11Y", "SEC", "SEO", "LNK", "PERF", "RSP", "DSN", "CNT"];
const FINDING_ID_RE = new RegExp(`\\b(?:${FINDING_ID_PREFIXES.join("|")})-\\d{3,}\\b`, "g");
const CODE_RE = /`[^`\n]*`/g;
const QUOTE_RES = [
  /“([^“”\n]{2,300})”/g,
  /"([^"\n]{2,300})"/g,
  /‘([^‘’\n]{2,300})’/g,
  /(?<![\p{L}\p{N}])'([^'\n]{2,300})'(?![\p{L}\p{N}])/gu,
];
const PATH_RE = /(?<![\p{L}\p{N}_.:/\\-])\/[A-Za-z0-9][\w\-./%~]*/gu;
// A number with an optional unit, not part of a word, version string, id or path.
const NUMBER_RE =
  /(?<![\p{L}\p{N}_#./:\\-])(-?)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?:\s?(?:px|rem|em|ms|s|kb|mb|gb|b|pt|%|x|×|°))?(?![\p{L}\p{N}_]|[.,]\d)/giu;

const trimUrl = (u: string) => u.replace(/[.,;:!?]+$/, "");

export function normalizeUrl(raw: string): string {
  const u = trimUrl(raw);
  try {
    const parsed = new URL(u);
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return u.replace(/\/$/, "").toLowerCase();
  }
}

/** Lowercase, typographic quotes/dashes unified, whitespace collapsed, edge punctuation trimmed. */
export function normalizeFact(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[“”„″]/g, '"')
    .replace(/[‘’‚′]/g, "'")
    .replace(/[‐‑‒–—―−]/g, "-")
    .replace(/…/g, "...")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[\s"'.,;:!?]+|[\s"'.,;:!?]+$/g, "");
}

export function hexOf(raw: string): string | null {
  const h = raw.replace(/^#/, "").toLowerCase();
  if (!/^[0-9a-f]+$/.test(h)) return null;
  const full =
    h.length === 3 || h.length === 4
      ? [...h].map((c) => c + c).join("")
      : h.length === 6 || h.length === 8
        ? h
        : null;
  if (!full) return null;
  return `#${full.length === 8 && full.endsWith("ff") ? full.slice(0, 6) : full}`;
}

function rgbHex(r: string, g: string, b: string, a?: string): string | null {
  const parts = [r, g, b].map(Number);
  if (parts.some((x) => x > 255)) return null;
  const hex = `#${parts.map((x) => x.toString(16).padStart(2, "0")).join("")}`;
  if (a === undefined) return hex;
  const alpha = a.endsWith("%") ? Number(a.slice(0, -1)) / 100 : Number(a);
  if (!Number.isFinite(alpha) || alpha >= 1) return hex;
  return `${hex}${Math.round(alpha * 255)
    .toString(16)
    .padStart(2, "0")}`;
}

function parseNumber(m: RegExpMatchArray): NumberToken {
  const int = m[2]!.replace(/,/g, "");
  const frac = m[3] ?? "";
  return {
    raw: m[0],
    value: Number(`${m[1]}${int}${frac ? `.${frac}` : ""}`),
    decimals: frac.length,
  };
}

/** Extracts the checkable facts of a text. Each token kind is removed before the next is read. */
export function extractFacts(text: string): FactTokens {
  let rest = text;
  const blank = (s: string) => " ".repeat(s.length);
  const urls: FactTokens["urls"] = [];
  rest = rest.replace(URL_RE, (u) => {
    urls.push({ raw: trimUrl(u), normalized: normalizeUrl(u) });
    return blank(u);
  });
  const findingIds: string[] = [];
  rest = rest.replace(FINDING_ID_RE, (id) => {
    findingIds.push(id);
    return blank(id);
  });
  const colors: FactTokens["colors"] = [];
  rest = rest.replace(RGB_RE, (all, r: string, g: string, b: string, a?: string) => {
    const hex = rgbHex(r, g, b, a);
    if (hex) colors.push({ raw: all, hex });
    return blank(all);
  });
  rest = rest.replace(HEX_RE, (all) => {
    const hex = hexOf(all);
    if (hex) colors.push({ raw: all, hex });
    return blank(all);
  });
  // Quoted text (outside code spans) must appear verbatim in the evidence.
  const quotes: FactTokens["quotes"] = [];
  const prose = rest.replace(CODE_RE, blank);
  for (const re of QUOTE_RES)
    for (const m of prose.matchAll(re)) {
      const normalized = normalizeFact(m[1]!);
      if (normalized.length >= 2 && !quotes.some((q) => q.normalized === normalized))
        quotes.push({ raw: m[0], normalized });
    }
  const paths: string[] = [];
  rest = rest.replace(PATH_RE, (p) => {
    const clean = p.replace(/[.,;:!?]+$/, "");
    if (clean.length > 1) paths.push(clean);
    return blank(p);
  });
  const numbers = [...rest.matchAll(NUMBER_RE)].map(parseNumber);
  return { numbers, colors, urls, paths, quotes, findingIds };
}

/** Everything an issue's text may draw on, indexed for fact checks. */
export interface Corpus {
  /** Normalized text of all string values and keys. */
  text: string;
  numbers: number[];
  colors: Set<string>;
  urls: Set<string>;
  findingIds: Set<string>;
}

/** Builds a corpus from arbitrary values (strings, numbers, nested objects and arrays). */
export function buildCorpus(values: unknown[], findingIds: Iterable<string> = []): Corpus {
  const strings: string[] = [];
  const numbers = new Set<number>();
  const visit = (v: unknown, depth: number) => {
    if (depth > 12 || v === null || v === undefined) return;
    if (typeof v === "string") strings.push(v);
    else if (typeof v === "number") {
      if (Number.isFinite(v)) numbers.add(v);
    } else if (Array.isArray(v)) for (const x of v) visit(x, depth + 1);
    else if (typeof v === "object")
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        strings.push(k);
        visit(x, depth + 1);
      }
  };
  for (const v of values) visit(v, 0);
  const colors = new Set<string>();
  const urls = new Set<string>();
  for (const s of strings) {
    const facts = extractFacts(s);
    for (const n of facts.numbers) numbers.add(n.value);
    for (const c of facts.colors) colors.add(c.hex);
    for (const u of facts.urls) urls.add(u.normalized);
  }
  return {
    text: normalizeFact(strings.join("\n")),
    numbers: [...numbers],
    colors,
    urls,
    findingIds: new Set(findingIds),
  };
}

const decimalsOf = (n: number) => {
  const s = String(n);
  const i = s.indexOf(".");
  return i === -1 || /e/i.test(s) ? 0 : s.length - i - 1;
};

/**
 * A number is supported when the corpus contains it, or a more precise value that rounds to it
 * (4232 for 4231.6, 3.3 for 3.27). Small values are not rounded to integers ("5" is not
 * supported by 4.5), so a rounded claim cannot change a threshold.
 */
export function numberSupported(t: NumberToken, corpus: Corpus): boolean {
  for (const c of corpus.numbers) {
    if (c === t.value) return true;
    if (decimalsOf(c) > t.decimals && (t.decimals > 0 || Math.abs(c) >= 10)) {
      const f = 10 ** t.decimals;
      if (Math.round(c * f) / f === t.value) return true;
    }
  }
  return false;
}

/** The tokens of `text` that the corpus does not support (raw strings, for the check detail). */
export function unsupportedFacts(text: string, corpus: Corpus): string[] {
  const f = extractFacts(text);
  const bad: string[] = [];
  for (const u of f.urls) if (!corpus.urls.has(u.normalized)) bad.push(u.raw);
  for (const id of f.findingIds) if (!corpus.findingIds.has(id)) bad.push(id);
  for (const c of f.colors) if (!corpus.colors.has(c.hex)) bad.push(c.raw);
  for (const p of f.paths) if (!corpus.text.includes(p.toLowerCase())) bad.push(p);
  for (const q of f.quotes) if (!corpus.text.includes(q.normalized)) bad.push(q.raw);
  for (const n of f.numbers) if (!numberSupported(n, corpus)) bad.push(n.raw.trim());
  return [...new Set(bad)];
}

export function countFacts(text: string): number {
  const f = extractFacts(text);
  return (
    f.urls.length +
    f.findingIds.length +
    f.colors.length +
    f.paths.length +
    f.quotes.length +
    f.numbers.length
  );
}
