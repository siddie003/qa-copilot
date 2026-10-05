import { z } from "zod";

/**
 * DesignSpec: the normalized design/brand reference a website is compared against. Every token
 * carries its provenance (Figma node, document citation or manual entry), so no value ever
 * appears without a traceable source. Browser-safe (used by the editor UI, API and worker).
 */

/** Text roles that can be mapped to website elements. */
export const TYPOGRAPHY_ROLES = [
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "body",
  "link",
  "button",
] as const;
export type TypographyRole = (typeof TYPOGRAPHY_ROLES)[number];

export const TYPOGRAPHY_ROLE_LABELS: Record<TypographyRole, string> = {
  h1: "Heading 1",
  h2: "Heading 2",
  h3: "Heading 3",
  h4: "Heading 4",
  h5: "Heading 5",
  h6: "Heading 6",
  body: "Body text",
  link: "Links",
  button: "Button text",
};

/** Where a palette color is expected to appear on the website (optional binding). */
export const COLOR_ROLES = [
  "text",
  "background",
  "link",
  "headerBackground",
  "footerBackground",
] as const;
export type ColorRole = (typeof COLOR_ROLES)[number];

export const COLOR_ROLE_LABELS: Record<ColorRole, string> = {
  text: "Body text color",
  background: "Page background",
  link: "Link color",
  headerBackground: "Header background",
  footerBackground: "Footer background",
};

export const COMPONENT_KEYS = ["buttonPrimary", "buttonSecondary"] as const;
export type ComponentKey = (typeof COMPONENT_KEYS)[number];

export const COMPONENT_LABELS: Record<ComponentKey, string> = {
  buttonPrimary: "Primary button",
  buttonSecondary: "Secondary button",
};

/** Accepts #rgb, #rgba, #rrggbb, #rrggbbaa; stores lowercase #rrggbb or #rrggbbaa. */
export const hexColorSchema = z
  .string()
  .trim()
  .regex(/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i, "use a hex color such as #1A56DB")
  .transform((v) => {
    const h = v.slice(1).toLowerCase();
    return h.length <= 4
      ? `#${[...h].map((c) => c + c).join("")}`.replace(/^(#[0-9a-f]{6})ff$/, "$1")
      : `#${h}`.replace(/^(#[0-9a-f]{6})ff$/, "$1");
  });

export const tokenSourceSchema = z.object({
  type: z.enum(["figma", "manual", "document"]),
  /** Figma: file key, node id and style/component name the value was read from. */
  fileKey: z.string().max(128).optional(),
  nodeId: z.string().max(64).optional(),
  name: z.string().max(200).optional(),
  /** Document: reference id, file name, page number and the exact text the value came from. */
  referenceId: z.string().max(64).optional(),
  filename: z.string().max(255).optional(),
  page: z.number().int().min(1).optional(),
  line: z.number().int().min(1).optional(),
  excerpt: z.string().max(300).optional(),
  /** "ai": read with AI assistance and verified against the cited text (absent: read literally). */
  method: z.enum(["ai"]).optional(),
});
export type TokenSource = z.infer<typeof tokenSourceSchema>;

const MANUAL: TokenSource = { type: "manual" };
const source = tokenSourceSchema.default(MANUAL);
const px = (min: number, max: number) => z.number().finite().min(min).max(max);
/** Optional CSS selector that maps the token to website elements explicitly (highest confidence). */
const selector = z.string().trim().min(1).max(300).optional();
/**
 * Viewports a size-dependent value (font size, spacing, width) is compared at: "widest" (default,
 * designs are usually desktop-first) or "all".
 */
const scope = z.enum(["widest", "all"]).optional();

export const typographyTokenSchema = z.object({
  fontFamily: z.string().trim().min(1).max(100).optional(),
  fontSize: px(1, 400).optional(),
  fontWeight: z.number().int().min(1).max(1000).optional(),
  lineHeight: px(0, 800).optional(),
  letterSpacing: px(-50, 50).optional(),
  color: hexColorSchema.optional(),
  selector,
  scope,
  source,
});
export type TypographyToken = z.infer<typeof typographyTokenSchema>;

export const colorTokenSchema = z.object({
  value: hexColorSchema,
  role: z.enum(COLOR_ROLES).optional(),
  source,
});
export type ColorToken = z.infer<typeof colorTokenSchema>;

export const componentTokenSchema = z.object({
  background: hexColorSchema.optional(),
  color: hexColorSchema.optional(),
  borderRadius: px(0, 500).optional(),
  paddingX: px(0, 500).optional(),
  paddingY: px(0, 500).optional(),
  fontSize: px(1, 400).optional(),
  fontWeight: z.number().int().min(1).max(1000).optional(),
  selector,
  scope,
  source,
});
export type ComponentToken = z.infer<typeof componentTokenSchema>;

export const TOKEN_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _./()-]{0,63}$/;

export const designSpecSchema = z.object({
  colors: z
    .record(
      z
        .string()
        .regex(TOKEN_NAME_PATTERN, "color names use letters, digits, spaces and . _ / - ( )"),
      colorTokenSchema,
    )
    .refine((r) => Object.keys(r).length <= 200, "at most 200 colors")
    .default({}),
  typography: z.partialRecord(z.enum(TYPOGRAPHY_ROLES), typographyTokenSchema).default({}),
  components: z.partialRecord(z.enum(COMPONENT_KEYS), componentTokenSchema).default({}),
  layout: z
    .object({
      containerMaxWidth: z.object({ value: px(100, 10_000), selector, source }).optional(),
    })
    .default({}),
  spacing: z
    .object({
      scale: z
        .object({
          values: z.array(px(0, 1000)).min(1).max(40),
          source,
        })
        .optional(),
    })
    .default({}),
});
export type DesignSpec = z.infer<typeof designSpecSchema>;

export const emptyDesignSpec = (): DesignSpec => ({
  colors: {},
  typography: {},
  components: {},
  layout: {},
  spacing: {},
});

const VALUE_KEYS = new Set([
  "fontFamily",
  "fontSize",
  "fontWeight",
  "lineHeight",
  "letterSpacing",
  "color",
  "background",
  "borderRadius",
  "paddingX",
  "paddingY",
  "value",
  "values",
]);

/** Flattens a spec into comparable values: "typography.h1.fontSize" → 48. */
export function flattenSpec(
  spec: DesignSpec,
): Map<string, { value: unknown; source: TokenSource }> {
  const out = new Map<string, { value: unknown; source: TokenSource }>();
  const visit = (prefix: string, token: Record<string, unknown> & { source?: TokenSource }) => {
    for (const [k, v] of Object.entries(token))
      if (VALUE_KEYS.has(k) && v !== undefined)
        out.set(`${prefix}.${k}`, { value: v, source: token.source ?? MANUAL });
    if (token.role !== undefined)
      out.set(`${prefix}.role`, { value: token.role, source: token.source ?? MANUAL });
    if (token.selector !== undefined)
      out.set(`${prefix}.selector`, { value: token.selector, source: token.source ?? MANUAL });
  };
  for (const [name, t] of Object.entries(spec.colors)) visit(`colors.${name}`, t);
  for (const [role, t] of Object.entries(spec.typography)) if (t) visit(`typography.${role}`, t);
  for (const [key, t] of Object.entries(spec.components)) if (t) visit(`components.${key}`, t);
  if (spec.layout.containerMaxWidth)
    visit("layout.containerMaxWidth", spec.layout.containerMaxWidth);
  if (spec.spacing.scale) visit("spacing.scale", spec.spacing.scale);
  return out;
}

/** Number of concrete values in a spec (for summaries). */
export function countSpecValues(spec: DesignSpec): number {
  let n = 0;
  for (const k of flattenSpec(spec).keys()) if (!/\.(role|selector)$/.test(k)) n += 1;
  return n;
}

export interface SpecChange {
  path: string;
  before: unknown;
  after: unknown;
  source: TokenSource | null;
}

/** Value-level differences between two specs (used to review a draft before confirming it). */
export function diffSpecs(before: DesignSpec, after: DesignSpec): SpecChange[] {
  const a = flattenSpec(before);
  const b = flattenSpec(after);
  const changes: SpecChange[] = [];
  for (const path of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(path);
    const y = b.get(path);
    if (JSON.stringify(x?.value) === JSON.stringify(y?.value)) continue;
    changes.push({
      path,
      before: x?.value ?? null,
      after: y?.value ?? null,
      source: y?.source ?? x?.source ?? null,
    });
  }
  return changes.sort((p, q) => p.path.localeCompare(q.path));
}

/**
 * Whether an automatically extracted value may replace an existing token. Values the user
 * entered manually are never overwritten by extraction; Figma values replace Figma and document
 * values; document values only replace other document values.
 */
function mayReplace(existing: TokenSource | undefined, incoming: TokenSource): boolean {
  if (!existing) return true;
  if (existing.type === "manual") return false;
  if (incoming.type === "figma") return true;
  return existing.type === "document" && incoming.type === "document";
}

/**
 * Merges extracted tokens into a base spec, token by token, respecting `mayReplace`.
 * Pure: returns a new spec.
 */
export function mergeExtracted(base: DesignSpec, extracted: DesignSpec): DesignSpec {
  const out: DesignSpec = structuredClone(base);
  for (const [name, t] of Object.entries(extracted.colors)) {
    const existing = out.colors[name];
    if (mayReplace(existing?.source, t.source)) out.colors[name] = t;
  }
  for (const role of TYPOGRAPHY_ROLES) {
    const t = extracted.typography[role];
    if (t && mayReplace(out.typography[role]?.source, t.source)) out.typography[role] = t;
  }
  for (const key of COMPONENT_KEYS) {
    const t = extracted.components[key];
    if (t && mayReplace(out.components[key]?.source, t.source)) out.components[key] = t;
  }
  const c = extracted.layout.containerMaxWidth;
  if (c && mayReplace(out.layout.containerMaxWidth?.source, c.source))
    out.layout.containerMaxWidth = c;
  const s = extracted.spacing.scale;
  if (s && mayReplace(out.spacing.scale?.source, s.source)) out.spacing.scale = s;
  // A palette role belongs to one color only: the most recently merged color keeps it.
  const seen = new Set<string>();
  for (const [name, t] of Object.entries(out.colors).reverse()) {
    if (!t.role) continue;
    if (seen.has(t.role)) out.colors[name] = { ...t, role: undefined };
    else seen.add(t.role);
  }
  return out;
}

/** Explicit CSS selectors used by the spec (the browser collects styles for these). */
export function specSelectors(spec: DesignSpec): string[] {
  const list = [
    ...Object.values(spec.typography).map((t) => t?.selector),
    ...Object.values(spec.components).map((t) => t?.selector),
    spec.layout.containerMaxWidth?.selector,
  ];
  return [...new Set(list.filter((s): s is string => Boolean(s)))];
}

/** Human-readable description of where a value came from. */
export function describeSource(s: TokenSource | null | undefined): string {
  if (!s) return "unknown source";
  if (s.type === "manual") return "entered manually";
  if (s.type === "figma")
    return `Figma${s.name ? ` “${s.name}”` : ""}${s.nodeId ? ` (node ${s.nodeId})` : ""}`;
  return `${s.filename ?? "document"}${s.page ? `, page ${s.page}` : ""}${s.line ? `, line ${s.line}` : ""}${s.excerpt ? `: “${s.excerpt}”` : ""}${s.method === "ai" ? " (read with AI assistance)" : ""}`;
}
