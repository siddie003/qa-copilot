import {
  designSpecSchema,
  emptyDesignSpec,
  TYPOGRAPHY_ROLES,
  type DesignSpec,
  type TokenSource,
  type TypographyRole,
  type TypographyToken,
} from "@qa/core";
import type { ExtractedBlock } from "./extract/blocks";
import { colorRoleForName, rgbaToHex, tokenName } from "./roles";

/**
 * Deterministic extraction of design values from a brand-guideline document. Only values written
 * literally in the document are read (hex/rgb colors with their labels, font names, sizes,
 * weights, line heights); each one cites the document, page/line and the exact text. The result
 * is a draft: it becomes active only after the user reviews and confirms it.
 */

export interface GuidelineReport {
  extracted: string[];
  /** Lines that mention design values but could not be read unambiguously. */
  skipped: string[];
}

const WEIGHTS: Array<[RegExp, number]> = [
  [/\b(thin|hairline)\b/i, 100],
  [/\b(extra[\s-]?light|ultra[\s-]?light)\b/i, 200],
  [/\blight\b/i, 300],
  [/\b(regular|normal|book|roman)\b/i, 400],
  [/\bmedium\b/i, 500],
  [/\b(semi[\s-]?bold|demi[\s-]?bold)\b/i, 600],
  [/\b(extra[\s-]?bold|ultra[\s-]?bold)\b/i, 800],
  [/\bbold\b/i, 700],
  [/\b(black|heavy)\b/i, 900],
];

const ROLE_PREFIX =
  /^\s*(h[1-6]|heading\s*[1-6]|headline\s*[1-6]|body(?:\s*(?:text|copy))?|paragraph(?:\s*text)?|links?|buttons?(?:\s*text)?)\b\s*[:\-–—|]?\s*/i;

function roleFrom(prefix: string): TypographyRole | null {
  const p = prefix.toLowerCase();
  const h = p.match(/([1-6])/);
  if (/^(h|heading|headline)/.test(p) && h) return `h${h[1]}` as TypographyRole;
  if (/^(body|paragraph)/.test(p)) return "body";
  if (/^link/.test(p)) return "link";
  if (/^button/.test(p)) return "button";
  return null;
}

const toPx = (value: string, unit: string) => {
  const n = Number(value);
  return Math.round((unit.toLowerCase() === "pt" ? (n * 96) / 72 : n) * 100) / 100;
};

function weightOf(text: string): number | undefined {
  for (const [re, w] of WEIGHTS) if (re.test(text)) return w;
  const numeric = text.match(/\b([1-9]00)\b(?!\s*(?:px|pt|%))/);
  return numeric ? Number(numeric[1]) : undefined;
}

const HEX = /#([0-9a-f]{6}|[0-9a-f]{3})\b/gi;
const RGB = /\brgb\s*\(?\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*\)?/i;

function hexOf(text: string): string | null {
  const h = text.match(/#([0-9a-f]{6}|[0-9a-f]{3})\b/i);
  if (h) {
    const v = h[1]!.toLowerCase();
    return `#${v.length === 3 ? [...v].map((c) => c + c).join("") : v}`;
  }
  const rgb = text.match(RGB);
  if (rgb && [rgb[1], rgb[2], rgb[3]].every((x) => Number(x) <= 255))
    return rgbaToHex(Number(rgb[1]) / 255, Number(rgb[2]) / 255, Number(rgb[3]) / 255);
  return null;
}

const FONT_LINE =
  /\b(primary|heading|headline|display|body|text)?\s*(?:font(?:\s*family)?|typeface)\s*[:\-–—]\s*["“]?([A-Za-z][A-Za-z0-9 ]{1,40}?)["”]?\s*(?:[,;(]|$)/i;

export function extractGuidelineDraft(
  blocks: ExtractedBlock[],
  doc: { referenceId: string; filename: string },
): { spec: DesignSpec; report: GuidelineReport } {
  const spec = emptyDesignSpec();
  const report: GuidelineReport = { extracted: [], skipped: [] };
  const usedRoles = new Set<string>();
  const families: Array<{ scope: string; family: string; source: TokenSource }> = [];

  const sourceFor = (b: ExtractedBlock, excerpt: string): TokenSource => ({
    type: "document",
    referenceId: doc.referenceId,
    filename: doc.filename.slice(0, 255),
    ...(b.location.page ? { page: b.location.page } : {}),
    ...(b.location.line ? { line: b.location.line } : {}),
    excerpt: excerpt.slice(0, 300),
  });

  for (const b of blocks) {
    const line = b.text;
    // Global font declarations: "Primary font: Inter", "Heading typeface – Playfair Display".
    const font = line.match(FONT_LINE);
    if (font && !ROLE_PREFIX.test(line)) {
      families.push({
        scope: (font[1] ?? "primary").toLowerCase(),
        family: font[2]!.trim(),
        source: sourceFor(b, line),
      });
      report.extracted.push(`font “${font[2]!.trim()}” (${font[1] ?? "primary"})`);
      continue;
    }

    // Typography lines: "H1 — Playfair Display Bold, 48px / 56px".
    const prefix = line.match(ROLE_PREFIX);
    const role = prefix ? roleFrom(prefix[1]!) : null;
    if (role && /\d\s*(px|pt)\b|#[0-9a-f]{3,6}\b|\b(bold|regular|light|medium)\b/i.test(line)) {
      const rest = line.slice(prefix![0].length);
      const sizes = [...rest.matchAll(/(\d+(?:\.\d+)?)\s*(px|pt)\b/gi)];
      const token: TypographyToken = { source: sourceFor(b, line) };
      const lh = rest.match(/(?:\/|line[\s-]?height\s*:?)\s*(\d+(?:\.\d+)?)\s*(px|pt)\b/i);
      const ls = rest.match(
        /(?:letter[\s-]?spacing|tracking)\s*:?\s*(-?\d+(?:\.\d+)?)\s*(px|pt)\b/i,
      );
      const first = sizes.find((s) => s.index !== lh?.index && s.index !== ls?.index);
      if (first) token.fontSize = toPx(first[1]!, first[2]!);
      if (lh) token.lineHeight = toPx(lh[1]!, lh[2]!);
      if (ls) token.letterSpacing = toPx(ls[1]!, ls[2]!);
      const w = weightOf(rest);
      if (w) token.fontWeight = w;
      const color = hexOf(rest);
      if (color) token.color = color;
      // Family = the words before the weight keyword or the first number.
      const familyPart = rest
        .split(/,|\(|\d|#/)[0]!
        .replace(new RegExp(WEIGHTS.map(([re]) => re.source).join("|"), "gi"), "")
        .replace(/\b(font|family|typeface|size|weight|text|style)\b/gi, "")
        .trim();
      if (/^[A-Za-z][A-Za-z ]{1,40}$/.test(familyPart)) token.fontFamily = familyPart;
      if (Object.keys(token).length > 1) {
        spec.typography[role] = { ...spec.typography[role], ...token };
        report.extracted.push(`${role}: “${line.slice(0, 80)}”`);
      } else report.skipped.push(`“${line.slice(0, 80)}”: no size, weight or color found`);
      continue;
    }

    // Colors: every hex/rgb value with the label written before it.
    const hexes = [...line.matchAll(HEX)];
    const rgb = hexes.length ? null : line.match(RGB);
    if (!hexes.length && !rgb) continue;
    const entries = hexes.length
      ? hexes.map((m, i) => ({
          value: hexOf(m[0])!,
          label: line.slice(i === 0 ? 0 : hexes[i - 1]!.index! + hexes[i - 1]![0].length, m.index),
        }))
      : [{ value: hexOf(rgb![0])!, label: line.slice(0, rgb!.index) }];
    for (const e of entries) {
      const label = e.label
        .replace(/\b(hex|rgb|cmyk|pantone|color|colour)\b\s*:?/gi, " ")
        .replace(/[:\-–—|=•,]+\s*$/, "")
        .replace(/^[\s:\-–—|=•,]+/, "")
        .trim();
      const name = tokenName(label || `Color ${e.value.slice(1)}`, `Color ${e.value.slice(1)}`);
      if (spec.colors[name]) {
        report.skipped.push(`Color “${name}” appears more than once; the first value was kept`);
        continue;
      }
      // Roles are read from the label as written ("Text color" → body text color).
      const written = e.label.replace(/[:\-–—|=•,]+\s*$/, "").trim();
      const role = written ? colorRoleForName(written) : null;
      const assign = role && !usedRoles.has(role) ? role : undefined;
      if (assign) usedRoles.add(assign);
      spec.colors[name] = {
        value: e.value,
        ...(assign ? { role: assign } : {}),
        source: sourceFor(b, line),
      };
      report.extracted.push(`color “${name}” ${e.value}${assign ? ` (${assign})` : ""}`);
    }
  }

  // Apply global font families to roles that have no family of their own.
  for (const f of families) {
    const roles = TYPOGRAPHY_ROLES.filter((r) =>
      ["heading", "headline", "display"].includes(f.scope)
        ? /^h[1-6]$/.test(r)
        : ["body", "text"].includes(f.scope)
          ? r === "body" || r === "link"
          : true,
    );
    for (const r of roles) {
      const t = spec.typography[r];
      if (t?.fontFamily) continue;
      // A family alone is applied only to roles the document also describes, or to body text.
      if (!t && r !== "body" && !/^h1$/.test(r)) continue;
      // Both lines are cited when the family comes from a separate font declaration.
      spec.typography[r] = t
        ? {
            ...t,
            fontFamily: f.family,
            source: {
              ...t.source,
              excerpt: `${t.source.excerpt ?? ""} | ${f.source.excerpt ?? ""}`.slice(0, 300),
            },
          }
        : { source: f.source, fontFamily: f.family };
    }
  }

  return { spec: designSpecSchema.parse(spec), report };
}
