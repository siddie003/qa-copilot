/**
 * Fix guide for one issue occurrence (issue explanations). Builds what a developer or a
 * non-technical owner needs to act on an issue: a plain summary (what is wrong, why it matters,
 * what to do next), step-by-step remediation, before/after code where the evidence supports it,
 * caveats, verification steps and what the scan could not tell.
 *
 * Grounding rules:
 *  - Every page, element, HTML snippet, header, URL and measurement shown is read from the stored
 *    findings and their evidence. The wording per rule is fixed text in this file (and the rule
 *    explanations in `./explain`).
 *  - "Before" code is either copied from the evidence ("observed") or a minimal representation
 *    built only from evidence values ("illustrative"). "After" code is always a suggestion.
 *    Decisions the scan cannot make (what an image shows, the page language, the right link) are
 *    left as [placeholders in square brackets]; the guide never guesses them.
 *  - Values the guide calculates (a contrast-safe color) are labelled as calculated.
 *  - An AI explanation is used only when the issue stores one that passed grounding; code
 *    examples are never AI-written.
 *  - Nothing here marks an issue fixed: verification always ends with a new scan.
 *
 * Pure and browser-safe (used by the web app's server components and the report builder).
 */

import { explainIssue, rescanAdvice, VERDICT_MEANINGS } from "./explain";

export interface GuideEvidence {
  kind: string;
  data: Record<string, unknown>;
}

export interface GuideFinding {
  displayId: string;
  selector: string | null;
  viewport: string | null;
  pageUrl: string | null;
  expected: string | null;
  actual: string | null;
  evidence: GuideEvidence[];
}

/**
 * AI-written explanation stored with an issue (only the parts that passed grounding; absent parts
 * fall back to the rule guide).
 */
export interface AiExplanation {
  problem?: string;
  impact?: string;
  nextStep?: string;
  steps?: string[];
  caveats?: string[];
}

export interface GuideIssue {
  category: string;
  ruleId: string | null;
  verdict: string;
  affectedUrls: string[];
  affectedElement: string | null;
  /** The stored fix guidance (AI-written and grounded, or the rule catalog's). */
  recommendation: string | null;
  findings: GuideFinding[];
  explanation?: AiExplanation | null;
}

export type CodeLanguage = "html" | "css" | "http" | "jsx" | "text";

export interface CodeExample {
  title: string;
  language: CodeLanguage;
  before: string | null;
  /** observed: copied from the scan evidence; illustrative: minimal form built from evidence values. */
  beforeOrigin: "observed" | "illustrative" | null;
  after: string;
  /** What the change does and why. */
  explanation: string;
}

export interface GuideFact {
  label: string;
  value: string;
  /** Render as code (selectors, URLs, header values). */
  code?: boolean;
}

export type AiGuidePart = "problem" | "whyItMatters" | "nextAction" | "steps" | "caveats";

export interface IssueGuide {
  problem: string;
  whyItMatters: string;
  nextAction: string;
  /** Parts written by AI (grounded) instead of the fixed rule wording. */
  aiParts: AiGuidePart[];
  /** The affected element's HTML as recorded by the scanner. */
  snippet: { html: string; findingId: string } | null;
  /** Measured or recorded values from the evidence. */
  facts: GuideFact[];
  steps: string[];
  examples: CodeExample[];
  caveats: string[];
  verify: string[];
  /** What the scan could not determine, and what a person must check instead. */
  gaps: string[];
  /** False when no rule-specific guide exists (general steps built from the stored guidance). */
  specific: boolean;
}

// ---------------------------------------------------------------------------------------------
// Evidence access

interface Ctx {
  issue: GuideIssue;
  findings: GuideFinding[];
  pages: string[];
  viewports: string[];
  selectors: string[];
  snippet: { html: string; findingId: string } | null;
  /** Evidence data of one kind across all findings, in finding order. */
  ev(kind: string): Array<Record<string, unknown>>;
  /** First non-empty string at data[key] in evidence of this kind (any kind when null). */
  str(kind: string | null, key: string): string | null;
}

const isStr = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function context(issue: GuideIssue): Ctx {
  const findings = issue.findings;
  const pages = issue.affectedUrls.length
    ? issue.affectedUrls
    : [...new Set(findings.map((f) => f.pageUrl).filter(isStr))];
  const viewports = [...new Set(findings.map((f) => f.viewport).filter(isStr))];
  const selectors = [
    ...new Set([issue.affectedElement, ...findings.map((f) => f.selector)].filter(isStr)),
  ];
  const ev = (kind: string) =>
    findings.flatMap((f) => f.evidence.filter((e) => e.kind === kind).map((e) => e.data ?? {}));
  const str = (kind: string | null, key: string) => {
    for (const f of findings)
      for (const e of f.evidence) {
        if (kind && e.kind !== kind) continue;
        const v = e.data?.[key];
        if (isStr(v)) return v;
      }
    return null;
  };
  let snippet: Ctx["snippet"] = null;
  for (const f of findings) {
    for (const e of f.evidence) {
      const d = e.data ?? {};
      const html =
        e.kind === "axe_node" || e.kind === "html_snippet"
          ? d.html
          : e.kind === "computed_style"
            ? d.element
            : e.kind === "link_check" && Array.isArray(d.linkedFrom)
              ? (d.linkedFrom[0] as Record<string, unknown> | undefined)?.html
              : undefined;
      if (isStr(html) && html.trim().startsWith("<")) {
        snippet = { html: html.trim(), findingId: f.displayId };
        break;
      }
    }
    if (snippet) break;
  }
  return { issue, findings, pages, viewports, selectors, snippet, ev, str };
}

// ---------------------------------------------------------------------------------------------
// Text helpers

const short = (s: string, max = 160) => (s.length > max ? `${s.slice(0, max)}…` : s);
const lowerFirst = (s: string) => (s ? s[0]!.toLowerCase() + s.slice(1) : s);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const code = (s: string) => `\`${short(s.replace(/`/g, "'"), 200)}\``;

function pagePhrase(c: Ctx): string {
  if (!c.pages.length) return "the site";
  if (c.pages.length === 1) return c.pages[0]!;
  return `the ${c.pages.length} listed pages (for example ${c.pages[0]})`;
}

function elementPhrase(c: Ctx, noun: string): string {
  if (!c.selectors.length) return noun;
  if (c.selectors.length === 1) return `${noun} ${code(c.selectors[0]!)}`;
  return `${noun} (${c.selectors.length} elements, for example ${code(c.selectors[0]!)})`;
}

/** First step of most guides: where to look. */
function locate(c: Ctx, noun: string): string {
  const at = c.viewports.length ? ` at the ${c.viewports.join(" / ")} screen size` : "";
  return `Open ${pagePhrase(c)}${at} and find ${elementPhrase(c, noun)}. In the browser, right-click it and choose Inspect, or paste the selector into the developer tools' element search.`;
}

const SOURCE_STEP =
  "Make the change where the element is produced — the template, component, theme or CMS field — not in the browser, so the change reaches every page that uses it. The scan sees the page as delivered to the browser, not your source files.";

/** Sentences of the stored guidance (AI or catalog) as steps, without the trailing doc link. */
function recommendationSteps(rec: string | null): string[] {
  if (!rec?.trim()) return [];
  return rec
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=[A-Z])/))
    .map((s) => s.replace(/^\s*(\d+[.)]|[-*•])\s*/, "").trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------------------------
// HTML helpers (operate on recorded snippets only; never fetch or render them)

const START_TAG = /<([a-zA-Z][\w-]*)(\s[^<>]*?)?\s*(\/?)>/g;

function findStartTag(html: string, tag?: string) {
  START_TAG.lastIndex = 0;
  for (let m = START_TAG.exec(html); m; m = START_TAG.exec(html))
    if (!tag || m[1]!.toLowerCase() === tag) return m;
  return null;
}

function attrRe(name: string) {
  return new RegExp(`\\s${name}(\\s*=\\s*("[^"]*"|'[^']*'|[^\\s"'>]+))?`, "i");
}

/** Value of an attribute on the first (matching) start tag, or null. */
export function attrOf(html: string | null, name: string, tag?: string): string | null {
  if (!html) return null;
  const m = findStartTag(html, tag);
  const a = m && attrRe(name).exec(m[0]);
  if (!a) return null;
  return (a[2] ?? "").replace(/^["']|["']$/g, "");
}

/** The snippet with an attribute set on its first (matching) start tag; null without a complete tag. */
export function withAttribute(
  html: string,
  name: string,
  value: string,
  tag?: string,
): string | null {
  const m = findStartTag(html, tag);
  if (!m) return null;
  const t = m[0];
  const attr = ` ${name}="${value}"`;
  const next = attrRe(name).test(t)
    ? t.replace(attrRe(name), attr)
    : t.replace(/\s*(\/?)>$/, (_, slash: string) => `${attr}${slash ? " /" : ""}>`);
  return html.slice(0, m.index) + next + html.slice(m.index + t.length);
}

const isTruncated = (html: string) => html.endsWith("…");

// ---------------------------------------------------------------------------------------------
// Color helpers (WCAG relative luminance and contrast ratio)

function rgb(hex: string): [number, number, number] | null {
  const h = hex.trim().replace(/^#/, "");
  const channels = (pairs: string[]) =>
    pairs.map((x) => parseInt(x, 16)) as [number, number, number];
  if (/^[0-9a-f]{3}$/i.test(h)) return channels([...h].map((x) => x + x));
  if (/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(h)) {
    if (h.length === 8 && h.slice(6).toLowerCase() !== "ff") return null; // translucent
    return channels([h.slice(0, 2), h.slice(2, 4), h.slice(4, 6)]);
  }
  return null;
}

function luminance([r, g, b]: [number, number, number]): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a: string, b: string): number | null {
  const x = rgb(a);
  const y = rgb(b);
  if (!x || !y) return null;
  const [l1, l2] = [luminance(x), luminance(y)].sort((p, q) => q - p);
  return (l1! + 0.05) / (l2! + 0.05);
}

const toHex = (c: number[]) => `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;

/**
 * The text color closest to `fg` (mixed toward black or white, keeping its hue) that reaches the
 * target contrast on `bg`; null when the colors cannot be parsed or no mix reaches the target.
 */
export function contrastSafeColor(fg: string, bg: string, target: number): string | null {
  const f = rgb(fg);
  const b = rgb(bg);
  if (!f || !b) return null;
  const black = contrastRatio("#000000", bg)!;
  const white = contrastRatio("#ffffff", bg)!;
  const toward = black >= white ? [0, 0, 0] : [255, 255, 255];
  for (let t = 0; t <= 100; t += 1) {
    const mix = f.map((v, i) => Math.round(v + (toward[i]! - v) * (t / 100)));
    if (contrastRatio(toHex(mix), bg)! >= target) return toHex(mix);
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Platform hints (only when the recorded HTML or URLs show the platform)

type Platform = "wordpress" | "nextjs" | "shopify";

function detectPlatform(c: Ctx): Platform | null {
  const text = [c.snippet?.html ?? "", ...c.selectors, ...c.pages].join(" ");
  if (/\/wp-content\/|\/wp-includes\//i.test(text)) return "wordpress";
  if (/\/_next\/(image|static)/i.test(text)) return "nextjs";
  if (/cdn\.shopify\.com/i.test(text)) return "shopify";
  return null;
}

// ---------------------------------------------------------------------------------------------
// Rule guides

interface RuleGuide {
  /** Problem sentence tailored to the evidence (replaces the rule's general meaning). */
  problem?: string;
  nextAction: string;
  steps: string[];
  examples?: CodeExample[];
  caveats?: string[];
  facts?: GuideFact[];
  gaps?: string[];
  /** What to re-check for side effects after the fix. */
  regression?: string;
}

type GuideFn = (c: Ctx) => RuleGuide;

/** Facts from axe-core evidence: WCAG criteria, impact and axe's own explanation. */
function axeFacts(c: Ctx): GuideFact[] {
  const out: GuideFact[] = [];
  const wcag = new Set<string>();
  for (const d of c.ev("axe_node"))
    if (Array.isArray(d.wcag))
      for (const tag of d.wcag) {
        const m = typeof tag === "string" && /^wcag(\d)(\d)(\d{1,2})$/.exec(tag);
        if (m) wcag.add(`${m[1]}.${m[2]}.${m[3]}`);
      }
  if (wcag.size) out.push({ label: "WCAG success criterion", value: [...wcag].join(", ") });
  const impact = c.str("axe_node", "impact");
  if (impact) out.push({ label: "axe-core impact", value: impact });
  const summary = c.str("axe_node", "failureSummary");
  if (summary)
    out.push({
      label: "What axe-core found",
      value: short(
        summary
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .join(" · "),
        500,
      ),
    });
  return out;
}

function helpLink(c: Ctx): string[] {
  const url = c.str("axe_node", "helpUrl");
  return url && /^https?:\/\//.test(url)
    ? [`The rule's documentation explains the requirement in detail: ${url}`]
    : [];
}

/** Hints that an image belongs to a link, button or icon (from the selector or class names). */
function controlHint(c: Ctx): string | null {
  const selector = c.selectors.find((s) => /(^|[\s>+~])(a|button)(?=[.#:[\s>]|$)/i.test(s));
  if (selector) return `The selector ${code(selector)} shows the image is inside a link or button.`;
  const cls = attrOf(c.snippet?.html ?? null, "class");
  if (cls && /(^|[-_\s])(icon|nav|menu|btn|button|toggle|hamburger|logo)(?=$|[-_\s])/i.test(cls))
    return `The class name ${code(cls)} suggests an icon, logo or navigation control.`;
  return null;
}

const imageAlt: GuideFn = (c) => {
  const html = c.snippet?.html ?? null;
  const tag = html ? (findStartTag(html)?.[1]?.toLowerCase() ?? null) : null;
  const hint = controlHint(c);
  const platform = detectPlatform(c);
  const examples: CodeExample[] = [];
  const informative = html && withAttribute(html, "alt", "[describe what the image shows or does]");
  if (html && informative)
    examples.push({
      title: "If the image conveys information",
      language: "html",
      before: html,
      beforeOrigin: "observed",
      after: informative,
      explanation:
        "The alt attribute gives screen readers a text version of the image. Replace the placeholder with a short description of the information the image carries — the scan cannot know what that is.",
    });
  const decorative = html && withAttribute(html, "alt", "");
  if (decorative)
    examples.push({
      title: "If the image is purely decorative",
      language: "html",
      before: null,
      beforeOrigin: null,
      after: decorative,
      explanation:
        'An empty alt (alt="") tells screen readers to skip the image. Use it only when the image adds nothing a visitor would miss.',
    });
  if (hint)
    examples.push({
      title: "If the image is the only content of a link or button",
      language: "html",
      before: null,
      beforeOrigin: null,
      after: `<a href="[link target]">\n  ${(html && withAttribute(html, "alt", "[what the link does, e.g. Open menu]")) ?? '<img src="[image]" alt="[what the link does, e.g. Open menu]">'}\n</a>`,
      explanation:
        'When an image is the only thing inside a link or button, its alt text becomes the control\'s name. It must say what the control does or where it goes, not what the picture looks like. Alternatively give the link or button an aria-label and mark the image decorative (alt="").',
    });
  if (platform === "nextjs")
    examples.push({
      title: "If the image comes from a Next.js <Image> component",
      language: "jsx",
      before: null,
      beforeOrigin: null,
      after:
        '<Image src={src} width={…} height={…} alt="[describe what the image shows or does]" />',
      explanation:
        'next/image passes the alt prop to the rendered <img>. Use alt="" for decorative images.',
    });
  const platformStep =
    platform === "wordpress"
      ? "WordPress: set the “Alternative Text” field of the image in the Media Library or in the image block's settings. Icons built into the theme must be fixed in the theme's template files."
      : platform === "shopify"
        ? "Shopify: add the alt text to the image in the admin (the media item's “Add alt text” option), or in the theme's Liquid template for theme images."
        : null;
  return {
    problem: `${tag === "input" ? "An image button" : tag === "svg" ? "An SVG graphic" : "An image"} on ${pagePhrase(c)} has no text alternative, so people using screen readers are not told what it shows or does.${hint ? ` ${hint}` : ""}`,
    nextAction:
      "Decide what the image is for, then give it suitable alternative text: a short description if it conveys information, an empty alt if it is decorative, or the action's name if it is the only content of a link or button.",
    steps: [
      locate(c, `the ${tag === "svg" ? "graphic" : "image"}`),
      "Decide what the image is for — the scan cannot tell: (a) it conveys information (a chart, a product photo, text in an image) → describe that information; (b) it is purely decorative → use an empty alt; (c) it is the only content of a link or button (for example an icon) → name the action or destination, such as “Open menu”.",
      `Add the alt attribute (or aria-label for SVG and role="img" elements) accordingly. ${SOURCE_STEP}`,
      ...(platformStep ? [platformStep] : []),
      ...helpLink(c),
    ],
    examples,
    caveats: [
      "Do not use the file name, “image” or “picture of …” as alternative text; keep it short and specific to the page.",
      'Do not mark an informative image as decorative just to make the check pass: alt="" hides the image from screen-reader users.',
      "A title attribute or a nearby caption does not replace the alt attribute.",
      ...(c.findings.length > 1
        ? [
            `This issue covers ${plural(c.findings.length, "element")}; decide the right text for each one — the same image can serve different purposes on different pages.`,
          ]
        : []),
    ],
    gaps: [
      "The scan cannot see what the image shows or whether it is decorative; someone who knows the page content must decide the alternative text.",
    ],
    facts: axeFacts(c),
  };
};

/** Parses axe-core's color-contrast summary. */
function contrastDetails(summary: string | null) {
  if (!summary) return null;
  const m =
    /contrast of ([\d.]+) \(foreground color: (#[0-9a-f]{3,8}), background color: (#[0-9a-f]{3,8}), font size: ([^,]+), font weight: ([^)]+)\)\.\s*Expected contrast ratio of ([\d.]+):1/i.exec(
      summary,
    );
  if (!m) return null;
  return {
    ratio: m[1]!,
    fg: m[2]!.toLowerCase(),
    bg: m[3]!.toLowerCase(),
    fontSize: m[4]!.trim(),
    fontWeight: m[5]!.trim(),
    required: Number(m[6]),
  };
}

const colorContrast: GuideFn = (c) => {
  const d = contrastDetails(c.str("axe_node", "failureSummary"));
  const facts: GuideFact[] = [];
  const examples: CodeExample[] = [];
  const sel = c.selectors[0] ?? "[selector of the text]";
  if (d) {
    facts.push(
      { label: "Measured contrast", value: `${d.ratio}:1` },
      { label: "Required contrast", value: `${d.required}:1` },
      { label: "Text color", value: d.fg, code: true },
      { label: "Background color", value: d.bg, code: true },
      { label: "Font", value: `${d.fontSize}, weight ${d.fontWeight}` },
    );
    const safe = contrastSafeColor(d.fg, d.bg, d.required);
    const safeRatio = safe ? contrastRatio(safe, d.bg) : null;
    if (safe && safeRatio)
      examples.push({
        title: "Darken (or lighten) the text color",
        language: "css",
        before: `${sel} {\n  color: ${d.fg}; /* ${d.ratio}:1 on ${d.bg} */\n}`,
        beforeOrigin: "illustrative",
        after: `${sel} {\n  color: ${safe}; /* ${safeRatio.toFixed(2)}:1 on ${d.bg} (calculated) */\n}`,
        explanation: `${safe} is the closest shade of the current text color that reaches ${d.required}:1 on ${d.bg}, calculated with the WCAG contrast formula. Change the shared color (design token or CSS variable) rather than one element, and check that the new shade fits the brand palette.`,
      });
  }
  return {
    nextAction:
      "Increase the contrast between the text and its background until it reaches the required ratio, preferably by changing the shared color value.",
    steps: [
      locate(c, "the text"),
      "Find where its text color and background color are defined (the developer tools' Styles panel shows the rule and the contrast ratio).",
      "Darken the text or lighten the background (or the reverse on dark backgrounds) until the ratio meets the requirement: 4.5:1 for normal text, 3:1 for large text (about 24px, or 18.66px bold).",
      SOURCE_STEP,
      ...helpLink(c),
    ],
    examples,
    caveats: [
      "If the color is a brand color, agree the change with whoever owns the brand guidelines; a slightly darker shade usually works.",
      "Text over images or gradients is measured against the background axe-core could determine; check the real appearance too.",
    ],
    gaps: d
      ? []
      : [
          "The contrast details could not be read from the evidence; measure the colors with the browser's contrast checker.",
        ],
    facts: [...facts, ...axeFacts(c).filter((f) => f.label !== "What axe-core found" || !d)],
    regression:
      "Check hover, focus and disabled states of the same element, which often reuse the color.",
  };
};

const controlName: GuideFn = (c) => {
  const isLink = c.issue.ruleId === "link-name";
  const noun = isLink ? "link" : "button";
  const html = c.snippet?.html ?? null;
  const hasImg = Boolean(html && /<img\b/i.test(html));
  const hasSvg = Boolean(html && /<svg\b/i.test(html));
  const tag = isLink ? "a" : undefined;
  const labelled = html && withAttribute(html, "aria-label", `[what the ${noun} does]`, tag);
  return {
    problem: `A ${noun} on ${pagePhrase(c)} has no name that assistive technology can read out, so screen-reader users only hear “${noun}” without knowing ${isLink ? "where it goes" : "what it does"}.`,
    nextAction: `Give the ${noun} a name: visible text if possible, otherwise an aria-label that says ${isLink ? "where it goes" : "what it does"}.`,
    steps: [
      locate(c, `the ${noun}`),
      `Prefer visible text inside the ${noun}. If it must stay icon-only, add aria-label (for example “Search” or “Open menu”) to the ${noun} itself.`,
      ...(hasImg
        ? [
            `The ${noun} contains an image: alternatively give that image alt text that names the action — then it serves as the ${noun}'s name.`,
          ]
        : []),
      ...(hasSvg ? ['Mark the decorative SVG icon inside it with aria-hidden="true".'] : []),
      SOURCE_STEP,
      ...helpLink(c),
    ],
    examples:
      html && labelled
        ? [
            {
              title: `Add an accessible name to the ${noun}`,
              language: "html",
              before: html,
              beforeOrigin: "observed",
              after: labelled,
              explanation: `aria-label becomes the ${noun}'s accessible name. Replace the placeholder with a short, specific name; it must match what sighted visitors understand the ${noun} to do.`,
            },
          ]
        : [],
    caveats: [
      "Avoid vague names such as “click here” or “more”; and do not use aria-label on elements that already have good visible text (the label replaces it).",
      ...(html && isTruncated(html)
        ? ["The recorded HTML was shortened by the scanner; edit the full element in your code."]
        : []),
    ],
    gaps: html
      ? []
      : ["The scan did not record the element's HTML; inspect the element in the browser."],
    facts: axeFacts(c),
  };
};

const formLabel: GuideFn = (c) => {
  const html = c.snippet?.html ?? null;
  const id = attrOf(html, "id");
  const withId = html && !id ? withAttribute(html, "id", "[field-id]") : html;
  return {
    nextAction:
      "Connect a visible label to the form field so its purpose is announced and clicking the label focuses the field.",
    steps: [
      locate(c, "the form field"),
      `Add a <label> element whose for attribute matches the field's id${id ? ` (${code(id)})` : ""}, or wrap the field inside the label. If no visible label is possible, use aria-label.`,
      SOURCE_STEP,
      ...helpLink(c),
    ],
    examples:
      html && withId
        ? [
            {
              title: "Connect a visible label",
              language: "html",
              before: html,
              beforeOrigin: "observed",
              after: `<label for="${id ?? "[field-id]"}">[Field name]</label>\n${withId}`,
              explanation:
                "The label's for attribute points at the field's id, so screen readers announce the label and clicking it moves the cursor into the field.",
            },
          ]
        : [],
    caveats: ["A placeholder is not a label: it disappears when the visitor starts typing."],
    facts: axeFacts(c),
  };
};

const pageLang: GuideFn = (c) => ({
  nextAction: 'Declare the page language on the <html> element, for example lang="en" for English.',
  steps: [
    `Open the page template that renders the <html> element for ${pagePhrase(c)}.`,
    "Set the lang attribute to the language code of the page content (en, de, fr, en-GB …); pages in other languages need their own code.",
    ...helpLink(c),
  ],
  examples: [
    {
      title: "Declare the page language",
      language: "html",
      before:
        c.snippet && /^<html\b/i.test(c.snippet.html)
          ? (findStartTag(c.snippet.html, "html")?.[0] ?? "<html>")
          : "<html>",
      beforeOrigin: c.snippet && /^<html\b/i.test(c.snippet.html) ? "observed" : "illustrative",
      after: '<html lang="[language code, e.g. en]">',
      explanation:
        "Screen readers use lang to choose the pronunciation; translation tools and search engines use it to identify the language. The scan cannot decide which language the page is in.",
    },
  ],
  facts: axeFacts(c),
});

const pageTitle: GuideFn = (c) => ({
  nextAction: "Add a short, unique <title> that names the page.",
  steps: [
    `Open the template or page settings for ${pagePhrase(c)}.`,
    "Add a <title> inside <head> that names the page first and the site second; in a CMS, fill in the page's SEO title field.",
    ...helpLink(c),
  ],
  examples: [
    {
      title: "Add a page title",
      language: "html",
      before: "<head>\n  …\n</head>",
      beforeOrigin: "illustrative",
      after: "<head>\n  <title>[Page name] | [Site name]</title>\n  …\n</head>",
      explanation:
        "The title is shown in the browser tab and as the headline in search results, and screen readers announce it when the page opens.",
    },
  ],
  facts: [...axeFacts(c), ...seoFacts(c)],
});

const focusVisible: GuideFn = (c) => ({
  nextAction:
    "Give links and buttons a clearly visible focus style so keyboard users can see where they are.",
  steps: [
    locate(c, "the control"),
    "Press Tab until the control is focused and confirm that nothing changes visually.",
    "Add a :focus-visible style (outline or box-shadow) in the shared stylesheet, and remove any rule that sets outline: none without a replacement.",
    SOURCE_STEP,
  ],
  examples: [
    {
      title: "Add a visible focus style",
      language: "css",
      before: "a:focus,\nbutton:focus {\n  outline: none;\n}",
      beforeOrigin: "illustrative",
      after:
        "a:focus-visible,\nbutton:focus-visible {\n  outline: 2px solid currentColor;\n  outline-offset: 2px;\n}",
      explanation:
        ":focus-visible shows the outline for keyboard users without showing it on every mouse click. The “before” is a common cause, not something the scan read from your stylesheet.",
    },
  ],
  gaps: [
    "The scanner compared the element's computed styles with and without focus; it cannot see custom focus effects drawn some other way (for example a pseudo-element animation). Check with the keyboard before changing styles.",
  ],
  facts: c.str("computed_style", "element")
    ? [
        {
          label: "Compared properties",
          value: "outline, box-shadow, border, background, underline, color",
        },
      ]
    : [],
});

const targetSize: GuideFn = (c) => ({
  nextAction: "Make the listed links and buttons at least 24×24 CSS pixels, or space them apart.",
  steps: [
    locate(c, "the control"),
    "Increase the clickable area with padding (or min-width / min-height) rather than enlarging the icon itself.",
    SOURCE_STEP,
    ...helpLink(c),
  ],
  examples: [
    {
      title: "Enlarge the target area",
      language: "css",
      before: null,
      beforeOrigin: null,
      after: `${c.selectors[0] ?? "[selector]"} {\n  min-width: 24px;\n  min-height: 24px;\n  /* 44px is the comfortable size for touch screens */\n}`,
      explanation:
        "The minimum size makes the target easier to hit without changing how the icon looks. Use padding if the element is inline.",
    },
  ],
  facts: [...axeFacts(c), ...measured(c)],
});

const landmarks: GuideFn = (c) => ({
  nextAction:
    "Wrap the page's areas in landmark elements (header, nav, main, footer) so assistive technology can jump between them.",
  steps: [
    `Open the layout template used by ${pagePhrase(c)}.`,
    "Put the main content in a single <main>, the site header in <header>, menus in <nav> and the footer in <footer>; content outside these areas is what the rule reports.",
    ...(c.selectors.length
      ? [`The content found outside a landmark: ${code(c.selectors[0]!)}.`]
      : []),
    ...helpLink(c),
  ],
  examples: [
    {
      title: "Page landmarks",
      language: "html",
      before: null,
      beforeOrigin: null,
      after:
        '<body>\n  <header>…</header>\n  <nav aria-label="Main">…</nav>\n  <main>…</main>\n  <footer>…</footer>\n</body>',
      explanation:
        "Each landmark element marks one area of the page that screen-reader users can jump to.",
    },
  ],
  facts: axeFacts(c),
});

const headingStructure: GuideFn = (c) => ({
  nextAction:
    "Fix the heading levels so they form an outline: one h1, then h2, h3 … without skipping a level.",
  steps: [
    locate(c, "the heading"),
    "Change the heading tag to the level that fits the outline; if it only needs to look different, change its CSS, not its level.",
    "Use real heading tags for section titles instead of bold paragraphs, and remove empty headings.",
    SOURCE_STEP,
    ...helpLink(c),
  ],
  facts: [...axeFacts(c), ...seoFacts(c)],
});

const viewportZoom: GuideFn = (c) => {
  const html = c.snippet?.html ?? null;
  const content = attrOf(html, "content");
  const cleaned = content
    ?.split(",")
    .map((s) => s.trim())
    .filter((s) => !/^(user-scalable\s*=\s*(no|0)|maximum-scale\s*=)/i.test(s))
    .join(", ");
  const after = html && cleaned !== undefined && withAttribute(html, "content", cleaned);
  return {
    nextAction:
      "Allow zooming: remove user-scalable=no and low maximum-scale values from the viewport tag.",
    steps: [
      `Open the template that writes the <meta name="viewport"> tag for ${pagePhrase(c)}.`,
      "Remove user-scalable=no and any maximum-scale below 2 (or the whole maximum-scale setting).",
      ...helpLink(c),
    ],
    examples:
      html && after
        ? [
            {
              title: "Allow pinch-zoom",
              language: "html",
              before: html,
              beforeOrigin: "observed",
              after,
              explanation:
                "Without the zoom restrictions visitors can enlarge the page to read it.",
            },
          ]
        : [],
    facts: axeFacts(c),
  };
};

const accessibilityDefault: GuideFn = (c) => ({
  nextAction: c.issue.recommendation
    ? firstSentence(c.issue.recommendation)
    : "Fix each listed element so it meets the accessibility rule named in the technical details.",
  steps: [
    locate(c, "the element"),
    ...(recommendationSteps(c.issue.recommendation).length
      ? recommendationSteps(c.issue.recommendation).filter((s) => !/^Rule documentation:/i.test(s))
      : ["Read the scanner's explanation of what failed (below) and correct the element."]),
    SOURCE_STEP,
    ...helpLink(c),
  ],
  facts: axeFacts(c),
});

// --- Security --------------------------------------------------------------------------------

const PASSIVE =
  "This finding is a passive observation of the site's configuration. It is a missing protection, not evidence that the site has been attacked or that the weakness has been exploited.";

const WHERE_HEADERS =
  "Set the header where responses are produced — the web server (add_header in nginx, Header set in Apache), the CDN or hosting platform's header rules, or the application framework's response-header configuration — so it is sent on every page.";

const HEADER_NAMES: Record<string, string> = {
  "strict-transport-security": "Strict-Transport-Security",
  "content-security-policy": "Content-Security-Policy",
  "x-content-type-options": "X-Content-Type-Options",
  "x-frame-options": "X-Frame-Options",
  "referrer-policy": "Referrer-Policy",
  "permissions-policy": "Permissions-Policy",
};

/**
 * The header as the scanner recorded it: found = the evidence has an observation for this header
 * (value null = not sent). Headers the evidence does not mention are never reported as missing.
 */
function observedHeader(c: Ctx, header: string): { found: boolean; value: string | null } {
  for (const d of c.ev("header")) {
    const obs = Array.isArray(d.observations) ? d.observations : [d];
    for (const o of obs as Array<Record<string, unknown>>) {
      if (o.header === header) return { found: true, value: isStr(o.value) ? o.value : null };
      if (Object.hasOwn(o, header)) {
        const v = o[header];
        return { found: true, value: isStr(v) ? v : null };
      }
    }
  }
  return { found: false, value: null };
}

function headerScope(c: Ctx): GuideFact[] {
  const d = c.ev("header")[0];
  return d && isNum(d.affectedPages) && isNum(d.pagesChecked)
    ? [{ label: "Pages affected", value: `${d.affectedPages} of ${d.pagesChecked} checked` }]
    : [];
}

function headerGuide(
  c: Ctx,
  header: string,
  value: string,
  o: { nextAction: string; explanation: string; caveats?: string[]; extra?: string[] },
): RuleGuide {
  const name = HEADER_NAMES[header] ?? header;
  const seen = observedHeader(c, header);
  return {
    nextAction: o.nextAction,
    steps: [
      `Check the response headers of ${pagePhrase(c)} (developer tools → Network → the page request → Headers) to confirm the ${name} header.`,
      ...(o.extra ?? []),
      WHERE_HEADERS,
    ],
    examples: [
      {
        title: `Send ${name}`,
        language: "http",
        before: seen.value ? `${name}: ${seen.value}` : null,
        beforeOrigin: seen.value ? "observed" : null,
        after: `${name}: ${value}`,
        explanation: o.explanation,
      },
    ],
    caveats: [...(o.caveats ?? []), PASSIVE],
    facts: [
      ...(seen.found
        ? [
            {
              label: `${name} in the scanned response`,
              value: seen.value ?? "not sent",
              code: Boolean(seen.value),
            },
          ]
        : []),
      ...headerScope(c),
    ],
    regression:
      "After the change, open the site's main pages with the developer tools' Console open and check that nothing is newly blocked or broken.",
  };
}

const SECURITY_GUIDES: Record<string, GuideFn> = {
  "hsts-missing": (c) =>
    headerGuide(c, "strict-transport-security", "max-age=15552000; includeSubDomains", {
      nextAction: "Send the Strict-Transport-Security (HSTS) header on every HTTPS response.",
      explanation:
        "HSTS tells browsers to use HTTPS for this site for the given time (here 180 days), so later visits cannot be downgraded to plain HTTP.",
      caveats: [
        "Add includeSubDomains only if every subdomain works over HTTPS; remove it otherwise. Do not add preload until you are sure — it is hard to undo.",
      ],
    }),
  "hsts-weak": (c) =>
    headerGuide(c, "strict-transport-security", "max-age=31536000; includeSubDomains", {
      nextAction: "Raise the HSTS max-age to at least 180 days (15552000 seconds).",
      explanation: "A longer max-age keeps browsers on HTTPS between visits; one year is common.",
      caveats: ["Keep includeSubDomains only if every subdomain supports HTTPS."],
    }),
  "csp-missing": (c) => {
    const g = headerGuide(
      c,
      "content-security-policy",
      "default-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'",
      {
        nextAction:
          "Introduce a Content Security Policy, first in report-only mode, then enforce it.",
        explanation:
          "The policy limits where scripts, styles and other resources may load from, so injected code is much harder to run. This starting policy allows only the site's own origin; add the third-party sources the site really uses.",
        extra: [
          "List the scripts, styles, fonts, images and frames the site loads from other domains (developer tools → Network).",
          "Deploy the policy first as Content-Security-Policy-Report-Only and watch the browser console for violations; adjust, then switch to Content-Security-Policy.",
        ],
        caveats: [
          "An enforced policy that is too strict blocks legitimate scripts (analytics, chat widgets, inline scripts). Never enforce it untested.",
        ],
      },
    );
    const reportOnly = c
      .ev("header")
      .flatMap(
        (d) =>
          (Array.isArray(d.observations) ? d.observations : [d]) as Array<Record<string, unknown>>,
      )
      .find((o) => isStr(o.reportOnly))?.reportOnly;
    if (isStr(reportOnly))
      g.facts = [
        ...(g.facts ?? []),
        { label: "Report-only policy (not enforced)", value: reportOnly, code: true },
      ];
    return g;
  },
  "csp-unsafe-script": (c) => {
    const g = headerGuide(
      c,
      "content-security-policy",
      "script-src 'self' 'nonce-[random per response]'",
      {
        nextAction:
          "Remove 'unsafe-inline', 'unsafe-eval' and wildcards from the script sources of the policy.",
        explanation:
          "Nonces (or hashes) allow the inline scripts you wrote while blocking injected ones. The nonce must be a new random value on every response, added to each allowed <script> tag.",
        extra: [
          "Move inline scripts into files where possible; allow the remaining ones with a nonce or hash.",
        ],
        caveats: [
          "Removing 'unsafe-inline' breaks inline scripts that have no nonce or hash; test first.",
        ],
      },
    );
    // The finding records the offending directive ("script-src 'self' 'unsafe-inline' …").
    const actual = c.findings[0]?.actual;
    const d = c.ev("header")[0];
    const obs = Array.isArray(d?.observations)
      ? (d.observations[0] as Record<string, unknown>)
      : undefined;
    if (actual && /^(script-src|default-src) /.test(actual) && g.examples?.[0])
      g.examples[0] = {
        ...g.examples[0],
        before: `Content-Security-Policy: … ${actual} …`,
        beforeOrigin: "observed",
      };
    if (obs && Array.isArray(obs.problems))
      g.facts = [
        { label: "Unsafe script sources", value: obs.problems.filter(isStr).join(", ") },
        ...(g.facts ?? []),
      ];
    return g;
  },
  "x-content-type-options-missing": (c) =>
    headerGuide(c, "x-content-type-options", "nosniff", {
      nextAction: "Send “X-Content-Type-Options: nosniff” on every response.",
      explanation:
        "nosniff stops browsers from guessing a file's type, so a file served as text or an image cannot be run as a script.",
      caveats: [
        "Make sure scripts and stylesheets are served with the correct Content-Type, or browsers will refuse them.",
      ],
    }),
  "frame-protection-missing": (c) => {
    const g = headerGuide(c, "x-frame-options", "SAMEORIGIN", {
      nextAction: "Stop other websites from showing these pages inside a frame.",
      explanation:
        "SAMEORIGIN lets only this site frame its pages. Send it together with the CSP directive below; current browsers use frame-ancestors, older ones X-Frame-Options.",
      caveats: [
        "If partners legitimately embed the pages, list their origins in frame-ancestors instead of 'self' (X-Frame-Options cannot list them).",
      ],
    });
    g.examples?.push({
      title: "Add frame-ancestors to the Content-Security-Policy",
      language: "http",
      before: null,
      beforeOrigin: null,
      after: "Content-Security-Policy: frame-ancestors 'self'",
      explanation:
        "If the site already sends a Content-Security-Policy, add the frame-ancestors directive to it instead of sending a second policy.",
    });
    return g;
  },
  "referrer-policy-unsafe": (c) =>
    headerGuide(c, "referrer-policy", "strict-origin-when-cross-origin", {
      nextAction: "Set a Referrer-Policy that does not send full page addresses to other sites.",
      explanation:
        "With strict-origin-when-cross-origin other sites only see the domain a visitor came from, not the full address with its path and query.",
    }),
  "referrer-policy-missing": (c) =>
    headerGuide(c, "referrer-policy", "strict-origin-when-cross-origin", {
      nextAction: "Send an explicit Referrer-Policy header.",
      explanation:
        "Stating the policy makes the behaviour the same in every browser instead of relying on its default.",
    }),
  "permissions-policy-missing": (c) =>
    headerGuide(c, "permissions-policy", "camera=(), microphone=(), geolocation=()", {
      nextAction:
        "Send a Permissions-Policy header that switches off browser features the site does not use.",
      explanation:
        "Each feature listed with () is disabled for the page and any embedded content. List only features the site really does not need.",
      caveats: [
        "Do not disable features the site or its embedded widgets use (for example geolocation for a store finder).",
      ],
    }),
  "server-version-disclosure": (c) => {
    // Recorded per page: { observations: [{ url, headers: ["Server: …"] }] }.
    const leaks = [
      ...new Set(
        c
          .ev("header")
          .flatMap((d) => (Array.isArray(d.observations) ? d.observations : [d]))
          .flatMap((o) => {
            const h = (o as Record<string, unknown>).headers;
            return Array.isArray(h) ? h.filter(isStr) : [];
          }),
      ),
    ];
    const first = leaks[0] ?? c.findings[0]?.actual ?? null;
    const hidden = first
      ?.replace(/\/[\d][\w.-]*/g, "")
      .replace(/^(X-Powered-By|X-AspNet-Version):.*$/i, "(header removed)");
    return {
      nextAction: "Stop the server from announcing its software version.",
      steps: [
        "Find which part of the stack adds the header (web server, application framework or hosting platform).",
        "Turn off the version: for example server_tokens off in nginx, ServerTokens Prod in Apache, and disable X-Powered-By in the framework.",
      ],
      examples:
        first && hidden && hidden !== first
          ? [
              {
                title: "Hide the version number",
                language: "http",
                before: first,
                beforeOrigin: "observed",
                after: hidden,
                explanation:
                  "Without a version number attackers cannot look up the exact release's known weaknesses as easily. Keeping the software up to date matters more than hiding the version.",
              },
            ]
          : [],
      caveats: [PASSIVE],
      facts: leaks.length ? [{ label: "Headers sent", value: leaks.join("; "), code: true }] : [],
    };
  },
  "cookie-flags": (c) => {
    const d = c.ev("header")[0] ?? {};
    const raw = isStr(d.value) ? d.value : null;
    const missing = Array.isArray(d.missing) ? d.missing.filter(isStr) : [];
    // The cookie value itself is not repeated in the example.
    const masked = raw?.replace(/^([^=;]+)=([^;]*)/, "$1=[value]") ?? null;
    const add = missing.map((m) => (m === "SameSite" ? "SameSite=Lax" : m)).join("; ");
    return {
      nextAction: `Add the missing ${missing.join(", ") || "security"} attribute${missing.length === 1 ? "" : "s"} where the application sets the cookie.`,
      steps: [
        "Find the code or configuration that sets this cookie (the application, a framework session setting, or a third-party script).",
        "Add the missing attributes: Secure (sent over HTTPS only), HttpOnly (not readable by JavaScript), SameSite=Lax or Strict (not sent with requests from other sites).",
      ],
      examples:
        masked && add
          ? [
              {
                title: "Set the cookie with its security attributes",
                language: "http",
                before: `Set-Cookie: ${masked}`,
                beforeOrigin: "observed",
                after: `Set-Cookie: ${masked}; ${add}`,
                explanation:
                  "The cookie's value is replaced by [value] here. The added attributes limit when browsers send the cookie and who can read it.",
              },
            ]
          : [],
      caveats: [
        "Leave out HttpOnly only if your own client-side code must read the cookie.",
        "Cookies set by third-party scripts must be fixed by that provider's settings.",
        PASSIVE,
      ],
      facts: missing.length ? [{ label: "Missing attributes", value: missing.join(", ") }] : [],
    };
  },
  "insecure-form-action": (c) => {
    const html = c.snippet?.html ?? null;
    const action = attrOf(html, "action", "form");
    const fixed =
      html && action?.startsWith("http:")
        ? withAttribute(html, "action", action.replace(/^http:/, "https:"), "form")
        : null;
    return {
      nextAction: "Change the form so it submits to an https:// address.",
      steps: [
        locate(c, "the form"),
        "Change the form's action to the https:// address (or a relative address on the HTTPS site).",
        SOURCE_STEP,
      ],
      examples:
        html && fixed
          ? [
              {
                title: "Submit over HTTPS",
                language: "html",
                before: html,
                beforeOrigin: "observed",
                after: fixed,
                explanation: "Data sent to an https:// address is encrypted in transit.",
              },
            ]
          : [],
      caveats: ["Check that the receiving server accepts HTTPS before switching.", PASSIVE],
    };
  },
  "sri-missing": (c) => {
    const html = c.snippet?.html ?? null;
    const resource = c.str("html_snippet", "resource");
    const tag = html ? findStartTag(html)?.[1]?.toLowerCase() : undefined;
    const withIntegrity =
      html &&
      withAttribute(
        withAttribute(html, "integrity", "sha384-[hash of the exact file]", tag) ?? html,
        "crossorigin",
        "anonymous",
        tag,
      );
    return {
      nextAction: "Add an integrity hash to the third-party file, or host the file yourself.",
      steps: [
        `Find where ${resource ? code(resource) : "the third-party file"} is included in the page template.`,
        "Download the exact file version and compute its hash, for example: openssl dgst -sha384 -binary FILE | openssl base64 -A",
        'Add integrity="sha384-<hash>" and crossorigin="anonymous" to the tag. Many CDNs publish the hash next to the file.',
      ],
      examples:
        html && withIntegrity
          ? [
              {
                title: "Add Subresource Integrity",
                language: "html",
                before: html,
                beforeOrigin: "observed",
                after: withIntegrity,
                explanation:
                  "The browser refuses the file if its content no longer matches the hash, so a tampered file never runs.",
              },
            ]
          : [],
      caveats: [
        "Use a URL with a fixed version: if the file at the URL changes, the hash stops matching and the file is blocked.",
        PASSIVE,
      ],
      facts: resource ? [{ label: "Resource", value: resource, code: true }] : [],
    };
  },
  "https-not-used": (c) => ({
    nextAction: "Serve the whole site over HTTPS and redirect all http:// requests to it.",
    steps: [
      "Install a TLS certificate for the domain (most hosts and CDNs offer free certificates).",
      "Redirect every http:// request to the same https:// address with a permanent (301 or 308) redirect.",
      "Once everything works over HTTPS, add the Strict-Transport-Security header.",
    ],
    caveats: [
      "Update links, canonical tags and embedded resources to https:// so pages do not load mixed content.",
      PASSIVE,
    ],
    facts: c.str("document", "scannedUrl")
      ? [{ label: "Scanned address", value: c.str("document", "scannedUrl")!, code: true }]
      : [],
  }),
  "http-not-redirected": (c) => {
    const d = c.ev("network")[0] ?? {};
    const requested = isStr(d.requested) ? d.requested : null;
    const host = requested ? safeHost(requested) : null;
    return {
      nextAction: "Redirect every plain http:// request to the same address on https://.",
      steps: [
        "Configure the web server, load balancer or CDN to answer plain-HTTP requests with a permanent redirect (301 or 308) to https://, keeping the path and query.",
      ],
      examples: host
        ? [
            {
              title: "Redirect HTTP to HTTPS",
              language: "http",
              before: isNum(d.status) ? `HTTP/1.1 ${d.status}` : null,
              beforeOrigin: isNum(d.status) ? "observed" : null,
              after: `HTTP/1.1 301 Moved Permanently\nLocation: https://${host}/`,
              explanation:
                "Visitors who type the address without https:// or follow old links are sent to the encrypted site.",
            },
          ]
        : [],
      caveats: [PASSIVE],
      facts: [
        ...(requested ? [{ label: "Requested", value: requested, code: true }] : []),
        ...(isNum(d.status) ? [{ label: "Response", value: `HTTP ${d.status}` }] : []),
        ...(isStr(d.finalUrl) ? [{ label: "Ended at", value: d.finalUrl, code: true }] : []),
      ],
    };
  },
};

const exposedSecret: GuideFn = (c) => ({
  nextAction:
    "Ask the owner of the service whether the value is a real credential; if it is, revoke it and issue a new one before removing it from the page.",
  steps: [
    `Open the page source of ${pagePhrase(c)} and search for the masked value's start (the evidence shows the text just before it).`,
    "Ask the owner of the related service whether it is a real, active credential or a sample/public key meant for browsers.",
    "If it is real: revoke (rotate) it in that service first — removing it from the page does not stop copies already taken.",
    "Remove the secret from the page and the build: keep secrets on the server and call the service from server-side code.",
    "Check the code repository's history and other environments for the same value.",
  ],
  caveats: [
    "Some keys are designed to be public (for example restricted browser API keys); confirm before treating it as a leak.",
    "Never paste the full value into tickets, chats or online tools.",
  ],
  gaps: [
    "The scanner only matched the format of a credential; it cannot tell whether the key is real or still active.",
  ],
  facts: c.str("html_snippet", "match")
    ? [{ label: "Masked match", value: c.str("html_snippet", "match")!, code: true }]
    : [],
});

// --- SEO -------------------------------------------------------------------------------------

/** Page facts recorded by the SEO scanner (title, description, lengths, headings). */
function seoFacts(c: Ctx): GuideFact[] {
  const d = c.ev("document")[0];
  if (!d) return [];
  const out: GuideFact[] = [];
  if ("title" in d) out.push({ label: "Current title", value: isStr(d.title) ? d.title : "none" });
  if ("description" in d)
    out.push({
      label: "Current description",
      value: isStr(d.description) ? short(d.description, 300) : "none",
    });
  if (isNum(d.length)) out.push({ label: "Length", value: `${d.length} characters` });
  if (Array.isArray(d.headingSequence))
    out.push({ label: "Heading sequence", value: d.headingSequence.join(" → ") });
  if (Array.isArray(d.canonical))
    out.push({ label: "Canonical links", value: d.canonical.join(", "), code: true });
  if (isStr(d.robotsMeta)) out.push({ label: "Robots meta tag", value: d.robotsMeta, code: true });
  if (isStr(d.xRobotsTag))
    out.push({ label: "X-Robots-Tag header", value: d.xRobotsTag, code: true });
  return out;
}

/** Page addresses listed in SEO evidence ({ pages, omitted }). */
function pageListFact(c: Ctx, label: string): GuideFact[] {
  const d = c.ev("document")[0];
  const pages = Array.isArray(d?.pages) ? d.pages.filter(isStr) : [];
  if (!pages.length) return [];
  const more = isNum(d?.omitted) && d.omitted > 0 ? ` and ${d.omitted} more` : "";
  return [{ label, value: pages.slice(0, 10).join(", ") + more, code: true }];
}

function duplicateGuide(c: Ctx, what: "title" | "meta description"): RuleGuide {
  const d = c.ev("document")[0];
  const value = isStr(d?.value) ? d.value : null;
  return {
    nextAction: `Give each page its own ${what} that describes that page's specific content.`,
    steps: [
      `Open the SEO settings or templates of the listed pages${value ? `; they all use the ${what} “${short(value, 120)}”` : ""}.`,
      `Write a distinct ${what} for each page. If a template fills it in automatically, include the page's own name or topic in it.`,
      "If two addresses are really the same page, point one to the other with a canonical link or a redirect instead.",
    ],
    caveats: [
      "The scanner compared only the pages it crawled; other pages may share the same text too.",
    ],
    facts: [...(value ? [{ label: `Shared ${what}`, value }] : []), ...pageListFact(c, "Pages")],
  };
}

const headSnippet = (
  c: Ctx,
  title: string,
  tag: string,
  explanation: string,
  before: string | null = null,
): RuleGuide["examples"] => [
  {
    title,
    language: "html",
    before,
    beforeOrigin: before ? "illustrative" : null,
    after: `<head>\n  …\n  ${tag}\n</head>`,
    explanation,
  },
];

const SEO_GUIDES: Record<string, GuideFn> = {
  "title-missing": pageTitle,
  "title-length": (c) => ({
    nextAction: "Rewrite the title to about 10–60 characters, with the most important words first.",
    steps: [
      `Open the page settings or template for ${pagePhrase(c)}.`,
      "Rewrite the title: name the page's topic first, then the site name if there is room.",
    ],
    examples: headSnippet(
      c,
      "A concise title",
      "<title>[Page topic] | [Site name]</title>",
      "Search engines show roughly the first 60 characters; longer titles are cut off or rewritten.",
    ),
    facts: seoFacts(c),
  }),
  "meta-description-missing": (c) => ({
    nextAction:
      "Write a unique summary of the page (about 50–160 characters) in a meta description.",
    steps: [
      `Open the page settings (SEO description field) or template for ${pagePhrase(c)}.`,
      "Write one or two sentences that tell a searcher what they will find on this page.",
    ],
    examples: headSnippet(
      c,
      "Add a meta description",
      '<meta name="description" content="[One or two sentences about this page]">',
      "Search engines often show this text under the title in results.",
    ),
    facts: seoFacts(c),
  }),
  "meta-description-length": (c) => ({
    nextAction: "Rewrite the meta description to about 50–160 characters.",
    steps: [
      `Open the page settings or template for ${pagePhrase(c)}.`,
      "Shorten or extend the description so it summarizes the page in about 50–160 characters.",
    ],
    facts: seoFacts(c),
  }),
  "h1-missing": (c) => ({
    nextAction: "Add one main heading (h1) that states what the page is about.",
    steps: [
      `Open the template of ${pagePhrase(c)}.`,
      "Turn the page's main title into an <h1>, or add one; use CSS for its size.",
    ],
    examples: [
      {
        title: "Add the main heading",
        language: "html",
        before: null,
        beforeOrigin: null,
        after: "<h1>[What this page is about]</h1>",
        explanation: "The h1 is the page's main heading for search engines and screen readers.",
      },
    ],
    facts: seoFacts(c),
  }),
  "h1-multiple": (c) => ({
    nextAction: "Keep one h1 for the main topic and change the other top-level headings to h2.",
    steps: [
      `Open the template of ${pagePhrase(c)} and list its h1 elements.`,
      "Keep the one that names the page; change the others to <h2> (or lower) and keep their look with CSS.",
    ],
    facts: seoFacts(c),
  }),
  "heading-level-skipped": headingStructure,
  noindex: (c) => ({
    nextAction: "Decide whether this page should appear in search results; if yes, remove noindex.",
    steps: [
      "Check with the page owner whether the page is meant to be hidden from search engines (private, duplicate or temporary pages often are).",
      "If it should be found, remove noindex from the robots meta tag and from any X-Robots-Tag header (often a CMS “hide from search engines” setting).",
    ],
    examples: [
      {
        title: "Allow indexing",
        language: "html",
        before: '<meta name="robots" content="noindex">',
        beforeOrigin: "illustrative",
        after:
          '<!-- remove the robots meta tag, or: -->\n<meta name="robots" content="index, follow">',
        explanation: "Without noindex search engines may list the page.",
      },
    ],
    caveats: [
      "If the page is intentionally hidden, no change is needed — mark the issue Ignored with a note.",
    ],
    gaps: ["The scan cannot know whether hiding the page is intended."],
    facts: seoFacts(c),
  }),
  "canonical-missing": (c) => ({
    nextAction: "Declare each page's preferred address with a canonical link.",
    steps: [
      `Open the template of ${pagePhrase(c)}.`,
      'Add <link rel="canonical"> pointing to the page\'s preferred address (usually https://, without tracking parameters).',
    ],
    examples: headSnippet(
      c,
      "Declare the preferred address",
      `<link rel="canonical" href="${c.pages.length === 1 ? c.pages[0] : "[preferred address of this page]"}">`,
      `Search engines combine duplicate addresses of the same content under the canonical one.${c.pages.length === 1 ? " The example uses the scanned address; use a different one if that is not the preferred version." : ""}`,
    ),
    facts: [...seoFacts(c), ...pageListFact(c, "Pages without a canonical link")],
  }),
  "canonical-multiple": (c) => ({
    nextAction: "Keep exactly one canonical link per page.",
    steps: [
      `Open the page source of ${pagePhrase(c)} and find all <link rel="canonical"> tags (often one from the theme and one from an SEO plugin).`,
      "Remove all but the one with the preferred address.",
    ],
    facts: seoFacts(c),
  }),
  "html-lang-missing": pageLang,
  "viewport-meta-missing": (c) => ({
    nextAction: "Add the responsive viewport meta tag to the page head.",
    steps: [`Open the base template of ${pagePhrase(c)}.`, "Add the viewport tag inside <head>."],
    examples: headSnippet(
      c,
      "Add the viewport tag",
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      "Phones then lay out the page at their own width instead of shrinking a desktop page.",
    ),
    regression:
      "Check the page on a phone-sized screen: a page that was never designed for small screens may need layout fixes once it is no longer shrunk.",
  }),
  "img-alt-attribute-missing": imageAlt,
  "structured-data-invalid": (c) => ({
    nextAction: "Fix the JSON syntax of the structured-data block so search engines can read it.",
    steps: [
      `Open the page source of ${pagePhrase(c)} and find the <script type="application/ld+json"> block.`,
      "Correct the error reported below (often a trailing comma, a missing quote or unescaped characters), then check it with a JSON or structured-data validator.",
    ],
    facts: [
      ...(c.str("document", "error")
        ? [{ label: "Parser error", value: c.str("document", "error")! }]
        : []),
      ...(c.str("document", "snippet")
        ? [{ label: "Start of the block", value: c.str("document", "snippet")!, code: true }]
        : []),
    ],
  }),
  "open-graph-missing": (c) => ({
    nextAction: "Add Open Graph tags so shared links show a proper title, description and image.",
    steps: [
      `Open the template of ${pagePhrase(c)} (or the SEO plugin's social settings).`,
      "Add og:title, og:description and og:image for each page.",
    ],
    examples: headSnippet(
      c,
      "Add social preview tags",
      '<meta property="og:title" content="[Page title]">\n  <meta property="og:description" content="[Short summary]">\n  <meta property="og:image" content="[https://… image URL]">',
      "Social networks and chat apps read these tags to build link previews.",
    ),
  }),
  "title-duplicate": (c) => duplicateGuide(c, "title"),
  "meta-description-duplicate": (c) => duplicateGuide(c, "meta description"),
  "url-structure": (c) => ({
    nextAction:
      "Use short, readable, lowercase addresses for new pages; redirect old addresses if you change existing ones.",
    steps: [
      "Review the listed addresses: long query strings, upper-case letters, underscores or encoded characters make them hard to read and share.",
      "Change the URL settings (slugs) in the CMS or router for new pages; for existing pages, change them only together with a permanent (301) redirect from the old address.",
    ],
    caveats: [
      "Changing a live address without a redirect breaks bookmarks, links from other sites and search rankings.",
    ],
    facts: pageListFact(c, "Addresses"),
  }),
  "sitemap-not-found": (c) => {
    const d = c.ev("network")[0] ?? {};
    return {
      nextAction:
        "Publish the sitemap at the address robots.txt declares, or correct that address.",
      steps: [
        `Open ${isStr(d.url) ? code(d.url) : "the declared sitemap address"} in a browser to see the error.`,
        "Generate the sitemap (most CMSs and SEO plugins can) and publish it there, or fix the Sitemap line in robots.txt.",
      ],
      facts: [
        ...(isStr(d.url) ? [{ label: "Sitemap address", value: d.url, code: true }] : []),
        ...(isNum(d.status) ? [{ label: "Response", value: `HTTP ${d.status}` }] : []),
        ...(isStr(d.declaredIn) ? [{ label: "Declared in", value: d.declaredIn, code: true }] : []),
      ],
    };
  },
  "sitemap-invalid": (c) => {
    const d = c.ev("document")[0] ?? {};
    const err =
      d.error && typeof d.error === "object" ? (d.error as Record<string, unknown>).msg : d.error;
    return {
      nextAction:
        "Fix the sitemap so it is well-formed XML with a <urlset> or <sitemapindex> root.",
      steps: [
        `Open ${isStr(d.url) ? code(d.url) : "the sitemap"} and check it with an XML or sitemap validator.`,
        "Regenerate it with your CMS or SEO plugin, or correct the generator that writes it.",
      ],
      facts: [
        ...(isStr(d.url) ? [{ label: "Sitemap address", value: d.url, code: true }] : []),
        ...(isStr(err) ? [{ label: "Parser error", value: err }] : []),
        ...(isStr(d.snippet)
          ? [{ label: "Start of the file", value: short(d.snippet, 300), code: true }]
          : []),
      ],
    };
  },
  "sitemap-missing": (c) => {
    const checked = (c.ev("network")[0]?.checked ?? []) as unknown[];
    return {
      nextAction: "Generate an XML sitemap of the site's pages and reference it in robots.txt.",
      steps: [
        "Generate a sitemap that lists the pages you want found (most CMSs and SEO plugins do this automatically).",
        "Publish it on the site and add a line “Sitemap: <its full address>” to robots.txt.",
      ],
      facts:
        Array.isArray(checked) && checked.filter(isStr).length
          ? [{ label: "Addresses checked", value: checked.filter(isStr).join(", "), code: true }]
          : [],
    };
  },
  "structured-data-absent": () => ({
    nextAction:
      "Optional: add structured data (JSON-LD) to pages that describe your organization, products or articles.",
    steps: [
      "Decide which schema.org types fit your pages (Organization for the home page, Product, Article, Event …).",
      "Add a JSON-LD block to those pages (many CMS SEO plugins can generate it) and check it with a structured-data validator.",
    ],
    examples: [
      {
        title: "Organization data on the home page",
        language: "html",
        before: null,
        beforeOrigin: null,
        after:
          '<script type="application/ld+json">\n{\n  "@context": "https://schema.org",\n  "@type": "Organization",\n  "name": "[Organization name]",\n  "url": "[Home page address]",\n  "logo": "[Logo image address]"\n}\n</script>',
        explanation:
          "Search engines can show this information in results. Fill in only facts that are true for your organization.",
      },
    ],
    caveats: ["This is an opportunity, not an error; skip it if it does not fit the site."],
  }),
  "robots-txt-missing": () => ({
    nextAction: "Publish a robots.txt file at the site root.",
    steps: [
      "Create a file named robots.txt in the site's root folder (it must be reachable at /robots.txt).",
      "Allow crawling and point to the sitemap.",
    ],
    examples: [
      {
        title: "Minimal robots.txt",
        language: "text",
        before: null,
        beforeOrigin: null,
        after: "User-agent: *\nAllow: /\n\nSitemap: [full address of your XML sitemap]",
        explanation: "Allows all crawlers and tells them where the sitemap is.",
      },
    ],
  }),
};

// --- Links and mixed content ------------------------------------------------------------------

function linkFacts(c: Ctx): GuideFact[] {
  const d = c.ev("link_check")[0];
  if (!d) return [];
  const out: GuideFact[] = [];
  if (isStr(d.target)) out.push({ label: "Link target", value: d.target, code: true });
  out.push({
    label: "Result",
    value: [
      isNum(d.status) ? `HTTP ${d.status}` : "no HTTP response",
      isStr(d.error) ? d.error : null,
      isNum(d.attempts) ? `after ${plural(d.attempts, "attempt")}` : null,
    ]
      .filter(Boolean)
      .join(" · "),
  });
  if (Array.isArray(d.redirectChain) && d.redirectChain.length > 1)
    out.push({
      label: "Redirects",
      value: (d.redirectChain as Array<Record<string, unknown>>)
        .map((h) => `${String(h.status ?? "")} ${String(h.url ?? "")}`.trim())
        .join(" → "),
      code: true,
    });
  if (isStr(d.finalUrl) && d.finalUrl !== d.target)
    out.push({ label: "Final address", value: d.finalUrl, code: true });
  if (Array.isArray(d.linkedFrom) && d.linkedFrom.length) {
    const from = d.linkedFrom as Array<Record<string, unknown>>;
    out.push({
      label: "Linked from",
      value:
        from
          .slice(0, 5)
          .map(
            (s) =>
              `${String(s.page ?? "")}${isStr(s.linkText) ? ` (“${short(s.linkText, 60)}”)` : ""}`,
          )
          .join("; ") + (from.length > 5 ? ` and ${from.length - 5} more` : ""),
    });
  }
  return out;
}

const brokenLink: GuideFn = (c) => {
  const d = c.ev("link_check")[0] ?? {};
  const internal = c.issue.ruleId === "broken-internal-link";
  const status = isNum(d.status) ? d.status : null;
  const html = c.snippet?.html ?? null;
  const fixed = html && withAttribute(html, "href", "[working address]", "a");
  return {
    problem: `A link on ${pagePhrase(c)} points to ${isStr(d.target) ? d.target : "an address"} that ${status ? `answered HTTP ${status}` : "could not be reached"} when the scanner checked it.`,
    nextAction: internal
      ? "Point the link to the right page, or restore (or redirect) the missing page."
      : "Update the link to a working address, or remove it.",
    steps: [
      `Open the link target directly in a browser to confirm it fails${status === 404 || status === 410 ? " (the page does not exist)" : ""}.`,
      internal
        ? "If the page moved, update the link (and add a 301 redirect from the old address); if it was deleted on purpose, remove the link or point it to the closest replacement."
        : "Find the current address of the content on the other site (search for it), or remove the link if it no longer exists.",
      `Edit the link on ${pagePhrase(c)}${isStr(d.target) ? ` — search the page's content or template for ${code(d.target)}` : ""}.`,
    ],
    examples:
      html && fixed
        ? [
            {
              title: "Point the link to a working address",
              language: "html",
              before: html,
              beforeOrigin: "observed",
              after: fixed,
              explanation:
                "Replace the placeholder with the correct address after checking that it opens.",
            },
          ]
        : [],
    caveats: [
      ...(status && [401, 403, 429, 999].includes(status)
        ? [
            `HTTP ${status} often means the other site refuses automated checks; open the link in a browser before removing it.`,
          ]
        : []),
      "The same link may appear in a menu or footer on many pages; fix it at its source.",
    ],
    facts: linkFacts(c),
  };
};

const redirectLink: GuideFn = (c) => {
  const d = c.ev("link_check")[0] ?? {};
  const html = c.snippet?.html ?? null;
  const target = isStr(d.target) ? d.target : null;
  const final = isStr(d.finalUrl) ? d.finalUrl : null;
  const href = attrOf(html, "href", "a");
  const fixed = html && final ? withAttribute(html, "href", final, "a") : null;
  return {
    nextAction: "Link directly to the final address so visitors skip the redirects.",
    steps: [
      "Check that the final address in the evidence is the intended page.",
      `Replace the link's address${target ? ` ${code(target)}` : ""} with the final one on ${pagePhrase(c)} (and in menus or templates that repeat it).`,
    ],
    examples:
      html && fixed && href
        ? [
            {
              title: "Link to the final address",
              language: "html",
              before: html,
              beforeOrigin: "observed",
              after: fixed,
              explanation:
                "Both addresses come from the scan: the link's current target and where its redirects ended.",
            },
          ]
        : target && final
          ? [
              {
                title: "Link to the final address",
                language: "text",
                before: target,
                beforeOrigin: "observed",
                after: final,
                explanation:
                  "Both addresses come from the scan: the link's current target and where its redirects ended.",
              },
            ]
          : [],
    caveats: ["Keep the redirects in place for old bookmarks and external links."],
    facts: linkFacts(c),
  };
};

const LINK_GUIDES: Record<string, GuideFn> = {
  "broken-internal-link": brokenLink,
  "broken-external-link": brokenLink,
  "link-temporarily-unavailable": (c) => ({
    nextAction:
      "Check the link again later before changing it — one failed check does not prove it is broken.",
    steps: [
      "Open the link target in a browser now, and again after some time.",
      "If it keeps failing, treat it as broken: update or remove the link.",
    ],
    caveats: ["Temporary errors (timeouts, HTTP 5xx, rate limits) often clear on their own."],
    gaps: [
      "The scanner could not reach the address reliably, so it reports this as temporary rather than broken.",
    ],
    facts: linkFacts(c),
  }),
  "redirect-chain": redirectLink,
  "internal-link-redirects": redirectLink,
  "failed-resource": (c) => {
    const d = c.ev("network")[0] ?? {};
    return {
      problem: `A ${isStr(d.resourceType) ? d.resourceType : "file"} that ${pagePhrase(c)} needs could not be loaded${isStr(d.result) ? ` (${d.result})` : ""}.`,
      nextAction:
        "Fix the file's address or upload the missing file, or remove the reference to it.",
      steps: [
        `Open ${isStr(d.url) ? code(d.url) : "the file's address"} directly to see the error.`,
        "If the path is wrong, correct it in the page or template; if the file is missing on the server or CDN, deploy it; if it is no longer needed, remove the reference.",
      ],
      facts: [
        ...(isStr(d.url) ? [{ label: "Resource", value: d.url, code: true }] : []),
        ...(isStr(d.resourceType) ? [{ label: "Type", value: d.resourceType }] : []),
        ...(isStr(d.result) ? [{ label: "Result", value: d.result }] : []),
        ...(Array.isArray(d.viewports) && d.viewports.length
          ? [{ label: "Screen sizes", value: d.viewports.join(", ") }]
          : []),
      ],
      regression:
        "Reload the page with the developer tools' Network panel open and check that no other request fails.",
    };
  },
  "mixed-content-active": (c) => mixedContent(c, true),
  "mixed-content-passive": (c) => mixedContent(c, false),
};

function mixedContent(c: Ctx, active: boolean): RuleGuide {
  const d = c.ev("network")[0] ?? {};
  const url = isStr(d.url) ? d.url : null;
  return {
    nextAction: `Load the ${active ? "script or stylesheet" : "image or media file"} over https://, or host it on the site itself.`,
    steps: [
      `Open ${url ? code(url.replace(/^http:/, "https:")) : "the https:// version of the address"} to check that the file is available over HTTPS.`,
      `If it is, change the address in the page or template to https://; if not, host a copy on the site${active ? " or replace the provider" : ""}.`,
    ],
    examples: url
      ? [
          {
            title: "Use the HTTPS address",
            language: "text",
            before: url,
            beforeOrigin: "observed",
            after: url.replace(/^http:/, "https:"),
            explanation:
              "The https:// address only works if the other server supports HTTPS — check it first.",
          },
        ]
      : [],
    facts: [
      ...(url ? [{ label: "Insecure request", value: url, code: true }] : []),
      ...(isStr(d.resourceType) ? [{ label: "Type", value: d.resourceType }] : []),
    ],
  };
}

// --- Performance ------------------------------------------------------------------------------

function fmtValue(v: number, unit: string): string {
  if (unit === "score" || !unit) return String(Math.round(v * 1000) / 1000);
  return `${Math.round(v)} ${unit}`;
}

function performanceFacts(c: Ctx): GuideFact[] {
  const out: GuideFact[] = [];
  const d = c.ev("measurement")[0];
  if (d && d.values && typeof d.values === "object") {
    const unit = isStr(d.unit) ? d.unit : "";
    const values = Object.entries(d.values as Record<string, unknown>).filter(([, v]) => isNum(v));
    if (values.length)
      out.push({
        label: `${isStr(d.label) ? d.label : "Measured"} (lab)`,
        value: values.map(([vp, v]) => `${vp}: ${fmtValue(v as number, unit)}`).join(" · "),
      });
    const t = d.thresholds as Record<string, unknown> | undefined;
    if (t && isNum(t.good) && isNum(t.poor))
      out.push({
        label: "Thresholds",
        value: `good ≤ ${fmtValue(t.good, unit)}, poor > ${fmtValue(t.poor, unit)}`,
      });
    if (isStr(d.lcpElement))
      out.push({ label: "Largest element", value: `<${d.lcpElement}>`, code: true });
  }
  const f = c.findings[0];
  if (!out.length && f) {
    if (f.actual) out.push({ label: "Measured", value: f.actual });
    if (f.expected) out.push({ label: "Recommended", value: f.expected });
  }
  const n = c.ev("network")[0];
  if (n && isStr(n.url)) out.push({ label: "File", value: n.url, code: true });
  if (n && isNum(n.bytes))
    out.push({
      label: "Size",
      value: `${n.bytes} bytes${isStr(n.source) ? ` (${n.source})` : ""}`,
    });
  const h = c.ev("html_snippet")[0];
  if (h && isStr(h.resource)) out.push({ label: "Resource", value: h.resource, code: true });
  return out;
}

const LAB_CAVEAT =
  "These are lab measurements from one scan in a test browser; real visitors' devices and networks differ, and results vary between runs.";

function perf(nextAction: string, steps: string[], extra: Partial<RuleGuide> = {}): GuideFn {
  return (c) => ({
    nextAction,
    steps: [
      `Measure ${pagePhrase(c)} in the browser's performance tools (for example Lighthouse in Chrome) to see what dominates.`,
      ...steps,
    ],
    caveats: [LAB_CAVEAT, ...(extra.caveats ?? [])],
    facts: performanceFacts(c),
    examples: extra.examples,
    regression:
      "Compare the measurements of the next scan with this one; check that the page still looks and works the same.",
  });
}

const PERFORMANCE_GUIDES: Record<string, GuideFn> = {
  "lcp-slow": perf(
    "Make the page's main content (its largest image or text block) appear sooner.",
    [
      "Identify the largest element (the evidence names its tag) and make it load early: compress and correctly size the image, and preload it if it is the main image.",
      "Reduce render-blocking CSS and JavaScript in the page head, and improve the server response time.",
    ],
  ),
  "cls-slow": perf(
    "Stop content from shifting while the page loads.",
    [
      "Give images, videos, embeds and ad slots their size in advance (width and height attributes or CSS aspect-ratio).",
      "Do not insert banners or content above existing content after the page has started rendering; load web fonts so they do not cause large reflows.",
    ],
    {
      examples: [
        {
          title: "Reserve space for an image",
          language: "html",
          before: '<img src="[image]">',
          beforeOrigin: "illustrative",
          after: '<img src="[image]" width="[width]" height="[height]">',
          explanation:
            "With width and height the browser reserves the space before the image arrives, so nothing below it moves.",
        },
      ],
    },
  ),
  "tbt-slow": perf("Reduce the JavaScript work that blocks the page while it loads.", [
    "Find long tasks in the Performance panel and the scripts that cause them.",
    "Remove unused scripts, defer non-critical ones, split large bundles and break long tasks into smaller pieces.",
  ]),
  "ttfb-slow": perf("Make the server start sending the page sooner.", [
    "Cache pages (server-side cache or CDN) and speed up slow database or back-end calls.",
    "Avoid redirects before the page and check the hosting capacity.",
  ]),
  "fcp-slow": perf("Show the first content sooner.", [
    "Inline the CSS needed for the top of the page and load the rest without blocking.",
    "Defer non-critical scripts and improve the server response time.",
  ]),
  "page-weight": perf("Reduce how much data the page downloads.", [
    "Compress and resize images, remove unused scripts and styles, and lazy-load content below the fold.",
  ]),
  "javascript-size": perf("Reduce the amount of JavaScript.", [
    "Remove unused libraries, split bundles per page and load non-critical scripts later.",
  ]),
  "css-size": perf("Reduce the amount of CSS.", [
    "Remove unused CSS and split the styles per page.",
  ]),
  "request-count": perf("Reduce the number of requests the page makes.", [
    "Bundle small files, remove unnecessary third-party scripts and inline very small assets.",
  ]),
  "image-large": perf(
    "Compress the image and serve it in a modern format at the size it is displayed.",
    [
      "Resize the image to its largest displayed size and export it as WebP or AVIF (keeping a JPEG/PNG fallback if needed).",
    ],
  ),
  "image-oversized": perf(
    "Serve the image close to the size it is displayed at.",
    ["Generate smaller versions and let the browser choose with srcset and sizes."],
    {
      examples: [
        {
          title: "Responsive image sizes",
          language: "html",
          before: null,
          beforeOrigin: null,
          after:
            '<img src="[image-800.jpg]"\n     srcset="[image-400.jpg] 400w, [image-800.jpg] 800w, [image-1600.jpg] 1600w"\n     sizes="(max-width: 600px) 100vw, 800px"\n     alt="[…]">',
          explanation:
            "The browser downloads the smallest file that is sharp enough for the visitor's screen.",
        },
      ],
    },
  ),
  "render-blocking-resource": (c) => {
    const d = c.ev("html_snippet")[0] ?? {};
    const resource = isStr(d.resource) ? d.resource : null;
    const script = d.type === "script";
    return {
      ...perf(
        script
          ? "Load the script without blocking the first render (defer or async)."
          : "Inline the critical CSS and load the rest of the stylesheet without blocking.",
        script
          ? [
              "Add defer to the script tag (keeps the order of scripts), or async for independent scripts, or move it to the end of <body>.",
            ]
          : [
              "Inline the styles needed for the first screen and load the full stylesheet afterwards; or split the stylesheet so each page loads less.",
            ],
      )(c),
      examples:
        script && resource
          ? [
              {
                title: "Defer the script",
                language: "html",
                before: `<script src="${resource}"></script>`,
                beforeOrigin: "illustrative",
                after: `<script src="${resource}" defer></script>`,
                explanation:
                  "defer downloads the script in parallel and runs it after the page has been parsed.",
              },
            ]
          : [],
      caveats: [
        LAB_CAVEAT,
        ...(script
          ? [
              "Scripts that use document.write or must run before other inline code may break when deferred; test the page after the change.",
            ]
          : []),
      ],
    };
  },
};

// --- Responsive and visual ---------------------------------------------------------------------

function measured(c: Ctx): GuideFact[] {
  const out: GuideFact[] = [];
  const d = c.ev("measurement")[0];
  if (!d) return out;
  if (isNum(d.viewportWidth)) out.push({ label: "Screen width", value: `${d.viewportWidth}px` });
  if (isNum(d.overflowPx))
    out.push({ label: "Page wider than the screen by", value: `${d.overflowPx}px` });
  if (Array.isArray(d.elements) && d.elements.length)
    out.push({
      label: "Widest elements",
      value: (d.elements as Array<Record<string, unknown>>)
        .slice(0, 3)
        .map(
          (e) => `${String(e.selector ?? "")}${isNum(e.right) ? ` (right edge ${e.right}px)` : ""}`,
        )
        .join("; "),
      code: true,
    });
  if (isNum(d.width) && isNum(d.height))
    out.push({ label: "Size", value: `${d.width}×${d.height}px` });
  if (isNum(d.scrollWidth) && isNum(d.clientWidth))
    out.push({ label: "Text width / box width", value: `${d.scrollWidth}px / ${d.clientWidth}px` });
  if (isStr(d.text)) out.push({ label: "Text", value: short(d.text, 200) });
  if (isNum(d.overlapRatio))
    out.push({
      label: "Overlap",
      value: `${Math.round(d.overlapRatio * 100)}% of the smaller target`,
    });
  if (isStr(d.src)) out.push({ label: "Image", value: d.src, code: true });
  return out;
}

const shotNote = (c: Ctx) =>
  c.findings.some((f) => f.evidence.some((e) => e.kind === "screenshot"))
    ? ["The screenshot in the evidence highlights the affected area."]
    : [];

const RESPONSIVE_GUIDES: Record<string, GuideFn> = {
  "horizontal-overflow": (c) => {
    const d = c.ev("measurement")[0] ?? {};
    const el = Array.isArray(d.elements)
      ? (d.elements[0] as Record<string, unknown> | undefined)
      : undefined;
    const sel = isStr(el?.selector) ? el.selector : (c.selectors[0] ?? null);
    return {
      nextAction: "Make the widest element fit the screen so the page no longer scrolls sideways.",
      steps: [
        locate(c, "the element that is wider than the screen"),
        "In the developer tools, look for a fixed width (width: 1200px), a large min-width, negative margins, 100vw widths or long unbroken text/URLs on that element or its children.",
        "Replace fixed widths with flexible ones (max-width: 100%, percentages, flex/grid) and let wide content such as tables scroll inside its own container.",
        ...shotNote(c),
      ],
      examples: sel
        ? [
            {
              title: "Keep the element within the screen",
              language: "css",
              before: null,
              beforeOrigin: null,
              after: `${sel} {\n  max-width: 100%;\n  box-sizing: border-box;\n}`,
              explanation:
                "The selector is the element the scanner measured as widest. max-width stops it from growing past its container; remove any fixed width that conflicts.",
            },
          ]
        : [],
      caveats: [
        "Do not just add overflow-x: hidden to the body: it hides the cut-off content instead of fixing the layout.",
      ],
      facts: measured(c),
      regression: "Check the other screen sizes (desktop, tablet) after the change.",
    };
  },
  "text-clipped": (c) => ({
    nextAction:
      "Let the text wrap or give its box enough room; show an ellipsis only where truncation is intended.",
    steps: [
      locate(c, "the text"),
      "Remove the fixed width/height or white-space: nowrap that cuts it off, or allow wrapping.",
      ...shotNote(c),
    ],
    examples: c.selectors[0]
      ? [
          {
            title: "Allow the text to wrap",
            language: "css",
            before: null,
            beforeOrigin: null,
            after: `${c.selectors[0]} {\n  white-space: normal;\n  overflow-wrap: anywhere;\n}`,
            explanation:
              "The text wraps onto the next line instead of being hidden. If truncation is intended, use text-overflow: ellipsis and make the full text available (for example in a tooltip or the next page).",
          },
        ]
      : [],
    gaps: ["The scanner reports this as needing review: some truncation is deliberate."],
    facts: measured(c),
  }),
  "interactive-overlap": (c) => ({
    nextAction: "Separate the overlapping links or buttons so each one can be tapped on its own.",
    steps: [
      locate(c, "the overlapping controls"),
      "Adjust spacing, layout or stacking order (z-index, position) at this screen size.",
      ...shotNote(c),
    ],
    gaps: [
      "Overlap is measured from element boxes; check by tapping both controls on a real or emulated phone.",
    ],
    facts: measured(c),
  }),
  "tap-target-small": targetSize,
  "text-too-small-mobile": (c) => ({
    nextAction:
      "Increase the text size on small screens (at least 12px, ideally 16px for body text).",
    steps: [
      locate(c, "the text"),
      "Raise the font size in the mobile styles, preferably with rem units.",
    ],
    examples: c.selectors[0]
      ? [
          {
            title: "Readable text size",
            language: "css",
            before: null,
            beforeOrigin: null,
            after: `${c.selectors[0]} {\n  font-size: 1rem; /* 16px by default */\n}`,
            explanation: "rem follows the visitor's preferred text size.",
          },
        ]
      : [],
    facts: c.findings[0]?.actual ? [{ label: "Measured sizes", value: c.findings[0].actual }] : [],
  }),
  "image-not-rendered": (c) => ({
    nextAction: "Replace the image file with a valid image in a supported format.",
    steps: [
      "Open the image address directly: if the browser cannot show it, the file is damaged or in an unsupported format.",
      "Re-export the image (JPEG, PNG, WebP, AVIF or SVG) and check that the server sends the right Content-Type.",
    ],
    facts: measured(c),
  }),
  "mobile-nav-unreachable": (c) => ({
    nextAction: "Provide a visible menu button on small screens that opens the navigation.",
    steps: [
      `Open ${pagePhrase(c)} at a phone-sized width and look for the menu.`,
      "Make sure the navigation (or a button that reveals it) is visible and reachable at that width.",
    ],
    facts: measured(c),
  }),
  "mobile-menu-broken": (c) => ({
    nextAction: "Fix the menu button so tapping it shows the navigation links.",
    steps: [
      `Open ${pagePhrase(c)} at a phone-sized width and tap the menu button with the developer tools' Console open.`,
      "Check the button's click handler for errors and the CSS that should show the menu.",
    ],
    facts: measured(c),
  }),
};

// --- Design and content comparison ----------------------------------------------------------

function designGuide(c: Ctx): RuleGuide {
  const token = c.ev("design_token")[0] ?? {};
  const style = c.ev("computed_style")[0] ?? {};
  const obs = Array.isArray(style.observations)
    ? (style.observations as Array<Record<string, unknown>>)
    : [];
  const o = obs[0];
  const props = isStr(style.property) ? style.property.split(" / ").map((s) => s.trim()) : [];
  const expected = isStr(token.expected) ? token.expected : (c.findings[0]?.expected ?? null);
  const actual = isStr(o?.actual) ? o.actual : (c.findings[0]?.actual ?? null);
  const sel = isStr(o?.selector) ? o.selector : (c.selectors[0] ?? null);
  const examples: CodeExample[] =
    sel && props.length && expected && actual
      ? [
          {
            title: "Match the design reference",
            language: "css",
            before: `${sel} {\n${props.map((p) => `  ${p}: ${actual};`).join("\n")}\n}`,
            beforeOrigin: "observed",
            after: `${sel} {\n${props.map((p) => `  ${p}: ${expected};`).join("\n")}\n}`,
            explanation: `Both values come from the scan: the website's computed ${props.join(" / ")} and the confirmed design reference${isStr(token.token) ? ` (${token.token})` : ""}. Change the shared style or design token rather than one element.`,
          },
        ]
      : expected && actual
        ? [
            {
              title: "Match the design reference",
              language: "text",
              before: actual,
              beforeOrigin: "observed",
              after: expected,
              explanation:
                "Replace the website's value with the value from the design reference wherever it is defined (search the stylesheets for it).",
            },
          ]
        : [];
  return {
    nextAction:
      "Change the website's style to the value in the confirmed design reference — or, if the website is right, update the reference.",
    steps: [
      locate(c, "the element"),
      "Find where the value is defined (design token, CSS variable or component style) and change it there.",
      "If the difference is intentional, update the design reference instead so future scans compare against the right value.",
    ],
    examples,
    caveats: [
      ...(isStr(style.mapping)
        ? [
            `The element was matched to the design value by ${style.mapping}${isNum(style.mappingConfidence) ? ` (mapping confidence ${style.mappingConfidence})` : ""}; if the match is wrong, add a CSS selector for this value in the design reference.`,
          ]
        : []),
    ],
    facts: [
      ...(isStr(token.token) ? [{ label: "Design token", value: token.token, code: true }] : []),
      ...(expected ? [{ label: "Design reference value", value: expected, code: true }] : []),
      ...(actual ? [{ label: "Website value", value: actual, code: true }] : []),
      ...(isNum(o?.deltaE) ? [{ label: "Color difference (ΔE)", value: String(o.deltaE) }] : []),
      ...(isStr(token.source) ? [{ label: "Reference source", value: token.source }] : []),
      ...(isStr(token.tolerance) ? [{ label: "Tolerance", value: token.tolerance }] : []),
    ],
  };
}

function contentGuide(c: Ctx): RuleGuide {
  const diff = c.ev("text_diff")[0];
  const doc = c.ev("document")[0] ?? {};
  const link = c.ev("link_check")[0];
  const approved = isStr(diff?.reference)
    ? diff.reference
    : isStr(doc.referenceText)
      ? doc.referenceText
      : (c.findings[0]?.expected ?? null);
  const website = isStr(diff?.website) ? diff.website : null;
  const rule = c.issue.ruleId;
  const examples: CodeExample[] = [];
  if (link && isStr(link.expectedHref))
    examples.push({
      title: "Use the approved link target",
      language: "text",
      before: isStr(link.actualHref) ? link.actualHref : "(no link)",
      beforeOrigin: "observed",
      after: link.expectedHref,
      explanation:
        "Both addresses come from the scan: where the link points now and where the approved content says it should point.",
    });
  else if (approved && rule !== "content-cta-not-link")
    examples.push({
      title: rule === "content-missing" ? "Add the approved text" : "Use the approved wording",
      language: "text",
      before: website,
      beforeOrigin: website ? "observed" : null,
      after: approved,
      explanation:
        "The approved text is copied from the uploaded content document; the website text from the scanned page.",
    });
  return {
    nextAction:
      rule === "content-missing"
        ? "Add the approved text to the page, or confirm with the content owner that it was removed on purpose."
        : rule === "content-cta-not-link"
          ? "Turn the call to action into a working link or button."
          : "Update the website text (or link) to match the approved content, or confirm that the change was intended.",
    steps: [
      `Open ${pagePhrase(c)}${c.selectors.length ? ` and find ${elementPhrase(c, "the element")}` : ""}.`,
      `Compare it with the approved document${isStr(doc.location) ? ` (${doc.location})` : isStr(doc.document) ? ` (${doc.document})` : ""}.`,
      "Edit the text in the CMS or template; if the website is right and the document is outdated, update the document instead.",
    ],
    examples,
    caveats: ["Ask the content owner before changing legal, pricing or product statements."],
    facts: [
      ...(isStr(doc.document) ? [{ label: "Approved document", value: doc.document }] : []),
      ...(isStr(doc.location) ? [{ label: "Location in the document", value: doc.location }] : []),
      ...(isNum(diff?.similarity)
        ? [{ label: "Text similarity", value: String(diff.similarity) }]
        : []),
    ],
    gaps:
      c.issue.verdict !== "confirmed"
        ? [
            "The page was matched to the document with limited certainty; check that this is the right page before changing it.",
          ]
        : [],
  };
}

// --- Design Quality & Typography -----------------------------------------------------------------

/** Values stated by the finding itself (expected / actual), shown as facts. */
function dqFacts(c: Ctx): GuideFact[] {
  const f = c.findings[0];
  const out: GuideFact[] = [];
  if (f?.expected) out.push({ label: "Expected", value: f.expected });
  if (f?.actual) out.push({ label: "Measured", value: f.actual });
  return out;
}

const DESIGN_QUALITY_GUIDES: Record<string, GuideFn> = {
  "dq-heading-inconsistent": (c) => {
    const style = c.ev("computed_style")[0] ?? {};
    const level = isStr(style.headingLevel) ? style.headingLevel.toLowerCase() : "h2";
    return {
      nextAction: `Decide which style is correct for ${level.toUpperCase()} headings and apply it to all of them through one shared style.`,
      steps: [
        locate(c, "the heading that differs"),
        "Compare its font family, size, weight and style with the most common style listed in the evidence.",
        "Remove page- or component-specific overrides (inline styles, one-off classes) so every heading of this level uses the shared heading style or design token.",
        SOURCE_STEP,
        ...shotNote(c),
      ],
      examples: [
        {
          title: "One shared style per heading level",
          language: "css",
          before: null,
          beforeOrigin: null,
          after: `${level} {\n  font-family: [brand heading font];\n  font-size: [agreed size];\n  font-weight: [agreed weight];\n}`,
          explanation:
            "Values in [brackets] come from your brand guideline or design; the scan does not know which of the measured styles is the intended one.",
        },
      ],
      gaps: [
        "The scan cannot tell whether a different heading style is deliberate (for example a hero or card heading). Treat this as a review item.",
      ],
      facts: dqFacts(c),
    };
  },
  "dq-heading-hierarchy-inverted": (c) => ({
    nextAction:
      "Make higher-level headings at least as large as lower-level ones, or change the heading levels to match their importance.",
    steps: [
      locate(c, "the larger lower-level heading"),
      "If the heading is styled large on purpose, check whether it should really be a higher level (change the tag, not just the size).",
      "Otherwise reduce its size or increase the size of the higher-level headings in the shared heading styles.",
      ...shotNote(c),
    ],
    caveats: [
      "Changing a heading's level (h2 → h3) also changes the page outline for screen-reader users; keep the levels in order.",
    ],
    facts: dqFacts(c),
  }),
  "dq-webfont-not-rendered": (c) => {
    const style = c.ev("computed_style")[0] ?? {};
    const family = isStr(style.declaredFamily) ? style.declaredFamily : "[font family]";
    const faces = Array.isArray(style.webFontFaces)
      ? (style.webFontFaces as Array<Record<string, unknown>>)
      : [];
    return {
      nextAction: `Make the “${family}” web font load so the browser uses it instead of a fallback.`,
      steps: [
        `Open ${pagePhrase(c)} with the developer tools' Network tab filtered to “Font” and reload: look for failed (red) font requests.`,
        "Check the @font-face rule: the url() must point to an existing file, the format must match the file, and the font-family name must be spelled exactly as in the font-family property.",
        "If the font loads but text still falls back, the font file may not contain the characters used (subset fonts); include the needed character ranges.",
        "When fonts come from another domain, check that the font server allows the site's origin (CORS).",
      ],
      examples: [
        {
          title: "A working @font-face rule",
          language: "css",
          before: null,
          beforeOrigin: null,
          after: `@font-face {\n  font-family: "${family}";\n  src: url("/fonts/[file].woff2") format("woff2");\n  font-display: swap;\n}`,
          explanation:
            "The family name must match the name used in font-family. [file] is your font file; the scan does not know where it is hosted.",
        },
      ],
      facts: [
        ...dqFacts(c),
        ...(faces.length
          ? [
              {
                label: "Web font status reported by the page",
                value: faces
                  .slice(0, 4)
                  .map(
                    (f) =>
                      `${String(f.weight ?? "")} ${String(f.style ?? "")}: ${String(f.status ?? "")}`,
                  )
                  .join("; "),
              },
            ]
          : []),
      ],
    };
  },
  "dq-font-not-approved": (c) => ({
    nextAction:
      "Set the listed text in one of the brand fonts, or confirm that this font is allowed for it.",
    steps: [
      locate(c, "the text"),
      "Change the font-family of that text (or of the shared style it uses) to the brand font.",
      "If the font is allowed, no change is needed; set the issue to Ignored with a note.",
    ],
    gaps: [
      "The uploaded font files say which fonts the brand uses, not which text must use them; this is a review item.",
    ],
    facts: dqFacts(c),
  }),
  "dq-image-upscaled": (c) => {
    const m = c.ev("measurement")[0] ?? {};
    return {
      nextAction:
        "Use an image file at least as large as the size it is displayed at (twice that for high-density screens).",
      steps: [
        locate(c, "the image"),
        "Export or request the image at a higher resolution, and offer several sizes with srcset so each screen gets a sharp version.",
        "Alternatively, display the image smaller.",
      ],
      examples: [
        {
          title: "Offer sharp versions with srcset",
          language: "html",
          before: null,
          beforeOrigin: null,
          after: `<img src="[image]-800.jpg"\n     srcset="[image]-800.jpg 800w, [image]-1600.jpg 1600w"\n     sizes="[displayed width]"\n     alt="[description]">`,
          explanation:
            "The browser picks the file that fits the screen. [image] and the sizes are placeholders for your own files.",
        },
      ],
      gaps: [
        "Measured at standard pixel density (1×). The scan does not judge blur or compression from the pixels themselves.",
      ],
      facts: [
        ...dqFacts(c),
        ...(isStr(m.src) ? [{ label: "Image", value: m.src, code: true }] : []),
      ],
    };
  },
  "dq-image-distorted": (c) => {
    const sel = c.selectors[0];
    return {
      nextAction:
        "Keep the image's proportions: let its height follow its width, or crop it with object-fit.",
      steps: [
        locate(c, "the image"),
        "Remove fixed width and height values that do not match the image's proportions, or use object-fit: cover to crop instead of stretch.",
      ],
      examples: sel
        ? [
            {
              title: "Crop instead of stretching",
              language: "css",
              before: null,
              beforeOrigin: null,
              after: `${sel} {\n  object-fit: cover;\n}`,
              explanation:
                "The image fills its box without changing its proportions (edges may be cropped).",
            },
          ]
        : [],
      facts: dqFacts(c),
    };
  },
  "dq-spacing-off-scale": (c) => ({
    nextAction:
      "Replace the listed spacing values with the nearest value on the design reference's spacing scale, where the difference is not intentional.",
    steps: [
      `Open ${pagePhrase(c)} and inspect the sample elements listed in the evidence.`,
      "Change margins, paddings and gaps to values from the spacing scale (ideally through spacing tokens or CSS variables).",
      SOURCE_STEP,
    ],
    gaps: [
      "Browser default margins and optical adjustments also appear here; decide per value whether it matters.",
    ],
    facts: dqFacts(c),
  }),
  "dq-alignment-near-miss": (c) => ({
    nextAction:
      "Align the two elements on the same left edge (or make an intended indent clearly larger).",
    steps: [
      locate(c, "the lower element"),
      "Compare its margin-left, padding-left and border with the element above it; remove the small difference.",
      ...shotNote(c),
    ],
    facts: dqFacts(c),
  }),
  "dq-spacing-inconsistent": (c) => ({
    nextAction:
      "Space the repeated items evenly, preferably with the container's gap property instead of per-item margins.",
    steps: [
      locate(c, "the repeated items"),
      "Look for an item with an extra margin, a different class or a wrapper that changes its spacing.",
      ...shotNote(c),
    ],
    examples: [
      {
        title: "Even spacing from the container",
        language: "css",
        before: null,
        beforeOrigin: null,
        after: "[container] {\n  display: flex; /* or grid */\n  gap: [spacing value];\n}",
        explanation:
          "gap spaces every item the same; [container] and [spacing value] are placeholders.",
      },
    ],
    facts: dqFacts(c),
  }),
};

// ---------------------------------------------------------------------------------------------

const ACCESSIBILITY_GUIDES: Record<string, GuideFn> = {
  "image-alt": imageAlt,
  "input-image-alt": imageAlt,
  "role-img-alt": imageAlt,
  "svg-img-alt": imageAlt,
  "color-contrast": colorContrast,
  "color-contrast-enhanced": colorContrast,
  "link-name": controlName,
  "button-name": controlName,
  "input-button-name": controlName,
  label: formLabel,
  "select-name": formLabel,
  "html-has-lang": pageLang,
  "html-lang-valid": pageLang,
  "document-title": pageTitle,
  "focus-indicator-visible": focusVisible,
  "target-size": targetSize,
  region: landmarks,
  "landmark-one-main": landmarks,
  "heading-order": headingStructure,
  "empty-heading": headingStructure,
  "page-has-heading-one": headingStructure,
  "meta-viewport": viewportZoom,
  "meta-viewport-large": viewportZoom,
};

const GUIDES: Record<string, Record<string, GuideFn>> = {
  accessibility: ACCESSIBILITY_GUIDES,
  security: SECURITY_GUIDES,
  seo: SEO_GUIDES,
  links: LINK_GUIDES,
  performance: PERFORMANCE_GUIDES,
  responsive: RESPONSIVE_GUIDES,
  design_quality: DESIGN_QUALITY_GUIDES,
};

/** Rule ids with a specific fix guide (tests keep these in step with the scanners). */
export const GUIDED_RULES: Record<string, string[]> = Object.fromEntries(
  Object.entries(GUIDES).map(([k, v]) => [k, Object.keys(v)]),
);

function ruleGuide(c: Ctx): { guide: RuleGuide; specific: boolean } {
  const { category, ruleId } = c.issue;
  if (category === "design") return { guide: designGuide(c), specific: true };
  if (category === "content") return { guide: contentGuide(c), specific: true };
  if (category === "security" && ruleId?.startsWith("exposed-secret-"))
    return { guide: exposedSecret(c), specific: true };
  const table = GUIDES[category];
  const fn = ruleId && table && Object.hasOwn(table, ruleId) ? table[ruleId] : undefined;
  if (fn) return { guide: fn(c), specific: true };
  if (category === "accessibility") return { guide: accessibilityDefault(c), specific: false };
  return { guide: generalGuide(c), specific: false };
}

function firstSentence(s: string): string {
  const m = /^.*?[.!?](?=\s|$)/s.exec(s.trim());
  return (m ? m[0] : s).trim();
}

function generalGuide(c: Ctx): RuleGuide {
  const rec = recommendationSteps(c.issue.recommendation);
  const f = c.findings[0];
  return {
    nextAction: rec[0] ?? "Review the findings and their evidence, then fix the underlying cause.",
    steps: [
      c.selectors.length ? locate(c, "the element") : `Open ${pagePhrase(c)}.`,
      ...(rec.length
        ? rec
        : [
            "Review the scanner's message and evidence in the technical details, and fix the cause.",
          ]),
    ],
    facts: [
      ...(f?.expected && f.expected.length <= 200
        ? [{ label: "Expected", value: f.expected }]
        : []),
      ...(f?.actual && f.actual.length <= 200 ? [{ label: "Found", value: f.actual }] : []),
      ...measured(c),
    ],
  };
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/**
 * The fix guide for an issue occurrence. Deterministic for the same stored data; the AI
 * explanation (when stored) replaces only the parts it covers.
 */
export function buildIssueGuide(issue: GuideIssue): IssueGuide {
  const c = context(issue);
  const e = explainIssue(issue.category, issue.ruleId);
  const { guide: g, specific } = ruleGuide(c);
  const ai = issue.explanation ?? null;
  const aiParts: AiGuidePart[] = [];
  const pick = <T>(part: AiGuidePart, aiValue: T | undefined, fallback: T): T => {
    if (aiValue === undefined || (Array.isArray(aiValue) && aiValue.length === 0)) return fallback;
    aiParts.push(part);
    return aiValue;
  };

  const verdict = VERDICT_MEANINGS[issue.verdict];
  const uncertain = issue.verdict !== "confirmed";
  const nextRule = uncertain
    ? `First check whether the problem is real — ${lowerFirst(verdict?.meaning ?? "the scanner could not confirm it")} If it is: ${lowerFirst(g.nextAction)}`
    : g.nextAction;

  const host = c.pages[0] ? safeHost(c.pages[0]) : null;
  const atSizes = c.viewports.length ? ` at the ${c.viewports.join(" / ")} screen size` : "";
  const verify = [
    "Make the change in the source (code, template, theme or CMS) — a change made only in the browser's developer tools is lost on reload.",
    `Publish it to the site that was scanned${host ? ` (${host})` : ""} through your normal deployment process.`,
    ...(e.check ? [e.check] : []),
    `${rescanAdvice(issue.category)}${atSizes ? ` For this issue, include the same screen sizes (${c.viewports.join(", ")}).` : ""}`,
    "After that scan, open this issue again: if the scan no longer finds it, the History comparison lists it as Resolved; if it is found again, it stays open (or is reopened automatically). Marking it Resolved yourself does not verify the fix.",
    g.regression ??
      "Check the new scan's other issues for the same pages to make sure the change did not introduce new problems.",
  ];

  const gaps = [
    ...(uncertain && verdict ? [`${verdict.label}: ${verdict.meaning}`] : []),
    ...(g.gaps ?? []),
    ...(!specific
      ? [
          "There is no rule-specific guide for this check; the steps come from the stored fix guidance and the scanner's own message.",
        ]
      : []),
  ];

  return {
    problem: pick("problem", ai?.problem, g.problem ?? e.meaning),
    whyItMatters: pick("whyItMatters", ai?.impact, e.impact),
    nextAction: pick("nextAction", ai?.nextStep, nextRule),
    aiParts,
    snippet: c.snippet,
    facts: g.facts ?? [],
    steps: pick("steps", ai?.steps, g.steps),
    examples: (g.examples ?? []).map((x) =>
      x.beforeOrigin === "observed" && c.findings.length > 1
        ? {
            ...x,
            explanation: `${x.explanation} The example uses one of the ${c.findings.length} affected elements (${c.snippet?.findingId ?? c.findings[0]!.displayId}); check each of the others the same way.`,
          }
        : x,
    ),
    caveats: [...pick("caveats", ai?.caveats, [] as string[]), ...(g.caveats ?? [])],
    verify,
    gaps,
    specific,
  };
}
