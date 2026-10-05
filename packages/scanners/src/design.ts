import {
  COLOR_ROLE_LABELS,
  COMPONENT_KEYS,
  COMPONENT_LABELS,
  describeSource,
  TYPOGRAPHY_ROLE_LABELS,
  TYPOGRAPHY_ROLES,
  type ColorRole,
  type DesignSpec,
  type Severity,
  type TokenSource,
} from "@qa/core";
import { differenceCiede2000, formatHex, parse } from "culori";
import type {
  CaptureRecord,
  CheckSummary,
  ComparisonItem,
  ComparisonVerdict,
  EvidenceDraft,
  FindingDraft,
  PageRecord,
  Scanner,
  ScannerContext,
} from "./types";
import { analyzablePages, displayUrl, sample } from "./util";

const deltaE = differenceCiede2000();

/** Color tolerance (CIEDE2000): ≤ 2 is not perceptibly different, 2–5 needs review. */
export const DELTA_E_MATCH = 2;
export const DELTA_E_POTENTIAL = 5;
/** Pixel tolerance for sizes (sub-pixel rounding). */
export const PX_TOLERANCE = 0.5;
/** Mapping confidence at or above which a mismatch is reported as confirmed. */
const CONFIRM_AT = 0.9;

interface Styles {
  color: string;
  backgroundColor: string;
  effectiveBackground: string;
  fontFamily: string;
  fontSize: string;
  fontWeight: string;
  lineHeight: string;
  letterSpacing: string;
  borderTopLeftRadius: string;
  paddingTop: string;
  paddingRight: string;
  paddingBottom: string;
  paddingLeft: string;
  maxWidth: string;
}
interface RoleSample {
  method: "semantic" | "heuristic" | "explicit" | "none";
  selector: string;
  count: number;
  error?: string;
  variants: Array<{
    count: number;
    styles: Styles;
    sample: {
      selector: string;
      text: string;
      box: { x: number; y: number; width: number; height: number };
    };
  }>;
}
interface DesignData {
  viewportWidth: number;
  roles: Record<string, RoleSample>;
  explicit: Record<string, RoleSample>;
  palette: { text: ColorUse[]; background: ColorUse[] };
  fonts: Array<{ family: string; status: string }>;
}
interface ColorUse {
  color: string;
  count: number;
  sample: string;
}

/** How well a role maps to elements: explicit selector > semantic HTML > class-name heuristics. */
function mappingConfidence(role: string, method: RoleSample["method"]): number {
  if (method === "explicit") return 1;
  if (method === "heuristic") return 0.7;
  if (/^h[1-6]$|^(header|footer|page)$/.test(role)) return 0.95;
  if (role === "body" || role === "link") return 0.9;
  return 0.85;
}

type Kind = "color" | "px" | "weight" | "family";
interface Target {
  key: string;
  label: string;
  role: string;
  selector?: string;
  kind: Kind;
  /** Style properties read (two for paddingX/paddingY). */
  props: Array<keyof Styles>;
  expected: number | string;
  scope: "widest" | "all";
  source: TokenSource;
  ruleId: string;
  severity: Severity;
}

const RULES = {
  color: "design-color-mismatch",
  fontFamily: "design-font-family-mismatch",
  fontSize: "design-font-size-mismatch",
  fontWeight: "design-font-weight-mismatch",
  lineHeight: "design-line-height-mismatch",
  letterSpacing: "design-letter-spacing-mismatch",
  radius: "design-radius-mismatch",
  padding: "design-spacing-mismatch",
  width: "design-width-mismatch",
} as const;

const COLOR_ROLE_TARGET: Record<ColorRole, { role: string; prop: keyof Styles }> = {
  text: { role: "body", prop: "color" },
  background: { role: "page", prop: "effectiveBackground" },
  link: { role: "link", prop: "color" },
  headerBackground: { role: "header", prop: "effectiveBackground" },
  footerBackground: { role: "footer", prop: "effectiveBackground" },
};

/** Every value in the spec that can be compared with computed styles. */
export function buildTargets(spec: DesignSpec): Target[] {
  const targets: Target[] = [];
  const seen = new Set<string>();
  const push = (t: Target) => {
    const id = `${t.selector ?? t.role}|${t.props.join(",")}`;
    if (seen.has(id)) return;
    seen.add(id);
    targets.push(t);
  };
  for (const role of TYPOGRAPHY_ROLES) {
    const t = spec.typography[role];
    if (!t) continue;
    const label = TYPOGRAPHY_ROLE_LABELS[role];
    const base = { role, selector: t.selector, source: t.source };
    const sized = t.scope ?? "widest";
    if (t.fontFamily)
      push({
        ...base,
        key: `typography.${role}.fontFamily`,
        label: `${label} font family`,
        kind: "family",
        props: ["fontFamily"],
        expected: t.fontFamily,
        scope: "all",
        ruleId: RULES.fontFamily,
        severity: "medium",
      });
    if (t.fontSize !== undefined)
      push({
        ...base,
        key: `typography.${role}.fontSize`,
        label: `${label} font size`,
        kind: "px",
        props: ["fontSize"],
        expected: t.fontSize,
        scope: sized,
        ruleId: RULES.fontSize,
        severity: "medium",
      });
    if (t.fontWeight !== undefined)
      push({
        ...base,
        key: `typography.${role}.fontWeight`,
        label: `${label} font weight`,
        kind: "weight",
        props: ["fontWeight"],
        expected: t.fontWeight,
        scope: "all",
        ruleId: RULES.fontWeight,
        severity: "low",
      });
    if (t.lineHeight !== undefined)
      push({
        ...base,
        key: `typography.${role}.lineHeight`,
        label: `${label} line height`,
        kind: "px",
        props: ["lineHeight"],
        expected: t.lineHeight,
        scope: sized,
        ruleId: RULES.lineHeight,
        severity: "low",
      });
    if (t.letterSpacing !== undefined)
      push({
        ...base,
        key: `typography.${role}.letterSpacing`,
        label: `${label} letter spacing`,
        kind: "px",
        props: ["letterSpacing"],
        expected: t.letterSpacing,
        scope: sized,
        ruleId: RULES.letterSpacing,
        severity: "low",
      });
    if (t.color)
      push({
        ...base,
        key: `typography.${role}.color`,
        label: `${label} color`,
        kind: "color",
        props: ["color"],
        expected: t.color,
        scope: "all",
        ruleId: RULES.color,
        severity: "medium",
      });
  }
  for (const [name, c] of Object.entries(spec.colors)) {
    if (!c.role) continue;
    const m = COLOR_ROLE_TARGET[c.role];
    push({
      key: `colors.${name}`,
      label: `${COLOR_ROLE_LABELS[c.role]} (“${name}”)`,
      role: m.role,
      kind: "color",
      props: [m.prop],
      expected: c.value.slice(0, 7),
      scope: "all",
      source: c.source,
      ruleId: RULES.color,
      severity: "medium",
    });
  }
  for (const key of COMPONENT_KEYS) {
    const t = spec.components[key];
    if (!t) continue;
    const label = COMPONENT_LABELS[key];
    const base = { role: key, selector: t.selector, source: t.source };
    const sized = t.scope ?? "widest";
    if (t.background)
      push({
        ...base,
        key: `components.${key}.background`,
        label: `${label} background`,
        kind: "color",
        props: ["effectiveBackground"],
        expected: t.background.slice(0, 7),
        scope: "all",
        ruleId: RULES.color,
        severity: "medium",
      });
    if (t.color)
      push({
        ...base,
        key: `components.${key}.color`,
        label: `${label} text color`,
        kind: "color",
        props: ["color"],
        expected: t.color,
        scope: "all",
        ruleId: RULES.color,
        severity: "medium",
      });
    if (t.borderRadius !== undefined)
      push({
        ...base,
        key: `components.${key}.borderRadius`,
        label: `${label} corner radius`,
        kind: "px",
        props: ["borderTopLeftRadius"],
        expected: t.borderRadius,
        scope: "all",
        ruleId: RULES.radius,
        severity: "low",
      });
    if (t.paddingX !== undefined)
      push({
        ...base,
        key: `components.${key}.paddingX`,
        label: `${label} horizontal padding`,
        kind: "px",
        props: ["paddingLeft", "paddingRight"],
        expected: t.paddingX,
        scope: sized,
        ruleId: RULES.padding,
        severity: "low",
      });
    if (t.paddingY !== undefined)
      push({
        ...base,
        key: `components.${key}.paddingY`,
        label: `${label} vertical padding`,
        kind: "px",
        props: ["paddingTop", "paddingBottom"],
        expected: t.paddingY,
        scope: sized,
        ruleId: RULES.padding,
        severity: "low",
      });
    if (t.fontSize !== undefined)
      push({
        ...base,
        key: `components.${key}.fontSize`,
        label: `${label} font size`,
        kind: "px",
        props: ["fontSize"],
        expected: t.fontSize,
        scope: sized,
        ruleId: RULES.fontSize,
        severity: "low",
      });
    if (t.fontWeight !== undefined)
      push({
        ...base,
        key: `components.${key}.fontWeight`,
        label: `${label} font weight`,
        kind: "weight",
        props: ["fontWeight"],
        expected: t.fontWeight,
        scope: "all",
        ruleId: RULES.fontWeight,
        severity: "low",
      });
  }
  const c = spec.layout.containerMaxWidth;
  if (c)
    push({
      key: "layout.containerMaxWidth",
      label: "Content container max width",
      role: "container",
      selector: c.selector,
      kind: "px",
      props: ["maxWidth"],
      expected: c.value,
      scope: "all",
      source: c.source,
      ruleId: RULES.width,
      severity: "low",
    });
  return targets;
}

const firstFamily = (stack: string) =>
  (stack.split(",")[0] ?? "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .toLowerCase();

const toHex = (css: string): string | null => {
  const c = parse(css);
  return c ? formatHex(c) : null;
};

interface Comparison {
  verdict: "match" | "mismatch" | "potential" | "unverifiable";
  actual: string;
  deltaE?: number;
  reason?: string;
}

/** Compares one observed style value with the expected token value. */
export function compareValue(
  t: Pick<Target, "kind" | "props" | "expected">,
  styles: Styles,
  fonts: DesignData["fonts"] = [],
): Comparison {
  if (t.kind === "color") {
    const raw = styles[t.props[0]!];
    const actual = parse(raw);
    const expected = parse(String(t.expected));
    if (!actual || !expected)
      return {
        verdict: "unverifiable",
        actual: raw,
        reason: `color value “${raw}” could not be parsed`,
      };
    const d = Math.round(deltaE(expected, actual) * 100) / 100;
    const hex = formatHex(actual);
    if (d <= DELTA_E_MATCH) return { verdict: "match", actual: hex, deltaE: d };
    return { verdict: d <= DELTA_E_POTENTIAL ? "potential" : "mismatch", actual: hex, deltaE: d };
  }
  if (t.kind === "weight") {
    const raw = styles.fontWeight;
    return { verdict: Number(raw) === Number(t.expected) ? "match" : "mismatch", actual: raw };
  }
  if (t.kind === "family") {
    const raw = styles.fontFamily;
    const first = firstFamily(raw);
    const want = String(t.expected)
      .toLowerCase()
      .replace(/^["']|["']$/g, "");
    if (first !== want) return { verdict: "mismatch", actual: raw };
    const faces = fonts.filter((f) => f.family.toLowerCase() === want);
    if (faces.length && faces.every((f) => f.status === "error"))
      return { verdict: "mismatch", actual: `${raw} (web font failed to load)` };
    return { verdict: "match", actual: raw };
  }
  // Pixel values; several properties (left/right padding) must all match.
  const parts: string[] = [];
  let worst: Comparison["verdict"] = "match";
  for (const prop of t.props) {
    const raw = styles[prop];
    let value: number;
    if (raw === "normal" && prop === "letterSpacing") value = 0;
    else if (raw === "normal" && prop === "lineHeight")
      return {
        verdict: "unverifiable",
        actual: raw,
        reason: "line height is “normal” (no pixel value to compare)",
      };
    else if (raw === "none") {
      parts.push("none");
      worst = "mismatch";
      continue;
    } else value = Number.parseFloat(raw);
    if (!Number.isFinite(value))
      return { verdict: "unverifiable", actual: raw, reason: `value “${raw}” is not a pixel size` };
    parts.push(`${Math.round(value * 100) / 100}px`);
    if (Math.abs(value - Number(t.expected)) > PX_TOLERANCE) worst = "mismatch";
  }
  return { verdict: worst, actual: [...new Set(parts)].join(" / ") };
}

const fmt = (t: Target) => (t.kind === "px" ? `${t.expected}px` : String(t.expected));

interface Observation {
  page: PageRecord;
  capture: CaptureRecord;
  method: RoleSample["method"];
  confidence: number;
  elements: number;
  selector: string;
  text: string;
  box: { x: number; y: number; width: number; height: number };
  result: Comparison;
}

function summarize(items: ComparisonItem[]) {
  const count = (v: ComparisonVerdict) => items.filter((i) => i.verdict === v).length;
  return {
    matched: count("match"),
    confirmedMismatch: count("confirmed_mismatch"),
    potentialMismatch: count("potential_mismatch"),
    unableToVerify: count("unable_to_verify"),
    items: items.slice(0, 500),
  };
}

export const designScanner: Scanner = {
  key: "design",
  idPrefix: "DSN",
  version: "1.0.0",
  async run(ctx: ScannerContext) {
    const ref = ctx.references.designSpec;
    const checks: CheckSummary = { evaluated: 0, inconclusive: [], notes: [] };
    const findings: FindingDraft[] = [];
    const items: ComparisonItem[] = [];
    if (!ref) {
      return {
        status: "inconclusive" as const,
        statusReason: "No confirmed design reference was frozen into this scan",
        findings,
        checks,
        toolName: "Design comparison",
        toolVersion: "1.0.0",
      };
    }
    const spec = ref.spec;
    const widest = Math.max(...ctx.viewports.map((v) => v.width));
    const pages = analyzablePages(ctx.pages);

    // Load collected styles once per capture.
    const data: Array<{ page: PageRecord; capture: CaptureRecord; d: DesignData }> = [];
    let missingData = 0;
    for (const p of pages)
      for (const c of p.captures) {
        if (c.error) continue;
        const d = (await c.loadDesignStyles()) as DesignData | null;
        if (d?.roles) data.push({ page: p, capture: c, d });
        else missingData += 1;
      }
    if (!data.length)
      return {
        status: "inconclusive" as const,
        statusReason: "No computed styles were captured, so no design value could be compared",
        findings,
        checks: {
          ...checks,
          inconclusive: [
            {
              check: "Design comparison",
              reason: "No page capture contains computed styles",
              pageUrl: null,
            },
          ],
        },
        toolName: "Design comparison",
        toolVersion: "1.0.0",
      };
    if (missingData)
      checks.notes!.push(`${missingData} capture(s) had no computed styles and were not compared.`);

    const reportedActuals = new Set<string>();
    for (const t of buildTargets(spec)) {
      const obs: Observation[] = [];
      let invalidSelector = false;
      for (const { page, capture, d } of data) {
        if (t.scope === "widest" && capture.width !== widest) continue;
        const roleSample = t.selector ? d.explicit?.[t.selector] : d.roles[t.role];
        if (roleSample?.error) invalidSelector = true;
        if (!roleSample || roleSample.method === "none" || !roleSample.count) continue;
        const confidence = mappingConfidence(t.role, roleSample.method);
        for (const v of roleSample.variants)
          obs.push({
            page,
            capture,
            method: roleSample.method,
            confidence,
            elements: v.count,
            selector: v.sample.selector,
            text: v.sample.text,
            box: v.sample.box,
            result: compareValue(t, v.styles, d.fonts),
          });
      }
      checks.evaluated += obs.length;
      const reference = describeSource(t.source);
      if (!obs.length) {
        const reason = invalidSelector
          ? `The CSS selector “${t.selector}” in the design reference is not valid`
          : t.selector
            ? `No visible element matches “${t.selector}” on the scanned pages`
            : t.role === "buttonPrimary" || t.role === "buttonSecondary" || t.role === "container"
              ? `No element could be confidently identified as the ${t.label.split(" ").slice(0, 2).join(" ").toLowerCase()}; add a CSS selector for it in the design reference`
              : `No matching element (${t.role}) on the scanned pages${t.scope === "widest" ? ` at the widest viewport (${widest}px)` : ""}`;
        items.push({
          key: t.key,
          label: t.label,
          verdict: "unable_to_verify",
          expected: fmt(t),
          actual: null,
          reference,
          detail: reason,
        });
        checks.inconclusive.push({ check: t.label, reason, pageUrl: null });
        continue;
      }
      const compared = obs.filter((o) => o.result.verdict !== "unverifiable");
      if (!compared.length) {
        const reason = obs[0]!.result.reason ?? "value could not be compared";
        items.push({
          key: t.key,
          label: t.label,
          verdict: "unable_to_verify",
          expected: fmt(t),
          actual: obs[0]!.result.actual,
          reference,
          detail: reason,
        });
        checks.inconclusive.push({ check: t.label, reason, pageUrl: displayUrl(obs[0]!.page) });
        continue;
      }
      const bad = compared.filter(
        (o) => o.result.verdict === "mismatch" || o.result.verdict === "potential",
      );
      const pageCount = new Set(compared.map((o) => o.page.id)).size;
      if (!bad.length) {
        items.push({
          key: t.key,
          label: t.label,
          verdict: "match",
          expected: fmt(t),
          actual: compared[0]!.result.actual,
          reference,
          detail: `${pageCount} page(s) checked${compared[0]!.result.deltaE !== undefined ? `; max ΔE ${Math.max(...compared.map((o) => o.result.deltaE ?? 0))}` : ""}`,
        });
        continue;
      }
      // Confirmed only when a definite mismatch was observed on a confidently mapped element.
      const confirmed = bad.some(
        (o) => o.result.verdict === "mismatch" && o.confidence >= CONFIRM_AT,
      );
      const byActual = new Map<string, Observation[]>();
      for (const o of bad)
        byActual.set(o.result.actual, [...(byActual.get(o.result.actual) ?? []), o]);
      const ranked = [...byActual.entries()].sort((a, b) => b[1].length - a[1].length);
      const [topActual, topObs] = ranked[0]!;
      for (const [a] of ranked) reportedActuals.add(toHex(a) ?? a);
      const first = topObs[0]!;
      const affectedPages = [...new Set(bad.map((o) => displayUrl(o.page)))];
      const viewports = [...new Set(bad.map((o) => o.capture.viewport))];
      const worstDelta = Math.max(...bad.map((o) => o.result.deltaE ?? 0));
      const mapping =
        first.method === "explicit"
          ? `selector “${t.selector}”`
          : first.method === "heuristic"
            ? `class-name heuristic (${first.selector})`
            : `semantic HTML (${t.role})`;
      const verdict = confirmed ? "confirmed" : "potential";
      items.push({
        key: t.key,
        label: t.label,
        verdict: confirmed ? "confirmed_mismatch" : "potential_mismatch",
        expected: fmt(t),
        actual:
          topActual +
          (ranked.length > 1
            ? ` (+${ranked.length - 1} other value${ranked.length > 2 ? "s" : ""})`
            : ""),
        pageUrl: displayUrl(first.page),
        reference,
        detail: `${affectedPages.length} of ${pageCount} page(s); mapped by ${mapping}${worstDelta ? `; ΔE ${worstDelta}` : ""}`,
      });
      const shots = sample(bad, 15);
      const screenshot = first.capture.screenshotKey
        ? [
            {
              kind: "screenshot" as const,
              data: {
                viewport: first.capture.viewport,
                width: first.capture.width,
                height: first.capture.height,
                highlight: [first.box],
              },
              storageKey: first.capture.screenshotKey,
            },
          ]
        : [];
      const evidence: EvidenceDraft[] = [
        {
          kind: "design_token",
          data: {
            token: t.key,
            expected: fmt(t),
            source: reference,
            tolerance:
              t.kind === "color"
                ? `CIEDE2000 ΔE ≤ ${DELTA_E_MATCH} matches; ${DELTA_E_MATCH}–${DELTA_E_POTENTIAL} needs review; > ${DELTA_E_POTENTIAL} differs`
                : t.kind === "px"
                  ? `±${PX_TOLERANCE}px`
                  : "exact",
            comparedAt: t.scope === "widest" ? `widest viewport (${widest}px)` : "all viewports",
          },
        },
        {
          kind: "computed_style",
          data: {
            property: t.props.join(" / "),
            mapping,
            mappingConfidence: first.confidence,
            observations: shots.items.map((o) => ({
              page: displayUrl(o.page),
              viewport: o.capture.viewport,
              actual: o.result.actual,
              ...(o.result.deltaE !== undefined ? { deltaE: o.result.deltaE } : {}),
              elements: o.elements,
              selector: o.selector,
              text: o.text,
            })),
            omitted: shots.omitted,
          },
        },
        ...screenshot,
      ];
      findings.push({
        ruleId: t.ruleId,
        title: `${t.label}: ${topActual} instead of ${fmt(t)}`,
        message: `${t.label} differs from the design reference on ${affectedPages.length} page${affectedPages.length === 1 ? "" : "s"} (${viewports.join(", ")}): expected ${fmt(t)} (${reference}), found ${topActual}${worstDelta ? ` (ΔE ${worstDelta})` : ""}. Elements mapped by ${mapping}${confirmed ? "." : "; the difference is small or the mapping is not certain, so it needs review."}`,
        subcategory:
          t.kind === "color"
            ? "color"
            : t.kind === "px" && /padding|Radius|maxWidth/.test(t.props[0]!)
              ? "layout"
              : "typography",
        pageId: first.page.id,
        pageUrl: null,
        selector: first.selector,
        viewport: viewports.length === 1 ? viewports[0]! : null,
        severity: confirmed ? t.severity : "low",
        verdict,
        confidence: first.confidence,
        expected: fmt(t),
        actual: topActual,
        fingerprintKey: t.key,
        evidence,
      });
    }

    // Roles found on the site that the reference does not describe: unable to verify.
    const present = (role: string) => data.some(({ d }) => (d.roles[role]?.count ?? 0) > 0);
    for (const role of ["h1", "h2", "body", "link"] as const)
      if (!spec.typography[role] && present(role))
        items.push({
          key: `typography.${role}`,
          label: TYPOGRAPHY_ROLE_LABELS[role],
          verdict: "unable_to_verify",
          expected: null,
          actual: null,
          detail: "Reference value not provided in the design reference",
        });
    if (!spec.components.buttonPrimary && present("buttonPrimary"))
      items.push({
        key: "components.buttonPrimary",
        label: COMPONENT_LABELS.buttonPrimary,
        verdict: "unable_to_verify",
        detail: "Reference value not provided in the design reference",
      });

    // Palette: colors used on the site that are close to, but not, a brand color.
    // Brand colors: the palette plus every color used by typography and component tokens.
    const brand: Array<{ name: string; value: string; source: TokenSource }> = [
      ...Object.entries(spec.colors).map(([name, c]) => ({
        name,
        value: c.value,
        source: c.source,
      })),
      ...TYPOGRAPHY_ROLES.flatMap((r) => {
        const t = spec.typography[r];
        return t?.color
          ? [{ name: `${TYPOGRAPHY_ROLE_LABELS[r]} color`, value: t.color, source: t.source }]
          : [];
      }),
      ...COMPONENT_KEYS.flatMap((k) => {
        const t = spec.components[k];
        return [
          ...(t?.background
            ? [{ name: `${COMPONENT_LABELS[k]} background`, value: t.background, source: t.source }]
            : []),
          ...(t?.color
            ? [{ name: `${COMPONENT_LABELS[k]} text`, value: t.color, source: t.source }]
            : []),
        ];
      }),
    ];
    const palette = brand.map((b) => ({
      ...b,
      value: b.value.slice(0, 7),
      parsed: parse(b.value.slice(0, 7)),
    }));
    if (palette.length) {
      const uses = new Map<
        string,
        { count: number; pages: Set<string>; sample: string; pageId: string }
      >();
      for (const { page, capture, d } of data) {
        if (capture.width !== widest) continue;
        for (const u of [...(d.palette?.text ?? []), ...(d.palette?.background ?? [])]) {
          const hex = toHex(u.color);
          if (!hex) continue;
          const e = uses.get(hex) ?? {
            count: 0,
            pages: new Set<string>(),
            sample: u.sample,
            pageId: page.id,
          };
          e.count += u.count;
          e.pages.add(displayUrl(page));
          uses.set(hex, e);
        }
      }
      const off: string[] = [];
      for (const [hex, u] of uses) {
        checks.evaluated += 1;
        const nearest = palette
          .map((p) => ({ ...p, d: p.parsed ? deltaE(p.parsed, parse(hex)!) : Infinity }))
          .sort((a, b) => a.d - b.d)[0]!;
        const d = Math.round(nearest.d * 100) / 100;
        if (d <= DELTA_E_MATCH) continue;
        if (d > 10) {
          off.push(`${hex} (${u.count} element${u.count === 1 ? "" : "s"})`);
          continue;
        }
        if (u.count < 2 || reportedActuals.has(hex)) continue;
        const reference = describeSource(nearest.source);
        items.push({
          key: `palette.${hex}`,
          label: `Color ${hex}`,
          verdict: "potential_mismatch",
          expected: `${nearest.value} (“${nearest.name}”)`,
          actual: hex,
          pageUrl: [...u.pages][0] ?? null,
          reference,
          detail: `ΔE ${d} to the nearest brand color; used by ${u.count} elements`,
        });
        findings.push({
          ruleId: "design-color-near-palette",
          title: `Color ${hex} is close to brand color “${nearest.name}” (${nearest.value}) but not equal`,
          message: `${hex} is used by ${u.count} elements on ${u.pages.size} page(s). The nearest color in the design reference is “${nearest.name}” ${nearest.value} (ΔE ${d}). A near-miss usually means a brand color was typed incorrectly; it may also be an intentional shade that the reference does not list.`,
          subcategory: "color",
          pageId: u.pageId,
          pageUrl: null,
          selector: u.sample,
          viewport: null,
          severity: "low",
          verdict: "potential",
          confidence: 0.6,
          expected: nearest.value,
          actual: hex,
          fingerprintKey: `palette:${hex}`,
          evidence: [
            {
              kind: "design_token",
              data: {
                token: `colors.${nearest.name}`,
                expected: nearest.value,
                source: reference,
                tolerance: `nearest brand color by CIEDE2000; ΔE ${d}`,
              },
            },
            {
              kind: "measurement",
              data: {
                color: hex,
                elements: u.count,
                pages: [...u.pages].slice(0, 10),
                sampleSelector: u.sample,
                comparedAt: `widest viewport (${widest}px)`,
              },
            },
          ],
        });
      }
      if (off.length)
        checks.notes!.push(
          `${off.length} color(s) used on the site are not near any brand color (they may be neutrals or third-party content): ${off.slice(0, 8).join(", ")}${off.length > 8 ? ", …" : ""}.`,
        );
    }

    checks.notes!.push(
      "Font families are compared with the first family declared in CSS; web fonts that failed to load are detected, but whether a locally installed font rendered cannot be verified.",
      "Size-dependent values (font sizes, line heights, paddings) are compared at the widest captured viewport unless the token's scope is “all”.",
    );
    if (!spec.spacing.scale)
      checks.notes!.push(
        "The design reference has no spacing scale; general spacing and alignment are not compared.",
      );
    else
      checks.notes!.push(
        `Spacing scale (${spec.spacing.scale.values.join(", ")}px) is recorded; only mapped component paddings are compared, free-form alignment against design frames cannot be verified.`,
      );
    checks.comparison = summarize(items);
    return {
      status: "completed" as const,
      statusReason: `Design reference v${ref.version}: ${checks.comparison.matched} matched, ${checks.comparison.confirmedMismatch} mismatched, ${checks.comparison.potentialMismatch} need review, ${checks.comparison.unableToVerify} unable to verify`,
      findings,
      checks,
      toolName: "Design comparison (computed styles, CIEDE2000)",
      toolVersion: "1.0.0",
    };
  },
};
