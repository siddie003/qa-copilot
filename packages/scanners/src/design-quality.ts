import { describeSource, TYPOGRAPHY_ROLE_LABELS, type DesignSpec } from "@qa/core";
import type {
  CaptureRecord,
  CheckPart,
  CheckSummary,
  ComparisonItem,
  ComparisonVerdict,
  EvidenceDraft,
  FindingDraft,
  PageRecord,
  Scanner,
  ScannerContext,
  StepResultRecord,
} from "./types";
import { analyzablePages, displayUrl, sample } from "./util";

/**
 * Design Quality & Typography. Checks what can be measured objectively in the rendered pages:
 * heading typography consistency and visual hierarchy (H1–H6), whether declared web fonts really
 * rendered (Chromium's font engine), use of the project's uploaded brand fonts, images displayed
 * larger than their source or stretched, spacing against an explicit spacing scale, near-miss
 * alignment and uneven gaps between repeated items.
 *
 * It does not duplicate other steps: heading values against the confirmed design reference are
 * compared by the design comparison and approved text by the content comparison (this scanner
 * runs after them and reports their outcome by cross-reference); broken images belong to the
 * responsive and links scanners and missing alt text to accessibility.
 */

export const DQ_RULES = {
  headingInconsistent: "dq-heading-inconsistent",
  hierarchyInverted: "dq-heading-hierarchy-inverted",
  webfontNotRendered: "dq-webfont-not-rendered",
  fontNotApproved: "dq-font-not-approved",
  imageUpscaled: "dq-image-upscaled",
  imageDistorted: "dq-image-distorted",
  spacingOffScale: "dq-spacing-off-scale",
  alignmentNearMiss: "dq-alignment-near-miss",
  spacingInconsistent: "dq-spacing-inconsistent",
} as const;

/** Font-size tolerance (sub-pixel rounding of rem/em values). */
const SIZE_TOLERANCE = 0.5;
/** An image shown at ≥ 1.5× its source size is reported as confirmed; 1.15–1.5× needs review. */
export const UPSCALE_CONFIRMED = 1.5;
export const UPSCALE_POTENTIAL = 1.15;
/** Aspect-ratio change above 5% (object-fit: fill) is a visibly stretched or squashed image. */
export const DISTORTION_TOLERANCE = 0.05;
/** Images smaller than this (icons, avatars) are not judged for clarity. */
const MIN_IMAGE_PX = 48;
const MAX_LAYOUT_FINDINGS = 10;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface Typo {
  fontFamily: string;
  fontSize: number | null;
  fontWeight: string;
  fontStyle: string;
  lineHeight: number | "normal" | null;
  letterSpacing: string;
  textTransform: string;
  textAlign: string;
  color: string;
}
interface QHeading extends Typo {
  index: number;
  level: number;
  selector: string;
  text: string;
  inChrome: boolean;
  box: Box;
}
interface QParagraph extends Typo {
  index: number;
  selector: string;
  text: string;
  box: Box;
}
interface QImage {
  src: string;
  selector: string;
  naturalWidth: number;
  naturalHeight: number;
  renderedWidth: number;
  renderedHeight: number;
  objectFit: string;
  visible: boolean;
  broken: boolean;
  isSvg: boolean;
  box: Box;
}
interface QAlignment {
  parent: string;
  a: { selector: string; left: number; box: Box };
  b: { selector: string; left: number; box: Box };
  offsetPx: number;
}
interface QGap {
  parent: string;
  axis: "vertical" | "horizontal";
  item: string;
  gaps: number[];
  items: Array<{ selector: string; box: Box }>;
}
interface QSpacing {
  property: string;
  value: number;
  count: number;
  sample: string;
}
interface RenderedSample {
  kind: "heading" | "paragraph";
  index: number;
  declared: string | null;
  fonts: Array<{
    familyName: string;
    postScriptName: string | null;
    isCustomFont: boolean;
    glyphCount: number;
  }>;
  error: string | null;
}
export interface QualityData {
  viewportWidth: number;
  headingsTotal: number;
  headings: QHeading[];
  paragraphs: QParagraph[];
  fonts: Array<{ family: string; status: string; weight: string; style: string }>;
  images: QImage[];
  alignment: QAlignment[];
  gaps: QGap[];
  spacing: QSpacing[];
  /** Fonts the browser's font engine used (widest viewport only). */
  rendered?: { samples: RenderedSample[]; error: string | null } | null;
}

interface Sample {
  page: PageRecord;
  capture: CaptureRecord;
  q: QualityData;
}

const GENERIC_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "emoji",
  "math",
  "fangsong",
  "-apple-system",
  "blinkmacsystemfont",
]);

export const firstFamily = (stack: string | null | undefined) =>
  (stack ?? "")
    .split(",")[0]!
    .trim()
    .replace(/^["']|["']$/g, "");
const norm = (s: string) =>
  s
    .trim()
    .replace(/^["']|["']$/g, "")
    .toLowerCase();
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function styleKey(h: Typo) {
  return [
    norm(firstFamily(h.fontFamily)),
    h.fontSize === null ? "?" : Math.round(h.fontSize / SIZE_TOLERANCE) * SIZE_TOLERANCE,
    h.fontWeight,
    h.fontStyle,
  ].join("|");
}
const describeStyle = (h: Typo) =>
  `${h.fontSize ?? "?"}px, weight ${h.fontWeight}${h.fontStyle !== "normal" ? `, ${h.fontStyle}` : ""}, “${firstFamily(h.fontFamily)}”`;

function screenshot(capture: CaptureRecord, boxes: Box[]): EvidenceDraft[] {
  return capture.screenshotKey
    ? [
        {
          kind: "screenshot",
          data: {
            viewport: capture.viewport,
            width: capture.width,
            height: capture.height,
            highlight: boxes.slice(0, 6),
          },
          storageKey: capture.screenshotKey,
        },
      ]
    : [];
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** How large an image is drawn relative to its source, per object-fit. */
export function displayScale(
  img: Pick<
    QImage,
    "naturalWidth" | "naturalHeight" | "renderedWidth" | "renderedHeight" | "objectFit"
  >,
) {
  const sx = img.renderedWidth / img.naturalWidth;
  const sy = img.renderedHeight / img.naturalHeight;
  switch (img.objectFit) {
    case "contain":
      return Math.min(sx, sy);
    case "scale-down":
      return Math.min(1, sx, sy);
    case "none":
      return 1;
    default:
      // fill and cover draw the source at the larger of the two factors along some axis.
      return Math.max(sx, sy);
  }
}

/** Relative change of the aspect ratio when an image is stretched to its box (object-fit: fill). */
export function aspectDistortion(
  img: Pick<
    QImage,
    "naturalWidth" | "naturalHeight" | "renderedWidth" | "renderedHeight" | "objectFit"
  >,
) {
  if (img.objectFit && img.objectFit !== "fill") return 0;
  const natural = img.naturalWidth / img.naturalHeight;
  const rendered = img.renderedWidth / img.renderedHeight;
  return Math.abs(rendered / natural - 1);
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

interface Ctx {
  ctx: ScannerContext;
  data: Sample[];
  widest: number;
  findings: FindingDraft[];
  checks: CheckSummary & { notes: string[]; parts: CheckPart[] };
  items: ComparisonItem[];
}

// ---- headings --------------------------------------------------------------------------------

function headingChecks(c: Ctx): CheckPart {
  const content = c.data.flatMap((s) =>
    s.q.headings.filter((h) => !h.inChrome).map((h) => ({ ...s, h })),
  );
  const chrome = c.data.reduce((n, s) => n + s.q.headings.filter((h) => h.inChrome).length, 0);
  c.checks.evaluated += content.length;
  if (chrome)
    c.checks.notes.push(
      `${plural(chrome, "heading")} inside the header, navigation or footer ${chrome === 1 ? "was" : "were"} excluded from the consistency checks (site chrome is often styled on purpose).`,
    );
  if (!content.length)
    return {
      key: "headings",
      label: "Heading typography (H1–H6)",
      status: "inconclusive",
      detail:
        "No visible headings were found in the page content, so heading typography could not be checked.",
    };

  // 1. The same heading level styled differently at the same screen size.
  for (let level = 1; level <= 6; level++) {
    const byViewport = new Map<string, typeof content>();
    for (const x of content.filter((x) => x.h.level === level))
      byViewport.set(x.capture.viewport, [...(byViewport.get(x.capture.viewport) ?? []), x]);
    const inconsistent: Array<{
      viewport: string;
      width: number;
      variants: Array<{ key: string; list: typeof content }>;
    }> = [];
    for (const [viewport, list] of byViewport) {
      const variants = new Map<string, typeof content>();
      for (const x of list) {
        const k = styleKey(x.h);
        variants.set(k, [...(variants.get(k) ?? []), x]);
      }
      if (variants.size > 1)
        inconsistent.push({
          viewport,
          width: list[0]!.capture.width,
          variants: [...variants.entries()]
            .map(([key, l]) => ({ key, list: l }))
            .sort((a, b) => b.list.length - a.list.length),
        });
    }
    if (!inconsistent.length) continue;
    inconsistent.sort((a, b) => b.width - a.width);
    const main = inconsistent[0]!;
    const common = main.variants[0]!.list[0]!.h;
    const odd = main.variants[1]!.list[0]!;
    const label = `H${level}`;
    c.findings.push({
      ruleId: DQ_RULES.headingInconsistent,
      title: `${label} headings use ${main.variants.length} different styles at ${main.viewport} size`,
      message: `${label} headings are not styled consistently: at ${main.viewport} (${main.width}px) the scan measured ${main.variants
        .map((v) => `${describeStyle(v.list[0]!.h)} on ${plural(v.list.length, "heading")}`)
        .join(
          "; ",
        )}${inconsistent.length > 1 ? `; ${inconsistent.length - 1} other screen size(s) also differ` : ""}. Headings of the same level usually share one style; a different style may be intentional (for example a hero heading), so this needs review.`,
      subcategory: "typography",
      pageId: odd.page.id,
      pageUrl: null,
      selector: odd.h.selector,
      viewport: null,
      severity: "low",
      verdict: "potential",
      confidence: 0.6,
      expected: `One style for all ${label} headings at each screen size (most common at ${main.viewport}: ${describeStyle(common)})`,
      actual: `${main.variants.length} styles at ${main.viewport}: ${main.variants
        .map((v) => `${describeStyle(v.list[0]!.h)} ×${v.list.length}`)
        .join("; ")}`,
      fingerprintKey: `heading-inconsistent:h${level}`,
      evidence: [
        {
          kind: "computed_style",
          data: {
            property: "font-family / font-size / font-weight / font-style",
            headingLevel: label,
            tolerance: `font sizes within ±${SIZE_TOLERANCE}px count as equal`,
            viewports: inconsistent.slice(0, 4).map((v) => ({
              viewport: v.viewport,
              width: v.width,
              variants: v.variants.slice(0, 5).map((x) => {
                const h = x.list[0]!.h;
                return {
                  fontFamily: h.fontFamily,
                  fontSize: h.fontSize === null ? null : `${h.fontSize}px`,
                  fontWeight: h.fontWeight,
                  fontStyle: h.fontStyle,
                  lineHeight: typeof h.lineHeight === "number" ? `${h.lineHeight}px` : h.lineHeight,
                  headings: x.list.length,
                  pages: [...new Set(x.list.map((y) => displayUrl(y.page)))].slice(0, 5),
                  selector: h.selector,
                  text: h.text,
                };
              }),
            })),
          },
        },
        ...screenshot(odd.capture, [odd.h.box]),
      ],
    });
  }

  // 2. Visual hierarchy: a lower-rank heading drawn larger than a higher-rank one on one page.
  const pairs = new Map<
    string,
    Array<{
      page: PageRecord;
      capture: CaptureRecord;
      a: number;
      b: number;
      sa: number;
      sb: number;
      sel: string;
      box: Box;
    }>
  >();
  for (const s of c.data) {
    const sizes = new Map<number, QHeading[]>();
    for (const h of s.q.headings)
      if (!h.inChrome && h.fontSize !== null)
        sizes.set(h.level, [...(sizes.get(h.level) ?? []), h]);
    const levels = [...sizes.keys()].sort();
    for (let i = 0; i < levels.length; i++)
      for (let j = i + 1; j < levels.length; j++) {
        const a = levels[i]!;
        const b = levels[j]!;
        const sa = median(sizes.get(a)!.map((h) => h.fontSize!));
        const sb = median(sizes.get(b)!.map((h) => h.fontSize!));
        if (sb <= sa + SIZE_TOLERANCE) continue;
        const key = `h${a}<h${b}`;
        const big = sizes.get(b)!.sort((x, y) => y.fontSize! - x.fontSize!)[0]!;
        pairs.set(key, [
          ...(pairs.get(key) ?? []),
          { page: s.page, capture: s.capture, a, b, sa, sb, sel: big.selector, box: big.box },
        ]);
      }
  }
  for (const [key, list] of [...pairs.entries()].slice(0, 5)) {
    const first = list.sort((x, y) => y.capture.width - x.capture.width)[0]!;
    const pages = [...new Set(list.map((x) => displayUrl(x.page)))];
    c.findings.push({
      ruleId: DQ_RULES.hierarchyInverted,
      title: `H${first.b} headings are larger than H${first.a} headings`,
      message: `On ${plural(pages.length, "page")} the lower-level H${first.b} headings are drawn larger than the H${first.a} headings (median ${round(first.sb)}px vs ${round(first.sa)}px at ${first.capture.viewport}), so the visual order of importance is the reverse of the heading levels. This is a visual check; the semantic heading order is checked separately by the accessibility scanner.`,
      subcategory: "typography",
      pageId: first.page.id,
      pageUrl: null,
      selector: first.sel,
      viewport: null,
      severity: "low",
      verdict: "potential",
      confidence: 0.6,
      expected: `H${first.a} at least as large as H${first.b}`,
      actual: `H${first.a} ${round(first.sa)}px, H${first.b} ${round(first.sb)}px (${first.capture.viewport})`,
      fingerprintKey: `hierarchy:${key}`,
      evidence: [
        {
          kind: "measurement",
          data: {
            comparison:
              "median computed font size per heading level on the same page and screen size",
            observations: sample(list, 10).items.map((x) => ({
              page: displayUrl(x.page),
              viewport: x.capture.viewport,
              [`h${x.a}`]: `${round(x.sa)}px`,
              [`h${x.b}`]: `${round(x.sb)}px`,
              largerHeading: x.sel,
            })),
            omitted: Math.max(0, list.length - 10),
          },
        },
        ...screenshot(first.capture, [first.box]),
      ],
    });
  }
  const levels = [...new Set(content.map((x) => x.h.level))].sort();
  return {
    key: "headings",
    label: "Heading typography (H1–H6)",
    status: "completed",
    detail: `${plural(content.length, "heading")} measured (levels ${levels.map((l) => `H${l}`).join(", ")}) across ${plural(c.data.length, "page capture")}: font family, size, weight, style and line height per level and screen size.`,
  };
}

// ---- reference values (cross-reference to the design comparison) ------------------------------

function observedSizes(c: Ctx, level: number) {
  const byViewport = new Map<string, number[]>();
  for (const s of c.data)
    for (const h of s.q.headings)
      if (h.level === level && !h.inChrome && h.fontSize !== null)
        byViewport.set(s.capture.viewport, [
          ...(byViewport.get(s.capture.viewport) ?? []),
          h.fontSize,
        ]);
  return [...byViewport.entries()].map(([v, xs]) => {
    const uniq = [...new Set(xs.map((x) => round(x)))].sort((a, b) => b - a);
    return `${uniq.length > 3 ? `${uniq.slice(0, 3).join("/")}…` : uniq.join("/")}px (${v})`;
  });
}

function referenceChecks(
  c: Ctx,
  spec: DesignSpec | null,
  design: StepResultRecord | null,
): CheckPart {
  const label = "Heading values against the design reference";
  const present = [1, 2, 3, 4, 5, 6].filter((l) =>
    c.data.some((s) => s.q.headings.some((h) => h.level === l && !h.inChrome)),
  );
  const withRef = present.filter((l) => {
    const t = spec?.typography[`h${l}` as keyof DesignSpec["typography"]];
    return Boolean(
      t &&
      (t.fontSize !== undefined ||
        t.fontWeight !== undefined ||
        t.fontFamily ||
        t.lineHeight !== undefined),
    );
  });
  for (const l of present.filter((x) => !withRef.includes(x)))
    c.items.push({
      key: `reference.h${l}`,
      label: `${TYPOGRAPHY_ROLE_LABELS[`h${l}` as "h1"]} size`,
      verdict: "unable_to_verify",
      expected: null,
      actual: observedSizes(c, l).join(", ") || null,
      reference: null,
      detail: spec
        ? "Inconclusive: the confirmed design reference has no value for this heading level; only internal consistency was checked."
        : "Inconclusive: no confirmed design reference (brand guideline, Figma or manual values); only internal consistency was checked.",
    });
  if (!spec)
    return {
      key: "reference",
      label,
      status: "not_configured",
      detail:
        "No confirmed design reference. Brand guideline values and Figma values become a reference after you confirm them on the References page; until then no expected heading size is assumed.",
    };
  if (!withRef.length)
    return {
      key: "reference",
      label,
      status: "not_configured",
      detail: "The confirmed design reference has no heading (H1–H6) typography values.",
    };
  const cmp = (design?.checks as { comparison?: { items?: ComparisonItem[] } } | null)?.comparison;
  if (!design || design.status !== "completed" || !cmp?.items) {
    const why = design
      ? (design.error ?? design.statusReason ?? `the design comparison ended as ${design.status}`)
      : "the design comparison did not run";
    for (const l of withRef)
      c.items.push({
        key: `reference.h${l}`,
        label: `${TYPOGRAPHY_ROLE_LABELS[`h${l}` as "h1"]} against the reference`,
        verdict: "unable_to_verify",
        detail: `Not compared: ${why}.`,
      });
    return { key: "reference", label, status: "unavailable", detail: `Not compared: ${why}.` };
  }
  let copied = 0;
  for (const l of withRef)
    for (const item of cmp.items.filter((i) => i.key.startsWith(`typography.h${l}.`))) {
      copied += 1;
      c.items.push({
        ...item,
        key: `reference.${item.key}`,
        detail: `${item.detail ? `${item.detail}. ` : ""}Compared by the Design comparison step${item.verdict === "confirmed_mismatch" || item.verdict === "potential_mismatch" ? "; its finding is listed under Design comparison (not repeated here)" : ""}.`,
      });
    }
  return {
    key: "reference",
    label,
    status: "completed",
    detail: `${plural(copied, "heading value")} from the confirmed design reference (${withRef.map((l) => `H${l}`).join(", ")}) compared by the Design comparison step in this scan; mismatches are reported there once.`,
  };
}

// ---- fonts -------------------------------------------------------------------------------------

function fontChecks(c: Ctx, design: StepResultRecord | null): CheckPart {
  const approved = c.ctx.approvedFonts ?? [];
  const approvedNames = new Set(approved.flatMap((f) => f.families.map(norm)));
  const widestData = c.data.filter((s) => s.capture.width === c.widest);
  const rendered = widestData.flatMap((s) =>
    (s.q.rendered?.samples ?? []).map((r) => ({ ...s, r })),
  );
  const renderErrors = widestData.filter((s) => s.q.rendered?.error).length;
  // Families already reported by the design comparison as "web font failed to load".
  const designItems =
    (design?.checks as { comparison?: { items?: ComparisonItem[] } } | null)?.comparison?.items ??
    [];
  const reportedByDesign = new Set(
    designItems
      .filter((i) => /fontFamily$/.test(i.key) && /web font failed to load/.test(i.actual ?? ""))
      .map((i) => norm(firstFamily(i.actual))),
  );

  const notRendered = new Map<
    string,
    Array<{
      s: Sample;
      declared: string;
      fonts: string[];
      text: string;
      selector: string;
      box: Box | null;
    }>
  >();
  const renderedOk = new Map<string, number>();
  for (const x of rendered) {
    if (x.r.error || !x.r.fonts.length) continue;
    const declared = firstFamily(x.r.declared);
    if (!declared || GENERIC_FAMILIES.has(norm(declared))) continue;
    const used = x.r.fonts.sort((a, b) => b.glyphCount - a.glyphCount);
    // A web font file's own family name often extends the CSS name with its style or width
    // ("PP Neue Machina Plain", "IBM Plex Sans SemiCondensed" for a variable font): still the
    // declared font, not a fallback.
    const compact = (s: string) => norm(s).replace(/[\s-]+/g, "");
    const matched = used.some(
      (f) =>
        norm(f.familyName) === norm(declared) ||
        norm(f.postScriptName ?? "") === norm(declared) ||
        (f.isCustomFont &&
          (norm(f.familyName).startsWith(`${norm(declared)} `) ||
            compact(f.postScriptName ?? "").startsWith(compact(declared)))),
    );
    const faces = x.q.fonts.filter((f) => norm(f.family) === norm(declared));
    const el =
      x.r.kind === "heading"
        ? x.q.headings.find((h) => h.index === x.r.index)
        : x.q.paragraphs.find((p) => p.index === x.r.index);
    if (matched) {
      renderedOk.set(norm(declared), (renderedOk.get(norm(declared)) ?? 0) + 1);
      continue;
    }
    if (faces.length) {
      notRendered.set(norm(declared), [
        ...(notRendered.get(norm(declared)) ?? []),
        {
          s: x,
          declared,
          fonts: used.map(
            (f) =>
              `${f.familyName}${f.isCustomFont ? " (web font)" : " (installed font)"} ×${f.glyphCount}`,
          ),
          text: el?.text ?? "",
          selector: el?.selector ?? "",
          box: el?.box ?? null,
        },
      ]);
    } else
      c.checks.inconclusive.push({
        check: `Font “${declared}”`,
        reason: `“${declared}” is not loaded as a web font; the scan browser rendered ${used.map((f) => `“${f.familyName}”`).join(", ")}. Whether visitors' devices have “${declared}” installed cannot be verified.`,
        pageUrl: displayUrl(x.page),
      });
  }
  c.checks.evaluated += rendered.length;
  for (const [family, list] of notRendered) {
    if (reportedByDesign.has(family)) {
      c.checks.notes.push(
        `The web font “${list[0]!.declared}” did not render; this is already reported by the Design comparison (font family) and is not repeated here.`,
      );
      continue;
    }
    const first = list[0]!;
    const faces = first.s.q.fonts.filter((f) => norm(f.family) === family);
    const pages = [...new Set(list.map((x) => displayUrl(x.s.page)))];
    c.findings.push({
      ruleId: DQ_RULES.webfontNotRendered,
      title: `Web font “${first.declared}” is declared but a fallback font is shown`,
      message: `The page CSS asks for the web font “${first.declared}”, but Chromium's font engine drew the text with ${first.fonts.join(", ")} on ${plural(pages.length, "page")}. The web font file did not load or does not contain the needed characters, so visitors see a substitute font. Web font status reported by the page: ${faces.map((f) => `${f.weight} ${f.style}: ${f.status}`).join(", ") || "unknown"}.`,
      subcategory: "typography",
      pageId: first.s.page.id,
      pageUrl: null,
      selector: first.selector || null,
      viewport: null,
      severity: "medium",
      verdict: "confirmed",
      confidence: 0.95,
      expected: `Text rendered with “${first.declared}”`,
      actual: `Rendered with ${first.fonts[0] ?? "another font"}`,
      fingerprintKey: `webfont:${family}`,
      evidence: [
        {
          kind: "computed_style",
          data: {
            property:
              "font-family (declared) / platform fonts used (Chromium DevTools CSS.getPlatformFontsForNode)",
            declaredFamily: first.declared,
            webFontFaces: faces.slice(0, 10),
            observations: sample(list, 10).items.map((x) => ({
              page: displayUrl(x.s.page),
              viewport: x.s.capture.viewport,
              selector: x.selector,
              text: x.text,
              renderedWith: x.fonts,
            })),
          },
        },
        ...screenshot(first.s.capture, first.box ? [first.box] : []),
      ],
    });
  }

  // Uploaded brand fonts: are headings and body text set in them?
  if (approved.length) {
    const declaredUse = new Map<
      string,
      {
        roles: Set<string>;
        count: number;
        pages: Set<string>;
        s: Sample;
        selector: string;
        box: Box;
      }
    >();
    for (const s of widestData)
      for (const el of [...s.q.headings.filter((h) => !h.inChrome), ...s.q.paragraphs]) {
        const fam = firstFamily(el.fontFamily);
        if (!fam || approvedNames.has(norm(fam))) continue;
        const role = "level" in el ? `H${(el as QHeading).level} headings` : "body text";
        const e = declaredUse.get(norm(fam)) ?? {
          roles: new Set<string>(),
          count: 0,
          pages: new Set<string>(),
          s,
          selector: el.selector,
          box: el.box,
        };
        e.roles.add(role);
        e.count += 1;
        e.pages.add(displayUrl(s.page));
        declaredUse.set(norm(fam), e);
      }
    const approvedList = [...new Set(approved.flatMap((f) => f.families.slice(0, 1)))];
    for (const [family, u] of declaredUse) {
      const display = firstFamily(
        [...u.s.q.headings, ...u.s.q.paragraphs].find(
          (e) => norm(firstFamily(e.fontFamily)) === family,
        )?.fontFamily,
      );
      c.findings.push({
        ruleId: DQ_RULES.fontNotApproved,
        title: `Text uses “${display}”, which is not one of the uploaded brand fonts`,
        message: `${[...u.roles].join(" and ")} on ${plural(u.pages.size, "page")} are set in “${display}” (${plural(u.count, "element")} measured at ${c.widest}px). The project's uploaded font files are: ${approvedList.map((f) => `“${f}”`).join(", ")}. If the brand allows other fonts for this text, this can be ignored.`,
        subcategory: "typography",
        pageId: u.s.page.id,
        pageUrl: null,
        selector: u.selector,
        viewport: null,
        severity: "low",
        verdict: "potential",
        confidence: 0.7,
        expected: `One of the uploaded brand fonts: ${approvedList.join(", ")}`,
        actual: `“${display}” (${[...u.roles].join(", ")})`,
        fingerprintKey: `font-not-approved:${family}`,
        evidence: [
          {
            kind: "design_token",
            data: {
              token: "approved fonts",
              expected: approvedList.join(", "),
              source: `uploaded font files: ${approved.map((f) => f.filename).join(", ")}`,
              tolerance: "first family in the CSS font-family list, compared case-insensitively",
            },
          },
          {
            kind: "computed_style",
            data: {
              property: "font-family",
              declaredFamily: display,
              usedBy: [...u.roles],
              elements: u.count,
              pages: [...u.pages].slice(0, 10),
              sampleSelector: u.selector,
            },
          },
          ...screenshot(u.s.capture, [u.box]),
        ],
      });
    }
    for (const f of approved) {
      const names = f.families.map(norm);
      const ok = names.reduce((n, x) => n + (renderedOk.get(x) ?? 0), 0);
      const failed = names.some((x) => notRendered.has(x));
      const declared = widestData.some((s) =>
        [...s.q.headings, ...s.q.paragraphs].some((e) =>
          names.includes(norm(firstFamily(e.fontFamily))),
        ),
      );
      c.items.push({
        key: `font.${f.id}`,
        label: `Brand font “${f.families[0] ?? f.filename}” (${f.filename})`,
        verdict: failed ? "confirmed_mismatch" : ok ? "match" : "unable_to_verify",
        expected: "Used and rendered on the website",
        actual: failed
          ? "Declared in CSS but a fallback font was drawn"
          : ok
            ? `Rendered (verified by the browser's font engine on ${plural(ok, "sampled element")})`
            : declared
              ? "Declared in CSS; rendering could not be verified"
              : "Not used by the measured headings or body text",
        reference: `uploaded font file ${f.filename}`,
        detail: null,
      });
    }
  }
  const parts: string[] = [];
  parts.push(
    rendered.length
      ? `${plural(rendered.length, "text sample")} checked with Chromium's font engine at ${c.widest}px`
      : "font rendering could not be sampled",
  );
  if (approved.length)
    parts.push(
      `${plural(approved.length, "uploaded font file")} compared with the fonts the headings and body text use`,
    );
  else parts.push("no font files uploaded, so only rendering was checked");
  if (renderErrors)
    c.checks.inconclusive.push({
      check: "Rendered fonts",
      reason: `The browser's font engine could not be queried on ${plural(renderErrors, "page")}.`,
      pageUrl: null,
    });
  return {
    key: "fonts",
    label: "Fonts (rendering and uploaded brand fonts)",
    status: rendered.length ? "completed" : "inconclusive",
    detail: `${parts.join("; ")}.`,
  };
}

// ---- images ------------------------------------------------------------------------------------

function imageChecks(c: Ctx): CheckPart {
  let measured = 0;
  let broken = 0;
  let skippedSmall = 0;
  let svg = 0;
  const upscaled = new Map<string, Array<{ s: Sample; img: QImage; scale: number }>>();
  const distorted = new Map<string, Array<{ s: Sample; img: QImage; ratio: number }>>();
  for (const s of c.data)
    for (const img of s.q.images) {
      if (!img.visible) continue;
      if (img.broken) {
        broken += 1;
        continue;
      }
      if (img.isSvg) {
        svg += 1;
        continue;
      }
      if (!img.naturalWidth || !img.naturalHeight) continue;
      if (img.renderedWidth < MIN_IMAGE_PX || img.renderedHeight < MIN_IMAGE_PX) {
        skippedSmall += 1;
        continue;
      }
      measured += 1;
      const scale = displayScale(img);
      if (scale >= UPSCALE_POTENTIAL)
        upscaled.set(img.src, [...(upscaled.get(img.src) ?? []), { s, img, scale }]);
      const ratio = aspectDistortion(img);
      if (ratio > DISTORTION_TOLERANCE)
        distorted.set(img.src, [...(distorted.get(img.src) ?? []), { s, img, ratio }]);
    }
  c.checks.evaluated += measured;
  for (const [src, list] of upscaled) {
    const worst = list.sort((a, b) => b.scale - a.scale)[0]!;
    const confirmed = worst.scale >= UPSCALE_CONFIRMED;
    const pages = [...new Set(list.map((x) => displayUrl(x.s.page)))];
    c.findings.push({
      ruleId: DQ_RULES.imageUpscaled,
      title: `Image shown ${round(worst.scale, 1)}× larger than its source resolution`,
      message: `The image ${src.slice(0, 300)} is ${worst.img.naturalWidth}×${worst.img.naturalHeight}px but is displayed at ${round(worst.img.renderedWidth)}×${round(worst.img.renderedHeight)}px (${worst.s.capture.viewport}, object-fit: ${worst.img.objectFit || "fill"}), i.e. enlarged ${round(worst.scale, 2)}× even on a standard-density screen, on ${plural(pages.length, "page")}. Enlarged images look soft or pixelated; high-density (2×) screens need twice the resolution. Measured from the image's intrinsic and displayed size; the scan does not judge blur or compression from the pixels.`,
      subcategory: "images",
      pageId: worst.s.page.id,
      pageUrl: null,
      selector: worst.img.selector,
      viewport: null,
      severity: worst.scale >= 2 ? "medium" : "low",
      verdict: confirmed ? "confirmed" : "potential",
      confidence: confirmed ? 0.9 : 0.6,
      expected: `Source at least ${Math.ceil(worst.img.renderedWidth)}×${Math.ceil(worst.img.renderedHeight)}px (displayed size at 1× density)`,
      actual: `${worst.img.naturalWidth}×${worst.img.naturalHeight}px source, enlarged ${round(worst.scale, 2)}×`,
      fingerprintKey: `upscaled:${src.slice(0, 500)}`,
      evidence: [
        {
          kind: "measurement",
          data: {
            src: src.slice(0, 1000),
            naturalWidth: worst.img.naturalWidth,
            naturalHeight: worst.img.naturalHeight,
            devicePixelRatio: 1,
            thresholds: `≥ ${UPSCALE_CONFIRMED}× confirmed; ${UPSCALE_POTENTIAL}–${UPSCALE_CONFIRMED}× needs review`,
            observations: sample(list, 10).items.map((x) => ({
              page: displayUrl(x.s.page),
              viewport: x.s.capture.viewport,
              selector: x.img.selector,
              rendered: `${round(x.img.renderedWidth)}×${round(x.img.renderedHeight)}px`,
              objectFit: x.img.objectFit || "fill",
              scale: round(x.scale, 2),
            })),
          },
        },
        ...screenshot(worst.s.capture, [worst.img.box]),
      ],
    });
  }
  for (const [src, list] of distorted) {
    const worst = list.sort((a, b) => b.ratio - a.ratio)[0]!;
    const pages = [...new Set(list.map((x) => displayUrl(x.s.page)))];
    const naturalRatio = round(worst.img.naturalWidth / worst.img.naturalHeight, 3);
    const renderedRatio = round(worst.img.renderedWidth / worst.img.renderedHeight, 3);
    c.findings.push({
      ruleId: DQ_RULES.imageDistorted,
      title: `Image is stretched: aspect ratio changed by ${Math.round(worst.ratio * 100)}%`,
      message: `The image ${src.slice(0, 300)} has an aspect ratio of ${naturalRatio} (${worst.img.naturalWidth}×${worst.img.naturalHeight}px) but is drawn into a ${round(worst.img.renderedWidth)}×${round(worst.img.renderedHeight)}px box (ratio ${renderedRatio}) with object-fit: fill at ${worst.s.capture.viewport}, on ${plural(pages.length, "page")}, so it appears stretched or squashed.`,
      subcategory: "images",
      pageId: worst.s.page.id,
      pageUrl: null,
      selector: worst.img.selector,
      viewport: null,
      severity: worst.ratio > 0.15 ? "medium" : "low",
      verdict: "confirmed",
      confidence: 0.9,
      expected: `Aspect ratio ${naturalRatio} (±${DISTORTION_TOLERANCE * 100}%)`,
      actual: `Displayed at ratio ${renderedRatio}`,
      fingerprintKey: `distorted:${src.slice(0, 500)}`,
      evidence: [
        {
          kind: "measurement",
          data: {
            src: src.slice(0, 1000),
            naturalWidth: worst.img.naturalWidth,
            naturalHeight: worst.img.naturalHeight,
            tolerance: `aspect ratio may change by at most ${DISTORTION_TOLERANCE * 100}%`,
            observations: sample(list, 10).items.map((x) => ({
              page: displayUrl(x.s.page),
              viewport: x.s.capture.viewport,
              selector: x.img.selector,
              rendered: `${round(x.img.renderedWidth)}×${round(x.img.renderedHeight)}px`,
              distortion: `${Math.round(x.ratio * 100)}%`,
            })),
          },
        },
        ...screenshot(worst.s.capture, [worst.img.box]),
      ],
    });
  }
  if (broken)
    c.checks.notes.push(
      `${plural(broken, "image")} did not display; broken images are reported by the Responsive / visual and Broken links scanners and are not repeated here. Missing alternative text is checked by the Accessibility scanner.`,
    );
  c.checks.notes.push(
    `Image clarity is judged from intrinsic vs displayed size at 1× pixel density (${plural(measured, "image")} measured; ${skippedSmall} smaller than ${MIN_IMAGE_PX}px and ${svg} SVG image(s) skipped). Blur, compression artifacts and other pixel-level quality are not assessed.`,
  );
  return {
    key: "images",
    label: "Image clarity",
    status: "completed",
    detail: `${plural(measured, "displayed image")} measured for enlargement beyond the source resolution and stretched aspect ratios.`,
  };
}

// ---- spacing and alignment ---------------------------------------------------------------------

function layoutChecks(c: Ctx, spec: DesignSpec | null): CheckPart {
  const scale = spec?.spacing.scale;
  const widestData = c.data.filter((s) => s.capture.width === c.widest);
  if (scale) {
    const onScale = (v: number) => scale.values.some((x) => Math.abs(x - v) <= SIZE_TOLERANCE);
    const off = new Map<
      string,
      {
        property: string;
        value: number;
        count: number;
        sample: string;
        pages: Set<string>;
        s: Sample;
      }
    >();
    let total = 0;
    let offTotal = 0;
    for (const s of widestData)
      for (const sp of s.q.spacing) {
        total += sp.count;
        if (onScale(sp.value)) continue;
        offTotal += sp.count;
        const key = `${sp.property}:${sp.value}`;
        const e = off.get(key) ?? { ...sp, count: 0, pages: new Set<string>(), s };
        e.count += sp.count;
        e.pages.add(displayUrl(s.page));
        off.set(key, e);
      }
    c.checks.evaluated += total;
    const ranked = [...off.values()].sort((a, b) => b.count - a.count);
    if (offTotal >= 3 && ranked.length) {
      const first = ranked[0]!;
      const reference = describeSource(scale.source);
      c.findings.push({
        ruleId: DQ_RULES.spacingOffScale,
        title: `${plural(ranked.length, "spacing value")} not on the design reference's spacing scale`,
        message: `At ${c.widest}px, ${offTotal} of ${total} measured margins, paddings and gaps of content elements use values that are not on the spacing scale ${scale.values.join(", ")}px (${reference}). Most frequent: ${ranked
          .slice(0, 5)
          .map((r) => `${r.value}px ${r.property} ×${r.count}`)
          .join(
            ", ",
          )}. Some values (browser defaults, borders, optical adjustments) can be intentional, so this needs review.`,
        subcategory: "layout",
        pageId: first.s.page.id,
        pageUrl: null,
        selector: first.sample,
        viewport: null,
        severity: "low",
        verdict: "potential",
        confidence: 0.5,
        expected: `Spacing from the scale: ${scale.values.join(", ")}px`,
        actual: ranked
          .slice(0, 5)
          .map((r) => `${r.value}px`)
          .join(", "),
        fingerprintKey: "spacing-off-scale",
        evidence: [
          {
            kind: "design_token",
            data: {
              token: "spacing.scale",
              expected: `${scale.values.join(", ")}px`,
              source: reference,
              tolerance: `±${SIZE_TOLERANCE}px`,
              comparedAt: `widest viewport (${c.widest}px)`,
            },
          },
          {
            kind: "measurement",
            data: {
              measured: total,
              offScale: offTotal,
              values: ranked.slice(0, 15).map((r) => ({
                property: r.property,
                value: `${r.value}px`,
                count: r.count,
                sample: r.sample,
                pages: [...r.pages].slice(0, 5),
              })),
            },
          },
        ],
      });
    }
  }

  const near = new Map<string, Array<{ s: Sample; a: QAlignment }>>();
  for (const s of c.data)
    for (const a of s.q.alignment) near.set(a.parent, [...(near.get(a.parent) ?? []), { s, a }]);
  for (const [parent, list] of [...near.entries()].slice(0, MAX_LAYOUT_FINDINGS)) {
    const first = list.sort((x, y) => y.s.capture.width - x.s.capture.width)[0]!;
    const pages = [...new Set(list.map((x) => displayUrl(x.s.page)))];
    c.findings.push({
      ruleId: DQ_RULES.alignmentNearMiss,
      title: `Stacked elements are almost, but not exactly, aligned (${first.a.offsetPx}px apart)`,
      message: `Inside ${parent}, ${first.a.a.selector} starts at x=${first.a.a.left}px and the element below it, ${first.a.b.selector}, at x=${first.a.b.left}px (${first.s.capture.viewport}) on ${plural(pages.length, "page")}. A left-edge offset of 1–4px between stacked blocks is usually unintended; a deliberate indent is normally larger. Needs review.`,
      subcategory: "layout",
      pageId: first.s.page.id,
      pageUrl: null,
      selector: first.a.b.selector,
      viewport: null,
      severity: "low",
      verdict: "potential",
      confidence: 0.5,
      expected: "Stacked blocks share the same left edge (or differ by a deliberate indent)",
      actual: `${first.a.offsetPx}px offset`,
      fingerprintKey: `alignment:${parent}`,
      evidence: [
        {
          kind: "measurement",
          data: {
            rule: "left edges of consecutive stacked, left-aligned block siblings differ by more than 1px and at most 4px",
            parent,
            observations: sample(list, 8).items.map((x) => ({
              page: displayUrl(x.s.page),
              viewport: x.s.capture.viewport,
              upper: `${x.a.a.selector} at x=${x.a.a.left}px`,
              lower: `${x.a.b.selector} at x=${x.a.b.left}px`,
              offsetPx: x.a.offsetPx,
            })),
          },
        },
        ...screenshot(first.s.capture, [first.a.a.box, first.a.b.box]),
      ],
    });
  }

  const uneven = new Map<string, Array<{ s: Sample; g: QGap }>>();
  for (const s of c.data)
    for (const g of s.q.gaps) {
      const key = `${g.parent}|${g.item}`;
      uneven.set(key, [...(uneven.get(key) ?? []), { s, g }]);
    }
  for (const [key, list] of [...uneven.entries()].slice(0, MAX_LAYOUT_FINDINGS)) {
    const first = list.sort((x, y) => y.s.capture.width - x.s.capture.width)[0]!;
    const pages = [...new Set(list.map((x) => displayUrl(x.s.page)))];
    const g = first.g;
    const counts = new Map<number, number>();
    for (const v of g.gaps) counts.set(v, (counts.get(v) ?? 0) + 1);
    const common = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    c.findings.push({
      ruleId: DQ_RULES.spacingInconsistent,
      title: `Uneven ${g.axis} spacing between repeated ${g.item} items`,
      message: `The ${plural(g.items.length, "repeated item")} (${g.item}) inside ${g.parent} are separated by ${g.gaps.map((v) => `${v}px`).join(", ")} (${g.axis}, ${first.s.capture.viewport}) on ${plural(pages.length, "page")}. Items of the same kind are usually evenly spaced; the differences exceed 2px. Needs review.`,
      subcategory: "layout",
      pageId: first.s.page.id,
      pageUrl: null,
      selector: g.items[0]?.selector ?? g.parent,
      viewport: null,
      severity: "low",
      verdict: "potential",
      confidence: 0.5,
      expected: `Equal gaps (most common: ${common}px)`,
      actual: g.gaps.map((v) => `${v}px`).join(", "),
      fingerprintKey: `gaps:${key}`,
      evidence: [
        {
          kind: "measurement",
          data: {
            rule: "gaps between ≥ 3 consecutive siblings with the same tag and classes, laid out in one row or column, differ by more than 2px",
            parent: g.parent,
            item: g.item,
            axis: g.axis,
            gapsPx: g.gaps,
            observations: sample(list, 6).items.map((x) => ({
              page: displayUrl(x.s.page),
              viewport: x.s.capture.viewport,
              gapsPx: x.g.gaps,
            })),
          },
        },
        ...screenshot(
          first.s.capture,
          g.items.slice(0, 6).map((i) => i.box),
        ),
      ],
    });
  }
  const groups = c.data.reduce((n, s) => n + s.q.alignment.length + s.q.gaps.length, 0);
  c.checks.evaluated += groups;
  if (near.size > MAX_LAYOUT_FINDINGS || uneven.size > MAX_LAYOUT_FINDINGS)
    c.checks.notes.push(
      `Only the first ${MAX_LAYOUT_FINDINGS} alignment and ${MAX_LAYOUT_FINDINGS} spacing groups are reported as findings.`,
    );
  c.checks.inconclusive.push({
    check: "Spacing and alignment against design frames",
    reason:
      "Not available: the design reference holds values (colors, fonts, spacing scale), not page layouts mapped to website pages, so element positions cannot be compared with a Figma frame.",
    pageUrl: null,
  });
  return {
    key: "layout",
    label: "Spacing and alignment",
    status: "completed",
    detail: `${scale ? `Spacing compared with the reference scale (${scale.values.join(", ")}px) at ${c.widest}px; ` : "No spacing scale in the design reference, so spacing values were checked for internal consistency only; "}sibling groups checked for near-miss alignment and uneven gaps.`,
  };
}

// ---- approved content (cross-reference to the content comparison) ------------------------------

function contentPart(c: Ctx, content: StepResultRecord | null): CheckPart {
  const label = "Approved-content verification";
  if (!c.ctx.references.content)
    return {
      key: "content",
      label,
      status: "not_configured",
      detail:
        "Skipped: no processed approved content document is attached to this scan, so there is no approved text to verify against.",
    };
  if (!content)
    return {
      key: "content",
      label,
      status: "unavailable",
      detail: "The content comparison did not run in this scan.",
    };
  if (content.status !== "completed")
    return {
      key: "content",
      label,
      status: content.status === "failed" ? "failed" : "unavailable",
      detail: `The content comparison ended as ${content.status}: ${content.error ?? content.statusReason ?? "no reason recorded"}.`,
    };
  const cmp = (content.checks as { comparison?: ReturnType<typeof summarize> } | null)?.comparison;
  return {
    key: "content",
    label,
    status: "completed",
    detail: cmp
      ? `Checked by the Content comparison step: ${cmp.matched} matched, ${cmp.confirmedMismatch} confirmed mismatch(es), ${cmp.potentialMismatch} need review, ${cmp.unableToVerify} unable to verify. Its ${plural(content.findingCount, "finding")} are listed under Content comparison (not repeated here).`
      : `Checked by the Content comparison step (${plural(content.findingCount, "finding")}, listed under Content comparison).`,
  };
}

// ---- scanner ----------------------------------------------------------------------------------

const PROBLEM = new Set(["failed", "unavailable"]);

export const designQualityScanner: Scanner = {
  key: "design_quality",
  idPrefix: "DQ",
  version: "1.0.0",
  async run(ctx: ScannerContext) {
    const checks: Ctx["checks"] = { evaluated: 0, inconclusive: [], notes: [], parts: [] };
    const findings: FindingDraft[] = [];
    const items: ComparisonItem[] = [];
    const [design, content] = await Promise.all([
      ctx.stepResult?.("design") ?? null,
      ctx.stepResult?.("content") ?? null,
    ]);
    const data: Sample[] = [];
    let missing = 0;
    for (const page of analyzablePages(ctx.pages))
      for (const capture of page.captures) {
        if (capture.error) continue;
        const q = (await capture.loadQuality()) as QualityData | null;
        if (q && Array.isArray(q.headings)) data.push({ page, capture, q });
        else missing += 1;
      }
    const c: Ctx = {
      ctx,
      data,
      widest: Math.max(...ctx.viewports.map((v) => v.width)),
      findings,
      checks,
      items,
    };
    const spec = ctx.references.designSpec?.spec ?? null;
    const tool = {
      toolName: "Design quality (computed styles, Chromium font engine, DOM geometry)",
      toolVersion: "1.0.0",
    };
    if (!data.length) {
      checks.parts.push(
        {
          key: "headings",
          label: "Heading typography (H1–H6)",
          status: "unavailable",
          detail: "No page capture contains design-quality measurements.",
        },
        contentPart(c, content),
      );
      return {
        status: "inconclusive" as const,
        statusReason:
          "No page capture contains design-quality measurements, so typography, images and layout could not be checked",
        findings,
        checks,
        ...tool,
      };
    }
    if (missing)
      checks.notes.push(
        `${plural(missing, "capture")} had no design-quality measurements and ${missing === 1 ? "was" : "were"} not checked.`,
      );
    checks.parts.push(headingChecks(c));
    checks.parts.push(referenceChecks(c, spec, design));
    checks.parts.push(fontChecks(c, design));
    checks.parts.push(imageChecks(c));
    checks.parts.push(layoutChecks(c, spec));
    checks.parts.push(contentPart(c, content));
    checks.comparison = summarize(items);
    checks.notes.push(
      "Measured at each captured screen size; typography consistency compares headings of the same level at the same screen size. A clean result here does not mean the site matches the design visually in every respect.",
    );
    const done = checks.parts.filter((p) => p.status === "completed").map((p) => p.label);
    const problems = checks.parts.filter((p) => PROBLEM.has(p.status));
    const skipped = checks.parts.filter((p) => p.status === "not_configured").map((p) => p.label);
    const summary = `${plural(data.length, "page capture")}; ${plural(findings.length, "finding")}`;
    if (problems.length)
      return {
        status: "inconclusive" as const,
        statusReason: `Partially completed (${summary}). Completed: ${done.join(", ") || "none"}. Not available: ${problems.map((p) => `${p.label} (${p.detail})`).join("; ")}${skipped.length ? `. Not configured: ${skipped.join(", ")}` : ""}.`,
        findings,
        checks,
        ...tool,
      };
    return {
      status: "completed" as const,
      statusReason: `${summary}. Checked: ${done.join(", ")}${skipped.length ? `. Not configured: ${skipped.join(", ")}` : ""}.`,
      findings,
      checks,
      ...tool,
    };
  },
};
