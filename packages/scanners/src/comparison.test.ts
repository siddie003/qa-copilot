import { designSpecSchema, normalizeText, planScanSteps } from "@qa/core";
import { describe, expect, it } from "vitest";
import { contentScanner, mapSection } from "./content";
import { buildTargets, compareValue, designScanner } from "./design";
import {
  findingDraftSchema,
  type CaptureRecord,
  type ContentBlockRecord,
  type PageRecord,
  type ScannerContext,
} from "./types";

// Synthetic captures: exercises the comparison logic without a browser.
const styles = (over: Record<string, string> = {}) => ({
  color: "rgb(34, 34, 34)",
  backgroundColor: "rgba(0, 0, 0, 0)",
  effectiveBackground: "rgb(255, 255, 255)",
  fontFamily: "Inter, sans-serif",
  fontSize: "16px",
  fontWeight: "400",
  lineHeight: "24px",
  letterSpacing: "normal",
  borderTopLeftRadius: "0px",
  paddingTop: "0px",
  paddingRight: "0px",
  paddingBottom: "0px",
  paddingLeft: "0px",
  maxWidth: "none",
  ...over,
});
const role = (method: string, s: ReturnType<typeof styles>, count = 1) => ({
  method,
  selector: "x",
  count,
  variants: [
    {
      count,
      styles: s,
      sample: { selector: "main > x", text: "Sample", box: { x: 0, y: 0, width: 10, height: 10 } },
    },
  ],
});
const none = { method: "none", selector: "x", count: 0, variants: [] };

function capture(
  over: Partial<CaptureRecord> & { design?: unknown; text?: unknown },
): CaptureRecord {
  const { design = null, text = null, ...rest } = over;
  return {
    pageId: "p1",
    viewport: "desktop",
    width: 1440,
    height: 900,
    screenshotKey: "scans/s/pages/p1/desktop.png",
    error: null,
    timings: {},
    metrics: null,
    consoleMessages: [],
    requests: [],
    loadDom: async () => null,
    loadDesignStyles: async () => design as Record<string, unknown> | null,
    loadTextContent: async () => text as Record<string, unknown> | null,
    ...rest,
  };
}

function page(id: string, url: string, captures: CaptureRecord[]): PageRecord {
  return {
    id,
    url,
    finalUrl: null,
    httpStatus: 200,
    depth: 0,
    title: null,
    contentType: "text/html",
    crawlError: null,
    redirectChain: null,
    responseHeaders: {},
    loadRawHtml: async () => null,
    captures: captures.map((c) => ({ ...c, pageId: id })),
  };
}

function ctx(pages: PageRecord[], references: ScannerContext["references"]): ScannerContext {
  return {
    scanId: "s1",
    siteUrl: "https://example.com/",
    viewports: [
      { name: "desktop", width: 1440, height: 900 },
      { name: "mobile", width: 390, height: 844 },
    ],
    pages,
    robots: null,
    fetch: {} as never,
    signal: new AbortController().signal,
    openPage: async () => {
      throw new Error("no browser");
    },
    pageTimeoutMs: 1000,
    log: () => {},
    references,
  };
}

describe("design comparison", () => {
  it("compares values with tolerances: ΔE for colors, ±0.5px for sizes", () => {
    const c = (expected: string, actual: string) =>
      compareValue({ kind: "color", props: ["color"], expected }, styles({ color: actual }));
    expect(c("#222222", "rgb(34, 34, 34)")).toMatchObject({ verdict: "match", deltaE: 0 });
    expect(c("#e2e8f0", "rgb(241, 245, 249)")).toMatchObject({
      verdict: "potential",
      actual: "#f1f5f9",
    });
    expect(c("#1a56db", "rgb(6, 69, 173)").verdict).toBe("mismatch");
    const px = (expected: number, over: Record<string, string>, props = ["fontSize"] as const) =>
      compareValue({ kind: "px", props: [...props], expected }, styles(over));
    expect(px(16, { fontSize: "16.4px" }).verdict).toBe("match");
    expect(px(48, { fontSize: "40px" })).toMatchObject({ verdict: "mismatch", actual: "40px" });
    expect(
      compareValue(
        { kind: "px", props: ["lineHeight"], expected: 24 },
        styles({ lineHeight: "normal" }),
      ).verdict,
    ).toBe("unverifiable");
    expect(
      compareValue({ kind: "px", props: ["letterSpacing"], expected: 0 }, styles()).verdict,
    ).toBe("match");
    expect(
      compareValue(
        { kind: "px", props: ["paddingLeft", "paddingRight"], expected: 24 },
        styles({ paddingLeft: "24px", paddingRight: "20px" }),
      ),
    ).toMatchObject({ verdict: "mismatch", actual: "24px / 20px" });
    expect(
      compareValue({ kind: "family", props: ["fontFamily"], expected: "Inter" }, styles()).verdict,
    ).toBe("match");
    expect(
      compareValue({ kind: "family", props: ["fontFamily"], expected: "Georgia" }, styles())
        .verdict,
    ).toBe("mismatch");
    expect(
      compareValue({ kind: "family", props: ["fontFamily"], expected: "Inter" }, styles(), [
        { family: "Inter", status: "error" },
      ]),
    ).toMatchObject({ verdict: "mismatch", actual: expect.stringMatching(/failed to load/) });
    expect(
      compareValue(
        { kind: "weight", props: ["fontWeight"], expected: 700 },
        styles({ fontWeight: "700" }),
      ).verdict,
    ).toBe("match");
  });

  it("derives comparison targets from every spec value (and skips what is absent)", () => {
    const spec = designSpecSchema.parse({
      typography: { h1: { fontSize: 48, fontWeight: 700 } },
      colors: { Brand: { value: "#1a56db" }, Link: { value: "#1a56db", role: "link" } },
      components: { buttonPrimary: { paddingX: 24, selector: ".cta" } },
    });
    const keys = buildTargets(spec).map((t) => `${t.key}@${t.selector ?? t.role}:${t.scope}`);
    expect(keys).toEqual([
      "typography.h1.fontSize@h1:widest",
      "typography.h1.fontWeight@h1:all",
      "colors.Link@link:all",
      "components.buttonPrimary.paddingX@.cta:widest",
    ]);
  });

  it("reports matches, confirmed and potential mismatches and unable-to-verify items", async () => {
    const design = (h1Size: string) => ({
      viewportWidth: 1440,
      roles: {
        h1: role(
          "semantic",
          styles({ fontFamily: "Georgia, serif", fontSize: h1Size, fontWeight: "700" }),
        ),
        h2: none,
        h3: none,
        body: role("semantic", styles(), 4),
        link: role("semantic", styles({ color: "rgb(6, 69, 173)" })),
        button: none,
        buttonPrimary: role(
          "heuristic",
          styles({ effectiveBackground: "rgb(29, 78, 216)", borderTopLeftRadius: "6px" }),
        ),
        buttonSecondary: none,
        header: role("semantic", styles({ effectiveBackground: "rgb(241, 245, 249)" })),
        footer: none,
        page: role("semantic", styles()),
        container: none,
      },
      explicit: {},
      palette: {
        text: [
          { color: "rgb(34, 34, 34)", count: 9, sample: "p" },
          { color: "rgb(32, 95, 224)", count: 3, sample: ".promo" },
        ],
        background: [],
      },
      fonts: [],
    });
    const pages = [
      page("p1", "https://example.com/", [
        capture({ design: design("40px") }),
        capture({ viewport: "mobile", width: 390, design: design("28px") }),
      ]),
      page("p2", "https://example.com/about", [capture({ design: design("40px") })]),
    ];
    const spec = designSpecSchema.parse({
      typography: {
        h1: { fontFamily: "Georgia", fontSize: 48, fontWeight: 700 },
        body: { fontFamily: "Inter", lineHeight: 24 },
        h3: { fontSize: 20 },
      },
      colors: {
        Text: { value: "#222222", role: "text" },
        Link: { value: "#1a56db", role: "link" },
        Header: { value: "#e2e8f0", role: "headerBackground" },
      },
      components: {
        buttonPrimary: { background: "#1a56db", borderRadius: 8 },
        buttonSecondary: { background: "#ffffff" },
      },
      layout: { containerMaxWidth: { value: 1200 } },
    });
    const r = await designScanner.run(
      ctx(pages, { designSpec: { id: "d1", version: 3, spec }, content: null }),
    );
    expect(r.status).toBe("completed");
    const verdict = Object.fromEntries(r.checks.comparison!.items.map((i) => [i.key, i.verdict]));
    expect(verdict).toMatchObject({
      "typography.h1.fontFamily": "match",
      "typography.h1.fontWeight": "match",
      "typography.h1.fontSize": "confirmed_mismatch", // semantic h1, 40px vs 48px (widest viewport only)
      "typography.body.fontFamily": "match",
      "typography.body.lineHeight": "match",
      "colors.Text": "match",
      "colors.Link": "confirmed_mismatch", // ΔE 7.86 on semantic links
      "colors.Header": "potential_mismatch", // ΔE 3.36
      "components.buttonPrimary.background": "potential_mismatch", // heuristic mapping, ΔE 2.61
      "components.buttonPrimary.borderRadius": "potential_mismatch", // heuristic mapping
      "components.buttonSecondary.background": "unable_to_verify",
      "layout.containerMaxWidth": "unable_to_verify",
      "typography.h3.fontSize": "unable_to_verify",
      "typography.link": "unable_to_verify", // on the site, not in the reference
    });
    expect(verdict["typography.h2"]).toBeUndefined(); // not on the site, not in the reference
    const h1 = r.findings.find((f) => f.ruleId === "design-font-size-mismatch")!;
    expect(h1).toMatchObject({
      verdict: "confirmed",
      expected: "48px",
      actual: "40px",
      viewport: "desktop",
      fingerprintKey: "typography.h1.fontSize",
    });
    expect(h1.message).toMatch(/2 pages/);
    expect(h1.evidence.map((e) => e.kind)).toEqual([
      "design_token",
      "computed_style",
      "screenshot",
    ]);
    // A palette near-miss (#205fe0 vs #1a56db, ΔE 3.0) is a potential finding.
    expect(r.findings.find((f) => f.ruleId === "design-color-near-palette")).toMatchObject({
      verdict: "potential",
      actual: "#205fe0",
    });
    // The link color already reported is not reported again as a near-miss.
    expect(r.findings.filter((f) => f.actual === "#0645ad")).toHaveLength(1);
    for (const f of r.findings) expect(findingDraftSchema.safeParse(f).success).toBe(true);
    expect(r.checks.inconclusive.map((i) => i.check)).toContain("Secondary button background");
  });

  it("is inconclusive without captured styles", async () => {
    const spec = designSpecSchema.parse({ typography: { h1: { fontSize: 48 } } });
    const r = await designScanner.run(
      ctx([page("p1", "https://example.com/", [capture({})])], {
        designSpec: { id: "d", version: 1, spec },
        content: null,
      }),
    );
    expect(r.status).toBe("inconclusive");
  });
});

const block = (
  order: number,
  type: string,
  text: string,
  extra: Partial<ContentBlockRecord> = {},
): ContentBlockRecord => ({
  order,
  type,
  level: type === "heading" ? 1 : null,
  text,
  normalizedText: normalizeText(text),
  href: null,
  pageHint: null,
  location: { index: order, line: order + 1 },
  ...extra,
});

describe("content comparison", () => {
  const text = (
    title: string,
    blocks: Array<[string, string]>,
    links: Array<[string, string]> = [],
  ) => ({
    title,
    blocks: blocks.map(([tag, t], i) => ({
      tag,
      text: t,
      selector: `main > ${tag}:nth-of-type(${i + 1})`,
    })),
    links: links.map(([t, href]) => ({ kind: "link", text: t, href, selector: "a" })),
  });
  const site = [
    page("home", "https://example.com/", [capture({ text: text("Home", [["h1", "Welcome"]]) })]),
    page("about", "https://example.com/about", [
      capture({
        text: text(
          "About us",
          [
            ["h1", "About us"],
            ["p", "We sell demo products."],
            ["p", "Our team ships quality products to customers every week."],
            ["h2", "Our mission"],
            ["p", "Contact our team"],
          ],
          [["Contact our team", "https://example.com/blog/"]],
        ),
      }),
    ]),
    page("products", "https://example.com/products", [
      capture({
        text: text("Products", [
          ["h1", "Products"],
          ["p", "Prices include VAT (low-contrast text)."],
          ["p", "Browse our full range of widgets and gadgets."],
        ]),
      }),
    ]),
    page("contact", "https://example.com/contact", [
      capture({
        text: text("Contact", [
          ["h1", "Contact"],
          ["p", "Write to us."],
        ]),
      }),
    ]),
  ];

  it("maps sections explicitly, by page name and by heading similarity", () => {
    const pts = site.map((p) => ({
      page: p,
      url: p.url,
      path: new URL(p.url).pathname.replace(/\/$/, "") || "/",
      title: p.id === "about" ? "About us" : p.id[0]!.toUpperCase() + p.id.slice(1),
      headings: [p.id === "about" ? "About us" : p.id[0]!.toUpperCase() + p.id.slice(1)],
      blocks: [],
      links: [],
      fullKey: "",
      fullCanon: "",
      capture: p.captures[0]!,
    }));
    expect(mapSection("/about", null, null, pts, "https://example.com/")).toMatchObject({
      confidence: 1,
      page: { path: "/about" },
    });
    expect(mapSection(null, "/products/", null, pts, "https://example.com/")).toMatchObject({
      confidence: 1,
      page: { path: "/products" },
    });
    expect(mapSection("Products", "/about", null, pts, "https://example.com/")).toMatchObject({
      confidence: 0.8,
      page: { path: "/products" },
    });
    expect(mapSection(null, null, "Contact", pts, "https://example.com/")).toMatchObject({
      confidence: 0.75,
      page: { path: "/contact" },
    });
    // An exact name match wins over near matches ("Product" titles of sub-pages).
    const withProduct = [
      ...pts,
      { ...pts[2]!, path: "/products/widget", title: "Product", headings: ["Widget"] },
    ];
    expect(mapSection("Products", null, null, withProduct, "https://example.com/")).toMatchObject({
      page: { path: "/products" },
    });
    expect(mapSection("Careers", null, null, pts, "https://example.com/")).toMatchObject({
      page: null,
      reason: expect.stringMatching(/Careers/),
    });
    expect(mapSection("/pricing", null, null, pts, "https://example.com/")).toMatchObject({
      page: null,
      reason: expect.stringMatching(/not crawled/),
    });
  });

  it("classifies blocks as match, changed wording, capitalization, missing, wrong CTA target, unable to verify", async () => {
    const blocks = [
      block(0, "heading", "Contact"),
      block(1, "paragraph", "We reply within one business day."),
      block(2, "heading", "About us", { pageHint: "/about" }),
      block(3, "paragraph", "We sell demo products", { pageHint: "/about" }),
      block(4, "paragraph", "Our team ships quality products to customers every single week.", {
        pageHint: "/about",
      }),
      block(5, "heading", "Our Mission", { pageHint: "/about" }),
      block(6, "paragraph", "Free shipping on all orders over $50.", { pageHint: "/about" }),
      block(7, "cta", "Contact our team", { pageHint: "/about", href: "/contact" }),
      block(8, "paragraph", "Prices include VAT.", { pageHint: "Products" }),
      block(9, "paragraph", "Browse our full range of widgets and gadgets today.", {
        pageHint: "Products",
      }),
      block(10, "heading", "Join our team", { pageHint: "Careers" }),
    ];
    const r = await contentScanner.run(
      ctx(site, {
        designSpec: null,
        content: {
          documents: [{ id: "doc1", filename: "approved.md", targetPath: null, blocks }],
          missing: [],
        },
      }),
    );
    const v = r.checks.comparison!.items.map((i) => i.verdict);
    expect(v).toEqual([
      "match", // Contact (heading similarity)
      "potential_mismatch", // missing on a heading-mapped page → potential
      "match",
      "match", // trailing punctuation ignored
      "confirmed_mismatch", // changed wording, explicit mapping
      "potential_mismatch", // capitalization
      "confirmed_mismatch", // missing
      "confirmed_mismatch", // CTA target
      "match", // contained in a longer block
      "potential_mismatch", // changed wording, name-mapped page
      "unable_to_verify", // Careers page not found
    ]);
    const rules = r.findings.map((f) => `${f.ruleId}:${f.verdict}`);
    expect(rules).toEqual([
      "content-missing:potential",
      "content-changed-wording:confirmed",
      "content-capitalization:potential",
      "content-missing:confirmed",
      "content-link-target-mismatch:confirmed",
      "content-changed-wording:potential",
    ]);
    const changed = r.findings[1]!;
    const diff = changed.evidence.find((e) => e.kind === "text_diff")!.data.diff as Array<{
      op: string;
      text: string;
    }>;
    expect(diff.filter((d) => d.op === "missing_on_website").map((d) => d.text.trim())).toEqual([
      "single",
    ]);
    expect(r.findings[4]).toMatchObject({
      severity: "high",
      actual: "Contact our team → https://example.com/blog/",
    });
    expect(r.checks.inconclusive[0]!.reason).toMatch(/Careers/);
    for (const f of r.findings) expect(findingDraftSchema.safeParse(f).success).toBe(true);
  });

  it("plans comparison steps only when references exist", () => {
    const keys = (refs: { designSpec: boolean; content: boolean }) =>
      Object.fromEntries(
        planScanSteps(["seo"], refs).map((s) => [s.stepKey, s.status ?? "pending"]),
      );
    expect(keys({ designSpec: true, content: false })).toMatchObject({
      design: "pending",
      content: "skipped",
    });
    expect(planScanSteps(["seo"]).find((s) => s.stepKey === "design")!.statusReason).toMatch(
      /unable to verify/,
    );
  });
});
