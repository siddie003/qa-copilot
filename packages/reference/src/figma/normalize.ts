import {
  designSpecSchema,
  emptyDesignSpec,
  type ComponentKey,
  type ComponentToken,
  type DesignSpec,
  type TokenSource,
  type TypographyRole,
  type TypographyToken,
} from "@qa/core";
import {
  colorRoleForName,
  rgbaToHex,
  roleNamePreference,
  tokenName,
  typographyRoleForName,
} from "../roles";
import type { FigmaFileData, FigmaNode, FigmaStyleMeta } from "./client";

export interface NormalizeReport {
  /** Human-readable list of what was read, with the Figma names. */
  extracted: string[];
  /** Styles/components found but not mapped to a website role, with the reason. */
  skipped: string[];
  stats: { textStyles: number; colorStyles: number; components: number };
}

/**
 * What was found while walking Figma trees, as plain JSON: the first node using each style
 * (with the values read from it), button components and the container frame. It can be stored
 * after each page batch and continued later; `finalizeFigma` turns it into design tokens.
 */
export interface FigmaCollectState {
  textStyles: Record<
    string,
    {
      nodeId: string;
      style: NonNullable<FigmaNode["style"]>;
      color: string | null;
      /**
       * Every fill the style is used with (a Figma text style has no color of its own; each layer
       * has its own fill). Absent in checkpoints written before 2026-10-10.
       */
      colors?: string[];
    }
  >;
  fillStyles: Record<string, { nodeId: string; color: string }>;
  buttons: Array<{
    nodeId: string;
    name: string;
    token: Omit<ComponentToken, "source">;
    paddingDiffers: boolean;
  }>;
  container: { nodeId: string; name: string; width: number } | null;
  /** Style metadata (name, type) from every response read. */
  styles: Record<string, FigmaStyleMeta>;
  /** Nodes walked so far. */
  nodes: number;
}

export function emptyCollectState(): FigmaCollectState {
  return { textStyles: {}, fillStyles: {}, buttons: [], container: null, styles: {}, nodes: 0 };
}

function solidFill(node: FigmaNode): string | null {
  const fill = node.fills?.find((f) => f.type === "SOLID" && f.visible !== false && f.color);
  if (!fill?.color) return null;
  const { r, g, b, a } = fill.color;
  return rgbaToHex(r, g, b, (a ?? 1) * (fill.opacity ?? 1));
}

function walk(
  node: FigmaNode,
  fn: (n: FigmaNode, parent: FigmaNode | null) => void,
  parent: FigmaNode | null = null,
) {
  fn(node, parent);
  for (const child of node.children ?? []) walk(child, fn, node);
}

function firstText(node: FigmaNode): FigmaNode | null {
  let found: FigmaNode | null = null;
  walk(node, (n) => {
    if (!found && n.type === "TEXT" && n.style) found = n;
  });
  return found;
}

const round = (v: number) => Math.round(v * 100) / 100;

/**
 * Walks one tree (a page, a linked node, or a whole document) and records what design values it
 * contains. The first node using a style provides its values, across all trees collected.
 */
export function collectFigma(
  state: FigmaCollectState,
  root: FigmaNode,
  styles: Record<string, FigmaStyleMeta> = {},
) {
  Object.assign(state.styles, styles);
  walk(root, (n, parent) => {
    state.nodes += 1;
    const textStyle = n.styles?.text;
    if (textStyle && n.type === "TEXT" && n.style) {
      const color = solidFill(n)?.slice(0, 7) ?? null;
      const seen = state.textStyles[textStyle];
      if (!seen)
        state.textStyles[textStyle] = {
          nodeId: n.id,
          style: n.style,
          color,
          colors: color ? [color] : [],
        };
      else if (color && seen.colors && !seen.colors.includes(color) && seen.colors.length < 16)
        seen.colors.push(color);
    }
    const fillStyle = n.styles?.fill ?? n.styles?.fills;
    const fill = solidFill(n);
    if (fillStyle && !state.fillStyles[fillStyle] && fill)
      state.fillStyles[fillStyle] = { nodeId: n.id, color: fill };
    if (n.type === "COMPONENT") {
      const name = parent?.type === "COMPONENT_SET" ? `${parent.name}, ${n.name}` : n.name;
      if (/\b(button|btn)\b/i.test(name)) {
        const text = firstText(n);
        state.buttons.push({
          nodeId: n.id,
          name,
          token: {
            ...(fill ? { background: fill } : {}),
            ...(text && solidFill(text) ? { color: solidFill(text)!.slice(0, 7) } : {}),
            ...(typeof n.cornerRadius === "number" ? { borderRadius: round(n.cornerRadius) } : {}),
            ...(n.paddingLeft !== undefined && n.paddingLeft === n.paddingRight
              ? { paddingX: round(n.paddingLeft) }
              : {}),
            ...(n.paddingTop !== undefined && n.paddingTop === n.paddingBottom
              ? { paddingY: round(n.paddingTop) }
              : {}),
            ...(text?.style?.fontSize ? { fontSize: round(text.style.fontSize) } : {}),
            ...(text?.style?.fontWeight ? { fontWeight: Math.round(text.style.fontWeight) } : {}),
          },
          paddingDiffers: n.paddingLeft !== undefined && n.paddingLeft !== n.paddingRight,
        });
      }
    }
    if (
      !state.container &&
      /^(content\s*)?container$|^max[\s-]?width$/i.test(n.name.trim()) &&
      n.absoluteBoundingBox
    )
      state.container = { nodeId: n.id, name: n.name, width: n.absoluteBoundingBox.width };
  });
}

/**
 * Design tokens from collected values: local text styles → typography roles, color (fill)
 * styles → palette (with roles for conventional names), "Button" components with a Primary or
 * Secondary variant → button tokens, a frame named "Container" → container width. Every token
 * records the Figma node it came from. Spacing scales and Figma Variables (Enterprise API) are
 * not read.
 */
export function finalizeFigma(
  state: FigmaCollectState,
  fileKey: string,
): { spec: DesignSpec; report: NormalizeReport } {
  const spec = emptyDesignSpec();
  const report: NormalizeReport = {
    extracted: [],
    skipped: [],
    stats: { textStyles: 0, colorStyles: 0, components: 0 },
  };
  const src = (nodeId: string, name: string): TokenSource => ({
    type: "figma",
    fileKey,
    nodeId,
    name: name.slice(0, 200),
  });

  // Typography from text styles.
  const typoCandidates = new Map<
    TypographyRole,
    { token: TypographyToken; pref: number; name: string }
  >();
  for (const [styleId, t] of Object.entries(state.textStyles)) {
    const meta = state.styles[styleId];
    if (!meta || meta.styleType !== "TEXT") continue;
    report.stats.textStyles += 1;
    const role = typographyRoleForName(meta.name);
    if (!role) {
      report.skipped.push(
        `Text style “${meta.name}”: no matching website role (h1–h6, body, link, button)`,
      );
      continue;
    }
    const s = t.style;
    // A color is a design rule only when every layer with this style uses it.
    const colors = t.colors ?? (t.color ? [t.color] : []);
    const color = colors.length === 1 ? colors[0]! : null;
    if (colors.length > 1)
      report.skipped.push(
        `Text style “${meta.name}”: used with ${colors.length} different colors (${colors.slice(0, 4).join(", ")}${colors.length > 4 ? ", …" : ""}); no text color taken`,
      );
    const token: TypographyToken = {
      ...(s.fontFamily ? { fontFamily: s.fontFamily } : {}),
      ...(s.fontSize ? { fontSize: round(s.fontSize) } : {}),
      ...(s.fontWeight ? { fontWeight: Math.round(s.fontWeight) } : {}),
      ...(s.lineHeightPx && s.lineHeightUnit !== "INTRINSIC_%"
        ? { lineHeight: round(s.lineHeightPx) }
        : {}),
      ...(typeof s.letterSpacing === "number" ? { letterSpacing: round(s.letterSpacing) } : {}),
      ...(color ? { color } : {}),
      source: src(t.nodeId, meta.name),
    };
    const pref = roleNamePreference(meta.name);
    const existing = typoCandidates.get(role);
    if (!existing || pref > existing.pref) {
      if (existing)
        report.skipped.push(`Text style “${existing.name}”: “${meta.name}” preferred for ${role}`);
      typoCandidates.set(role, { token, pref, name: meta.name });
    } else
      report.skipped.push(`Text style “${meta.name}”: “${existing.name}” already used for ${role}`);
  }
  for (const [role, c] of typoCandidates) {
    spec.typography[role] = c.token;
    report.extracted.push(`${role}: text style “${c.name}”`);
  }

  // Palette from color styles.
  const usedRoles = new Set<string>();
  for (const [styleId, f] of Object.entries(state.fillStyles)) {
    const meta = state.styles[styleId];
    if (!meta || meta.styleType !== "FILL") continue;
    report.stats.colorStyles += 1;
    const name = tokenName(meta.name, `Color ${report.stats.colorStyles}`);
    const role = colorRoleForName(meta.name);
    const assignRole = role && !usedRoles.has(role) ? role : undefined;
    if (assignRole) usedRoles.add(assignRole);
    spec.colors[name] = {
      value: f.color,
      ...(assignRole ? { role: assignRole } : {}),
      source: src(f.nodeId, meta.name),
    };
    report.extracted.push(`color “${name}”${assignRole ? ` (${assignRole})` : ""}`);
  }

  // Buttons from components ("Button/Primary", "Button" set with "Variant=Primary").
  const pick = (variant: RegExp) =>
    state.buttons
      .filter((b) => variant.test(b.name))
      .sort(
        (a, b) =>
          Number(/default|enabled|rest/i.test(b.name)) -
          Number(/default|enabled|rest/i.test(a.name)),
      )[0];
  for (const [key, re] of [
    ["buttonPrimary", /primary/i],
    ["buttonSecondary", /secondary/i],
  ] as Array<[ComponentKey, RegExp]>) {
    const b = pick(re);
    if (!b) continue;
    report.stats.components += 1;
    if (b.paddingDiffers)
      report.skipped.push(
        `Component “${b.name}”: left and right padding differ; horizontal padding not used`,
      );
    spec.components[key] = { ...b.token, source: src(b.nodeId, b.name) };
    report.extracted.push(`${key}: component “${b.name}”`);
  }
  const unmatchedButtons = state.buttons.filter((b) => !/primary|secondary/i.test(b.name)).length;
  if (unmatchedButtons)
    report.skipped.push(
      `${unmatchedButtons} button component(s) without a Primary/Secondary variant name`,
    );

  if (state.container) {
    spec.layout.containerMaxWidth = {
      value: round(state.container.width),
      source: src(state.container.nodeId, state.container.name),
    };
    report.extracted.push(`container width: frame “${state.container.name}”`);
  }

  return { spec: withoutInvalidValues(spec, report), report };
}

/**
 * A value outside what a design reference supports (for example a 9999px "pill" corner radius,
 * above the 500px maximum) is left out and reported as skipped, so one unusual value never fails
 * the whole Figma read.
 */
function withoutInvalidValues(spec: DesignSpec, report: NormalizeReport): DesignSpec {
  for (let i = 0; i < 50; i++) {
    const parsed = designSpecSchema.safeParse(spec);
    if (parsed.success) return parsed.data;
    const issue = parsed.error.issues[0]!;
    const path = issue.path.map(String);
    let parent: Record<string, unknown> = spec as unknown as Record<string, unknown>;
    for (const key of path.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
    const key = path.at(-1)!;
    report.skipped.push(
      `${path.join(".")} = ${JSON.stringify(parent[key])}: not used (${issue.message.toLowerCase()})`,
    );
    delete parent[key];
  }
  return designSpecSchema.parse(spec);
}

/** Reads design values from a whole file or linked nodes held in memory. */
export function normalizeFigma(
  file: FigmaFileData,
  fileKey: string,
): { spec: DesignSpec; report: NormalizeReport } {
  const state = emptyCollectState();
  for (const root of file.roots) collectFigma(state, root, file.styles);
  return finalizeFigma(state, fileKey);
}

/** A page of a Figma file as recorded in the processing manifest. */
export interface FigmaPageInventory {
  id: string;
  name: string;
  /** Top-level frames, sections and components (at most `maxFrames` listed). */
  frames: Array<{
    id: string;
    name: string;
    type: string;
    width: number | null;
    height: number | null;
  }>;
  framesTotal: number;
  nodes: number;
  textNodes: number;
  components: number;
}

const FRAME_TYPES = new Set(["FRAME", "SECTION", "COMPONENT", "COMPONENT_SET", "GROUP"]);

/** Frames and counts of one page (stable Figma ids, real sizes; nothing estimated). */
export function inventoryPage(page: FigmaNode, maxFrames = 200): FigmaPageInventory {
  const top = (page.children ?? []).filter((c) => FRAME_TYPES.has(c.type));
  let nodes = 0;
  let textNodes = 0;
  let components = 0;
  walk(page, (n) => {
    nodes += 1;
    if (n.type === "TEXT") textNodes += 1;
    if (n.type === "COMPONENT") components += 1;
  });
  return {
    id: page.id,
    name: page.name.slice(0, 200),
    frames: top.slice(0, maxFrames).map((f) => ({
      id: f.id,
      name: f.name.slice(0, 200),
      type: f.type,
      width: f.absoluteBoundingBox ? round(f.absoluteBoundingBox.width) : null,
      height: f.absoluteBoundingBox ? round(f.absoluteBoundingBox.height) : null,
    })),
    framesTotal: top.length,
    nodes,
    textNodes,
    components,
  };
}
