import { TOKEN_NAME_PATTERN, type ColorRole, type TypographyRole } from "@qa/core";

/**
 * Name-based mapping of design style names ("Heading/H1", "Text/Primary") to website roles.
 * Only clear, conventional names are mapped; anything ambiguous stays unmapped (reported as
 * skipped) rather than guessed.
 */
export function typographyRoleForName(name: string): TypographyRole | null {
  const n = ` ${name.toLowerCase().replace(/[/_\-.,|]+/g, " ")} `;
  const h = n.match(/\s(?:h|heading\s?|headline\s?)([1-6])\s/);
  if (h) return `h${h[1]}` as TypographyRole;
  if (/\s(caption|small|overline|label|footnote|xxs|xs|sm)\s/.test(n)) return null;
  // Link and button names win over "body": libraries often group them as "Body/CTA" or "Body/Link".
  if (/\slinks?\s/.test(n)) return "link";
  if (/\s(button|btn|cta)\s/.test(n)) return "button";
  if (/\s(body|paragraph|copy)\s/.test(n)) return "body";
  return null;
}

/** Preference among several styles mapped to the same role (e.g. Body/Large vs Body/Regular). */
export function roleNamePreference(name: string): number {
  return /regular|default|base|\bmd\b|medium|normal|\bm\b/i.test(name) ? 1 : 0;
}

export function colorRoleForName(name: string): ColorRole | null {
  const n = ` ${name.toLowerCase().replace(/[/_\-.,|]+/g, " ")} `;
  if (/\s(button|btn|cta|card|badge|border|stroke|icon|shadow)\s/.test(n)) return null;
  if (/\slinks?\s/.test(n)) return "link";
  if (/\sheader\s/.test(n) && !/\s(text|foreground|fg)\s/.test(n)) return "headerBackground";
  if (/\sfooter\s/.test(n) && !/\s(text|foreground|fg)\s/.test(n)) return "footerBackground";
  if (/\s(text|foreground|fg)\s/.test(n) && /\s(primary|default|base|body|main)\s/.test(n))
    return "text";
  if (/\s(body text|text color)\s/.test(n)) return "text";
  if (/\s(background|bg|page|canvas)\s/.test(n) && !/\s(secondary|alt|muted|dark)\s/.test(n))
    return "background";
  return null;
}

/** Turns an arbitrary style/label name into a valid DesignSpec color token name. */
export function tokenName(raw: string, fallback: string): string {
  const cleaned = raw
    .replace(/[^A-Za-z0-9 _./()-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 64)
    .trim();
  return TOKEN_NAME_PATTERN.test(cleaned) ? cleaned : fallback;
}

/** Figma/CSS RGBA (0..1 channels) → lowercase hex (#rrggbb, or #rrggbbaa when translucent). */
export function rgbaToHex(r: number, g: number, b: number, a = 1): string {
  const h = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}${a < 0.999 ? h(a) : ""}`;
}
