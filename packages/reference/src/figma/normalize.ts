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
import type { FigmaFileData, FigmaNode } from "./client";

export interface NormalizeReport {
  /** Human-readable list of what was read, with the Figma names. */
  extracted: string[];
  /** Styles/components found but not mapped to a website role, with the reason. */
  skipped: string[];
  stats: { textStyles: number; colorStyles: number; components: number };
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
 * Reads design values from a Figma file: local text styles → typography roles, color (fill)
 * styles → palette (with roles for conventional names), "Button" components with a Primary or
 * Secondary variant → button tokens, a frame named "Container" → container width. Values are
 * read from the nodes that use each style; every token records the Figma node it came from.
 * Spacing scales and Figma Variables (Enterprise API) are not read.
 */
export function normalizeFigma(
  file: FigmaFileData,
  fileKey: string,
): { spec: DesignSpec; report: NormalizeReport } {
  const spec = emptyDesignSpec();
  const report: NormalizeReport = {
    extracted: [],
    skipped: [],
    stats: { textStyles: 0, colorStyles: 0, components: 0 },
  };
  const src = (n: FigmaNode, name: string): TokenSource => ({
    type: "figma",
    fileKey,
    nodeId: n.id,
    name: name.slice(0, 200),
  });

  // The first node using each style provides its values.
  const textStyleNodes = new Map<string, FigmaNode>();
  const fillStyleNodes = new Map<string, FigmaNode>();
  const buttons: Array<{ node: FigmaNode; name: string }> = [];
  let container: FigmaNode | null = null;

  for (const root of file.roots)
    walk(root, (n, parent) => {
      const textStyle = n.styles?.text;
      if (textStyle && n.type === "TEXT" && n.style && !textStyleNodes.has(textStyle))
        textStyleNodes.set(textStyle, n);
      const fillStyle = n.styles?.fill ?? n.styles?.fills;
      if (fillStyle && !fillStyleNodes.has(fillStyle) && solidFill(n))
        fillStyleNodes.set(fillStyle, n);
      if (n.type === "COMPONENT") {
        const name = parent?.type === "COMPONENT_SET" ? `${parent.name}, ${n.name}` : n.name;
        if (/\b(button|btn)\b/i.test(name)) buttons.push({ node: n, name });
      }
      if (
        !container &&
        /^(content\s*)?container$|^max[\s-]?width$/i.test(n.name.trim()) &&
        n.absoluteBoundingBox
      )
        container = n;
    });

  // Typography from text styles.
  const typoCandidates = new Map<
    TypographyRole,
    { token: TypographyToken; pref: number; name: string }
  >();
  for (const [styleId, node] of textStyleNodes) {
    const meta = file.styles[styleId];
    if (!meta || meta.styleType !== "TEXT") continue;
    report.stats.textStyles += 1;
    const role = typographyRoleForName(meta.name);
    if (!role) {
      report.skipped.push(
        `Text style “${meta.name}”: no matching website role (h1–h6, body, link, button)`,
      );
      continue;
    }
    const s = node.style!;
    const token: TypographyToken = {
      ...(s.fontFamily ? { fontFamily: s.fontFamily } : {}),
      ...(s.fontSize ? { fontSize: round(s.fontSize) } : {}),
      ...(s.fontWeight ? { fontWeight: Math.round(s.fontWeight) } : {}),
      ...(s.lineHeightPx && s.lineHeightUnit !== "INTRINSIC_%"
        ? { lineHeight: round(s.lineHeightPx) }
        : {}),
      ...(typeof s.letterSpacing === "number" ? { letterSpacing: round(s.letterSpacing) } : {}),
      ...(solidFill(node) ? { color: solidFill(node)!.slice(0, 7) } : {}),
      source: src(node, meta.name),
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
  for (const [styleId, node] of fillStyleNodes) {
    const meta = file.styles[styleId];
    if (!meta || meta.styleType !== "FILL") continue;
    report.stats.colorStyles += 1;
    const name = tokenName(meta.name, `Color ${report.stats.colorStyles}`);
    const role = colorRoleForName(meta.name);
    const assignRole = role && !usedRoles.has(role) ? role : undefined;
    if (assignRole) usedRoles.add(assignRole);
    spec.colors[name] = {
      value: solidFill(node)!,
      ...(assignRole ? { role: assignRole } : {}),
      source: src(node, meta.name),
    };
    report.extracted.push(`color “${name}”${assignRole ? ` (${assignRole})` : ""}`);
  }

  // Buttons from components ("Button/Primary", "Button" set with "Variant=Primary").
  const pick = (variant: RegExp) =>
    buttons
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
    const n = b.node;
    const text = firstText(n);
    const token: ComponentToken = {
      ...(solidFill(n) ? { background: solidFill(n)! } : {}),
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
      source: src(n, b.name),
    };
    if (n.paddingLeft !== undefined && n.paddingLeft !== n.paddingRight)
      report.skipped.push(
        `Component “${b.name}”: left and right padding differ; horizontal padding not used`,
      );
    spec.components[key] = token;
    report.extracted.push(`${key}: component “${b.name}”`);
  }
  const unmatchedButtons = buttons.filter((b) => !/primary|secondary/i.test(b.name)).length;
  if (unmatchedButtons)
    report.skipped.push(
      `${unmatchedButtons} button component(s) without a Primary/Secondary variant name`,
    );

  const c = container as FigmaNode | null;
  if (c?.absoluteBoundingBox) {
    spec.layout.containerMaxWidth = {
      value: round(c.absoluteBoundingBox.width),
      source: src(c, c.name),
    };
    report.extracted.push(`container width: frame “${c.name}”`);
  }

  return { spec: designSpecSchema.parse(spec), report };
}
