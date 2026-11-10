import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildDocx, buildPdf } from "../../../fixtures/documents/build.mjs";
import {
  extractContentBlocks,
  extractGuidelineDraft,
  extractMarkdown,
  extractPlainText,
  ExtractionError,
  fetchFigmaFile,
  FigmaError,
  normalizeFigma,
  parseCta,
} from "./index";
import { guidelineSegments } from "./guideline";

const figmaFile = JSON.parse(
  readFileSync(new URL("../../../fixtures/figma/design-file.json", import.meta.url), "utf8"),
);

const summary = (blocks: Array<{ type: string; text: string }>) =>
  blocks.map((b) => `${b.type}:${b.text}`);

describe("content extraction", () => {
  it("reads Markdown headings, paragraphs, lists, links, CTAs and page markers", () => {
    const { blocks } = extractMarkdown(
      [
        "# Welcome",
        "Intro paragraph with **bold** text.",
        "",
        "<!-- page: /about -->",
        "## About us",
        "- First point",
        "- Second point",
        "  - Nested point",
        "",
        "[Read the blog](/blog/)",
        "",
        "CTA: [Contact our team](/contact)",
        "",
        "Page: Products",
        "",
        "```",
        "code is skipped",
        "```",
        "Prices include VAT.",
      ].join("\n"),
    );
    expect(summary(blocks)).toEqual([
      "heading:Welcome",
      "paragraph:Intro paragraph with bold text.",
      "heading:About us",
      "list_item:First point",
      "list_item:Second point",
      "list_item:Nested point",
      "link:Read the blog",
      "cta:Contact our team",
      "paragraph:Prices include VAT.",
    ]);
    expect(blocks[0]).toMatchObject({ level: 1, pageHint: null, location: { line: 1 } });
    expect(blocks[2]).toMatchObject({ level: 2, pageHint: "/about" });
    expect(blocks[3]!.location.headingPath).toEqual(["About us"]);
    expect(blocks[6]).toMatchObject({ href: "/blog/" });
    expect(blocks[7]).toMatchObject({ href: "/contact", pageHint: "/about" });
    expect(blocks[8]).toMatchObject({
      pageHint: "Products",
      normalizedText: "prices include vat.",
    });
  });

  it("reads plain text paragraphs, headings, bullets, markers and arrow CTAs", () => {
    const { blocks } = extractPlainText(
      "About us\n\nWe sell demo products.\nThey are great.\nPage: Pricing\n- Cheap\n- Fast\n\nCTA: Buy now → /checkout\n",
    );
    expect(summary(blocks)).toEqual([
      "heading:About us",
      "paragraph:We sell demo products. They are great.",
      "list_item:Cheap",
      "list_item:Fast",
      "cta:Buy now",
    ]);
    expect(blocks[1]!.location.line).toBe(3);
    expect(blocks[2]!.pageHint).toBe("Pricing");
    expect(blocks[4]!.href).toBe("/checkout");
  });

  it("parses CTA lines with different href notations", () => {
    expect(parseCta("CTA: Get started (/signup)")).toEqual({
      text: "Get started",
      href: "/signup",
    });
    expect(parseCta("Button: Download -> https://x.test/app")).toEqual({
      text: "Download",
      href: "https://x.test/app",
    });
    expect(parseCta("Call to action: Subscribe")).toEqual({ text: "Subscribe", href: null });
    expect(parseCta("Just a sentence.")).toBeNull();
  });

  it("reads a real DOCX (headings, list items, hyperlinks, CTA)", async () => {
    const docx = buildDocx([
      { heading: "About us", level: 1 },
      { p: "We sell demo products." },
      { heading: "Our mission", level: 2 },
      { li: "Fast shipping" },
      { p: "CTA: ", link: "Contact our team", href: "/contact" },
      { p: "Page: Products" },
      { p: "Prices include VAT." },
    ]);
    const { blocks } = await extractContentBlocks("docx", docx);
    expect(summary(blocks)).toEqual([
      "heading:About us",
      "paragraph:We sell demo products.",
      "heading:Our mission",
      "list_item:Fast shipping",
      "cta:Contact our team",
      "paragraph:Prices include VAT.",
    ]);
    expect(blocks[2]).toMatchObject({ level: 2, location: { headingPath: ["About us"] } });
    expect(blocks[4]!.href).toBe("/contact");
    expect(blocks[5]!.pageHint).toBe("Products");
  });

  it("reads a real PDF and recovers headings from font sizes, with page numbers", async () => {
    const pdf = buildPdf([
      [
        { text: "About us", size: 24 },
        { text: "Page: About", size: 11, gap: 6 },
        { text: "We sell demo products and our team", size: 11 },
        { text: "ships every week.", size: 11 },
        { text: "Our mission", size: 16, gap: 10 },
        { text: "- Fast shipping", size: 11 },
      ],
      [
        { text: "Contact", size: 24 },
        { text: "We reply within one business day.", size: 11 },
      ],
    ]);
    const result = await extractContentBlocks("pdf", pdf);
    expect(result.meta.pages).toBe(2);
    expect(summary(result.blocks)).toEqual([
      "heading:About us",
      "paragraph:We sell demo products and our team ships every week.",
      "heading:Our mission",
      "list_item:Fast shipping",
      "heading:Contact",
      "paragraph:We reply within one business day.",
    ]);
    expect(result.blocks[0]!.level).toBe(1);
    expect(result.blocks[2]!.level).toBe(2);
    expect(result.blocks[1]!.pageHint).toBe("About");
    expect(result.blocks[5]!.location.page).toBe(2);
  });

  it("fails clearly for PDFs without text and for unreadable files", async () => {
    await expect(extractContentBlocks("pdf", buildPdf([[]]))).rejects.toThrow(
      /No text could be extracted/,
    );
    await expect(
      extractContentBlocks("pdf", Buffer.from("%PDF-1.4 broken")),
    ).rejects.toBeInstanceOf(ExtractionError);
    await expect(extractContentBlocks("md", Buffer.from("```\nonly code\n```"))).rejects.toThrow(
      /no text that could be compared/,
    );
  });
});

describe("Figma normalization", () => {
  const file = {
    name: figmaFile.name,
    lastModified: figmaFile.lastModified,
    version: figmaFile.version,
    roots: [figmaFile.document],
    styles: figmaFile.styles,
  };

  it("takes a text color only when every layer with the style uses the same fill (live finding)", () => {
    // Figma text styles carry no color; each text layer has its own fill. A real file used
    // "Body/Body-M" in mint on dark sections and black elsewhere (2026-10-10).
    const text = (id: string, rgb: [number, number, number]) => ({
      id,
      name: id,
      type: "TEXT",
      styles: { text: "S:body" },
      style: { fontFamily: "Inter", fontSize: 16, fontWeight: 400 },
      fills: [{ type: "SOLID", color: { r: rgb[0], g: rgb[1], b: rgb[2], a: 1 } }],
    });
    const styles = { "S:body": { key: "k", name: "Body/Regular", styleType: "TEXT" } };
    const doc = (children: unknown[]) => ({
      name: "f",
      lastModified: "",
      version: "1",
      roots: [{ id: "0:0", name: "Document", type: "DOCUMENT", children }],
      styles,
    });
    const mixed = normalizeFigma(
      doc([text("1:1", [0, 0.98, 0.76]), text("1:2", [0, 0, 0])]) as never,
      "AbCdEfGh1234",
    );
    expect(mixed.spec.typography.body).toMatchObject({ fontFamily: "Inter", fontSize: 16 });
    expect(mixed.spec.typography.body!.color).toBeUndefined();
    expect(mixed.report.skipped.join(" ")).toMatch(
      /Body\/Regular.*used with 2 different colors \(#00fac2, #000000\)/,
    );
    const same = normalizeFigma(
      doc([text("1:1", [0, 0, 0]), text("1:2", [0, 0, 0])]) as never,
      "AbCdEfGh1234",
    );
    expect(same.spec.typography.body).toMatchObject({ color: "#000000" });
  });

  it("skips an out-of-range value (a 9999px pill radius) instead of failing the whole read", () => {
    const button = {
      id: "2:1",
      name: "Variant=Primary",
      type: "COMPONENT",
      cornerRadius: 9999,
      paddingLeft: 24,
      paddingRight: 24,
      paddingTop: 16,
      paddingBottom: 16,
      fills: [{ type: "SOLID", color: { r: 0.318, g: 0.282, b: 0.792, a: 1 } }],
      children: [],
    };
    const { spec, report } = normalizeFigma(
      {
        name: "f",
        lastModified: "",
        version: "1",
        roots: [
          {
            id: "0:0",
            name: "Document",
            type: "DOCUMENT",
            children: [{ id: "2:0", name: "Button", type: "COMPONENT_SET", children: [button] }],
          },
        ],
        styles: {},
      } as never,
      "AbCdEfGh1234",
    );
    expect(spec.components.buttonPrimary).toMatchObject({ paddingX: 24, paddingY: 16 });
    expect(spec.components.buttonPrimary!.borderRadius).toBeUndefined();
    expect(report.skipped.join(" ")).toMatch(/buttonPrimary\.borderRadius = 9999: not used/);
  });

  it("reads “Body/CTA” as button text and skips XXS sizes, so the body comes from the body style", () => {
    // Style names as in Ascendion's design library: CTA and small sizes grouped under "Body/".
    const text = (id: string, styleId: string, fontSize: number, fontWeight: number) => ({
      id,
      name: id,
      type: "TEXT",
      characters: "Text",
      styles: { text: styleId },
      style: { fontFamily: "IBM Plex Sans", fontSize, fontWeight, lineHeightPx: 26 },
      fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 } }],
    });
    const { spec, report } = normalizeFigma(
      {
        name: "f",
        lastModified: "",
        version: "1",
        roots: [
          {
            id: "0:0",
            name: "Document",
            type: "DOCUMENT",
            children: [
              {
                id: "1:0",
                name: "Article",
                type: "FRAME",
                children: [
                  text("1:1", "S:cta", 18, 500),
                  text("1:2", "S:xxs", 16, 400),
                  text("1:3", "S:s", 18, 300),
                ],
              },
            ],
          },
        ],
        styles: {
          "S:cta": { name: "Body/CTA", styleType: "TEXT" },
          "S:xxs": { name: "Body/Body-XXS", styleType: "TEXT" },
          "S:s": { name: "Body/Body-S", styleType: "TEXT" },
        },
      } as never,
      "AbCdEfGh1234",
    );
    expect(spec.typography.button).toMatchObject({ fontSize: 18, fontWeight: 500 });
    expect(spec.typography.body).toMatchObject({ fontSize: 18, fontWeight: 300 });
    expect(spec.typography.body!.source).toMatchObject({ name: "Body/Body-S" });
    expect(report.skipped.join(" ")).toMatch(/Body\/Body-XXS”: no matching website role/);
  });

  it("maps text styles, color styles, button variants and the container frame", () => {
    const { spec, report } = normalizeFigma(file, "AbCdEfGh1234");
    expect(spec.typography.h1).toMatchObject({
      fontFamily: "Georgia",
      fontSize: 48,
      fontWeight: 700,
      lineHeight: 56,
      letterSpacing: 0,
      color: "#1a1a2e",
      source: { type: "figma", nodeId: "1:10", name: "Heading/H1", fileKey: "AbCdEfGh1234" },
    });
    // "Body/Regular" is preferred over "Body/Large" for body text.
    expect(spec.typography.body).toMatchObject({
      fontSize: 16,
      lineHeight: 24,
      source: { nodeId: "1:12" },
    });
    expect(spec.colors["Text/Primary"]).toMatchObject({ value: "#222222", role: "text" });
    expect(spec.colors["Link/Default"]).toMatchObject({ value: "#1a56db", role: "link" });
    expect(spec.colors["Header/Background"]).toMatchObject({
      value: "#e2e8f0",
      role: "headerBackground",
    });
    expect(spec.colors["Accent/Rose 50%"]).toBeUndefined(); // "%" is not allowed in token names
    expect(Object.values(spec.colors).some((c) => c.value === "#e11d4880")).toBe(true);
    expect(spec.colors.Hidden).toBeUndefined(); // invisible fills carry no value
    // Default state preferred over hover; asymmetric secondary padding is not used.
    expect(spec.components.buttonPrimary).toMatchObject({
      background: "#1a56db",
      color: "#ffffff",
      borderRadius: 8,
      paddingX: 24,
      paddingY: 12,
      fontSize: 16,
      fontWeight: 600,
      source: { nodeId: "2:3" },
    });
    expect(spec.components.buttonSecondary).toMatchObject({ background: "#ffffff", paddingY: 12 });
    expect(spec.components.buttonSecondary?.paddingX).toBeUndefined();
    expect(spec.layout.containerMaxWidth).toMatchObject({ value: 1200, source: { nodeId: "3:2" } });
    expect(report.skipped.join("\n")).toMatch(/Caption.*no matching website role/);
    expect(report.skipped.join("\n")).toMatch(/left and right padding differ/);
    expect(report.stats).toMatchObject({ textStyles: 5, components: 2 });
  });

  it("fetches through the REST API with the token header and maps HTTP errors", async () => {
    const calls: Array<{ url: string; token: string | null }> = [];
    const fake = (status: number, body: unknown) =>
      (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), token: new Headers(init?.headers).get("x-figma-token") });
        return new Response(JSON.stringify(body), { status });
      }) as typeof fetch;
    const data = await fetchFigmaFile({
      fileKey: "AbCdEfGh1234",
      nodeIds: [],
      token: "figd_test",
      baseUrl: "http://figma.mock",
      fetchImpl: fake(200, figmaFile),
    });
    expect(calls[0]).toEqual({
      url: "http://figma.mock/v1/files/AbCdEfGh1234",
      token: "figd_test",
    });
    expect(data.roots).toHaveLength(1);
    expect(data.version).toBe("4242");

    await fetchFigmaFile({
      fileKey: "AbCdEfGh1234",
      nodeIds: ["3:1"],
      token: "t",
      baseUrl: "http://figma.mock",
      fetchImpl: fake(200, {
        name: "x",
        nodes: { "3:1": { document: figmaFile.document.children[2], styles: {} } },
      }),
    });
    expect(calls[1]!.url).toBe("http://figma.mock/v1/files/AbCdEfGh1234/nodes?ids=3%3A1");

    for (const [status, code] of [
      [403, "UNAUTHORIZED"],
      [404, "NOT_FOUND"],
      [429, "RATE_LIMITED"],
      [500, "SERVER_ERROR"],
    ] as const) {
      const err = await fetchFigmaFile({
        fileKey: "AbCdEfGh1234",
        nodeIds: [],
        token: "t",
        fetchImpl: fake(status, {}),
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FigmaError);
      expect((err as FigmaError).code).toBe(code);
    }
    const big = await fetchFigmaFile({
      fileKey: "AbCdEfGh1234",
      nodeIds: [],
      token: "t",
      maxBytes: 100,
      fetchImpl: fake(200, figmaFile),
    }).catch((e: unknown) => e);
    expect((big as FigmaError).code).toBe("TOO_LARGE");
  });
});

describe("brand guideline extraction", () => {
  it("reads only literal values, each with a citation", () => {
    const { blocks } = extractPlainText(
      [
        "Brand colors",
        "",
        "Primary Blue — HEX #1A56DB",
        "",
        "Text color: #222",
        "",
        "Header background: rgb(226, 232, 240)",
        "",
        "Primary font: Inter",
        "",
        "H1 — Georgia Bold, 48px / 56px",
        "",
        "Body text: Regular 16px, line height 24px",
        "",
        "Links: #1A56DB",
        "",
        "Our tone of voice is friendly.",
      ].join("\n"),
    );
    const { spec, report } = extractGuidelineDraft(blocks, {
      referenceId: "ref-1",
      filename: "brand.txt",
    });
    expect(spec.colors["Primary Blue"]).toMatchObject({
      value: "#1a56db",
      source: {
        type: "document",
        filename: "brand.txt",
        line: 3,
        excerpt: "Primary Blue - HEX #1A56DB",
      },
    });
    expect(spec.colors["Text"]).toMatchObject({ value: "#222222", role: "text" });
    expect(spec.colors["Header background"]).toMatchObject({
      value: "#e2e8f0",
      role: "headerBackground",
    });
    expect(spec.typography.h1).toMatchObject({
      fontFamily: "Georgia",
      fontSize: 48,
      lineHeight: 56,
      fontWeight: 700,
    });
    expect(spec.typography.body).toMatchObject({
      fontFamily: "Inter",
      fontSize: 16,
      lineHeight: 24,
      fontWeight: 400,
    });
    expect(spec.typography.body!.source.excerpt).toMatch(/Body text.*\|.*Primary font: Inter/);
    expect(spec.typography.link).toMatchObject({ color: "#1a56db" });
    expect(spec.typography.h2).toBeUndefined(); // nothing is invented for roles the document omits
    expect(report.extracted.length).toBeGreaterThan(5);
  });

  it("reads value lines written without blank lines between them (one paragraph block)", () => {
    const text = [
      "Typography",
      "Primary font: Inter",
      "H1 — Georgia Bold, 48px / 56px",
      "H2 — Georgia Semibold, 32px",
      "Body text: Regular 16px, line height 24px",
      "Body copy should stay friendly and short.",
    ].join("\n");
    for (const { blocks } of [extractPlainText(text), extractMarkdown(text)]) {
      expect(blocks).toHaveLength(1); // the lines really are one block
      const { spec, report } = extractGuidelineDraft(blocks, {
        referenceId: "ref-1",
        filename: "brand.md",
      });
      expect(spec.typography.h1).toMatchObject({
        fontFamily: "Georgia",
        fontSize: 48,
        lineHeight: 56,
        fontWeight: 700,
        source: { excerpt: "H1 - Georgia Bold, 48px / 56px" },
      });
      expect(spec.typography.h2).toMatchObject({ fontSize: 32, fontWeight: 600 });
      expect(spec.typography.body).toMatchObject({
        fontFamily: "Inter",
        fontSize: 16,
        lineHeight: 24,
      });
      expect(report.extracted).toHaveLength(4);
    }
    // Prose that merely mentions a role word is not split off as a value line.
    expect(guidelineSegments("Use body copy for links and buttons in the footer.")).toHaveLength(1);
  });
});
