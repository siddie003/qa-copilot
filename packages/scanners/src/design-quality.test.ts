// Test data: the measurements below are hand-written fixtures in the shape DESIGN_QUALITY_SCRIPT
// returns; they are not taken from a real website.
import { designSpecSchema, type DesignSpec } from "@qa/core";
import { describe, expect, it } from "vitest";
import {
  aspectDistortion,
  designQualityScanner,
  displayScale,
  type QualityData,
} from "./design-quality";
import {
  findingDraftSchema,
  type CaptureRecord,
  type PageRecord,
  type ScannerContext,
  type StepResultRecord,
} from "./types";

const box = { x: 10, y: 10, width: 300, height: 40 };
const typo = (over: Record<string, unknown> = {}) => ({
  fontFamily: "Inter, sans-serif",
  fontSize: 32,
  fontWeight: "700",
  fontStyle: "normal",
  lineHeight: 40,
  letterSpacing: "normal",
  textTransform: "none",
  textAlign: "start",
  color: "rgb(0, 0, 0)",
  ...over,
});
let n = 0;
const heading = (level: number, over: Record<string, unknown> = {}) => ({
  index: n++,
  level,
  selector: `main > h${level}:nth-of-type(${n})`,
  text: `Heading ${n}`,
  inChrome: false,
  box,
  ...typo({ fontSize: { 1: 48, 2: 32, 3: 24, 4: 20, 5: 18, 6: 16 }[level], ...over }),
});
const paragraph = (over: Record<string, unknown> = {}) => ({
  index: n++,
  selector: `main > p:nth-of-type(${n})`,
  text: "Body text of the page with enough words.",
  box,
  ...typo({ fontSize: 16, fontWeight: "400", ...over }),
});
const image = (over: Record<string, unknown> = {}) => ({
  src: "https://example.com/img/photo.jpg",
  selector: "main > img",
  naturalWidth: 800,
  naturalHeight: 600,
  renderedWidth: 400,
  renderedHeight: 300,
  objectFit: "fill",
  visible: true,
  complete: true,
  broken: false,
  isSvg: false,
  box,
  ...over,
});

function quality(over: Partial<QualityData> = {}): QualityData {
  return {
    viewportWidth: 1440,
    headingsTotal: 3,
    headings: [heading(1), heading(2), heading(2)],
    paragraphs: [paragraph()],
    fonts: [{ family: "Inter", status: "loaded", weight: "400", style: "normal" }],
    images: [image()],
    alignment: [],
    gaps: [],
    spacing: [],
    rendered: { samples: [], error: null },
    ...over,
  } as QualityData;
}

function capture(q: QualityData | null, viewport = "desktop", width = 1440): CaptureRecord {
  return {
    pageId: "p1",
    viewport,
    width,
    height: 900,
    screenshotKey: `scans/s/pages/p1/${viewport}.png`,
    error: null,
    timings: {},
    metrics: null,
    consoleMessages: [],
    requests: [],
    loadDom: async () => null,
    loadDesignStyles: async () => null,
    loadTextContent: async () => null,
    loadQuality: async () => q as unknown as Record<string, unknown> | null,
  };
}

function page(id: string, captures: CaptureRecord[], path = `/${id}`): PageRecord {
  return {
    id,
    url: `https://example.com${path}`,
    finalUrl: null,
    httpStatus: 200,
    depth: 1,
    title: null,
    contentType: "text/html",
    crawlError: null,
    redirectChain: null,
    responseHeaders: {},
    loadRawHtml: async () => null,
    captures: captures.map((c) => ({ ...c, pageId: id })),
  };
}

function ctx(
  pages: PageRecord[],
  over: Partial<ScannerContext> & { steps?: Record<string, StepResultRecord | null> } = {},
): ScannerContext {
  const { steps = {}, ...rest } = over;
  return {
    scanId: "s",
    siteUrl: "https://example.com/",
    viewports: [
      { name: "desktop", width: 1440, height: 900 },
      { name: "mobile", width: 390, height: 844 },
    ],
    pages,
    robots: null,
    fetch: {} as ScannerContext["fetch"],
    signal: new AbortController().signal,
    openPage: async () => {
      throw new Error("not used");
    },
    pageTimeoutMs: 1000,
    log: () => {},
    references: { designSpec: null, content: null },
    approvedFonts: [],
    stepResult: async (key) => steps[key] ?? null,
    ...rest,
  };
}

const rules = (r: Awaited<ReturnType<typeof designQualityScanner.run>>) =>
  r.findings.map((f) => f.ruleId).sort();
const part = (r: Awaited<ReturnType<typeof designQualityScanner.run>>, key: string) =>
  r.checks.parts!.find((p) => p.key === key)!;

describe("Design Quality & Typography scanner", () => {
  it("passes a consistent page without findings and reports what was not configured", async () => {
    const r = await designQualityScanner.run(ctx([page("home", [capture(quality())])]));
    expect(r.status).toBe("completed");
    expect(r.findings).toEqual([]);
    expect(part(r, "headings").status).toBe("completed");
    expect(part(r, "reference")).toMatchObject({ status: "not_configured" });
    expect(part(r, "content")).toMatchObject({
      status: "not_configured",
      detail: expect.stringContaining("no processed approved content document"),
    });
    // No expected size is invented: levels without a reference are "unable to verify".
    const h1 = r.checks.comparison!.items.find((i) => i.key === "reference.h1")!;
    expect(h1).toMatchObject({ verdict: "unable_to_verify", expected: null });
    expect(h1.actual).toBe("48px (desktop)");
  });

  it("reports the same heading level in different styles, with every measured value", async () => {
    const q = quality({
      headings: [
        heading(1),
        heading(2),
        heading(2),
        heading(2, { fontSize: 24, fontWeight: "400" }),
      ],
    });
    const r = await designQualityScanner.run(ctx([page("home", [capture(q)])]));
    const f = r.findings.find((x) => x.ruleId === "dq-heading-inconsistent")!;
    expect(f).toMatchObject({
      verdict: "potential",
      severity: "low",
      fingerprintKey: "heading-inconsistent:h2",
    });
    expect(f.actual).toContain("32px, weight 700");
    expect(f.actual).toContain("24px, weight 400");
    expect(f.expected).toContain("most common at desktop: 32px, weight 700");
    expect(findingDraftSchema.safeParse(f).success).toBe(true);
  });

  it("does not compare headings across screen sizes or inside site chrome", async () => {
    const desktop = quality({ headings: [heading(1), heading(2)] });
    const mobile = quality({
      headings: [
        heading(1, { fontSize: 32 }),
        heading(2, { fontSize: 24 }),
        heading(2, { fontSize: 18, inChrome: true }),
      ],
    });
    const r = await designQualityScanner.run(
      ctx([page("home", [capture(desktop), capture(mobile, "mobile", 390)])]),
    );
    expect(rules(r)).not.toContain("dq-heading-inconsistent");
    expect(r.checks.notes!.join(" ")).toContain("header, navigation or footer");
  });

  it("reports a lower-level heading drawn larger than a higher-level one", async () => {
    const q = quality({ headings: [heading(1), heading(2), heading(3, { fontSize: 36 })] });
    const r = await designQualityScanner.run(ctx([page("home", [capture(q)])]));
    const f = r.findings.find((x) => x.ruleId === "dq-heading-hierarchy-inverted")!;
    expect(f.title).toBe("H3 headings are larger than H2 headings");
    expect(f.actual).toBe("H2 32px, H3 36px (desktop)");
    expect(f.message).toContain("accessibility scanner");
  });

  it("copies heading comparisons from the design comparison instead of duplicating findings", async () => {
    const spec: DesignSpec = designSpecSchema.parse({
      typography: {
        h1: { fontSize: 48, source: { type: "document", filename: "brand.pdf", page: 3 } },
      },
    });
    const design: StepResultRecord = {
      status: "completed",
      statusReason: "ok",
      error: null,
      findingCount: 1,
      checks: {
        comparison: {
          items: [
            {
              key: "typography.h1.fontSize",
              label: "Heading 1 font size",
              verdict: "confirmed_mismatch",
              expected: "48px",
              actual: "32px",
              reference: "brand.pdf, page 3",
              detail: "1 of 1 page(s)",
            },
          ],
        },
      },
    };
    const q = quality({ headings: [heading(1, { fontSize: 32 }), heading(2)] });
    const r = await designQualityScanner.run(
      ctx([page("home", [capture(q)])], {
        references: { designSpec: { id: "d", version: 2, spec }, content: null },
        steps: { design },
      }),
    );
    expect(part(r, "reference").status).toBe("completed");
    const item = r.checks.comparison!.items.find(
      (i) => i.key === "reference.typography.h1.fontSize",
    )!;
    expect(item).toMatchObject({ verdict: "confirmed_mismatch", expected: "48px", actual: "32px" });
    expect(item.detail).toContain("listed under Design comparison");
    // H2 has no reference value: inconclusive, not a defect.
    expect(r.checks.comparison!.items.find((i) => i.key === "reference.h2")!.verdict).toBe(
      "unable_to_verify",
    );
    expect(r.findings).toEqual([]);
  });

  it("reports the reference part as not available when the design comparison failed", async () => {
    const spec = designSpecSchema.parse({ typography: { h2: { fontSize: 30 } } });
    const r = await designQualityScanner.run(
      ctx([page("home", [capture(quality())])], {
        references: { designSpec: { id: "d", version: 1, spec }, content: null },
        steps: {
          design: {
            status: "failed",
            statusReason: null,
            error: "Step timed out",
            findingCount: 0,
            checks: null,
          },
        },
      }),
    );
    expect(part(r, "reference")).toMatchObject({ status: "unavailable" });
    expect(r.status).toBe("inconclusive");
    expect(r.statusReason).toContain("Partially completed");
    expect(r.statusReason).toContain("Step timed out");
  });

  it("confirms a declared web font that the font engine did not render", async () => {
    const q = quality({
      paragraphs: [paragraph({ fontFamily: '"Brand Sans", Georgia, serif' })],
      fonts: [{ family: "Brand Sans", status: "error", weight: "400", style: "normal" }],
      rendered: {
        error: null,
        samples: [
          {
            kind: "paragraph",
            index: 0,
            declared: '"Brand Sans", Georgia, serif',
            fonts: [
              {
                familyName: "Georgia",
                postScriptName: "Georgia",
                isCustomFont: false,
                glyphCount: 40,
              },
            ],
            error: null,
          },
        ],
      },
    });
    q.rendered!.samples[0]!.index = q.paragraphs[0]!.index;
    const r = await designQualityScanner.run(ctx([page("home", [capture(q)])]));
    const f = r.findings.find((x) => x.ruleId === "dq-webfont-not-rendered")!;
    expect(f).toMatchObject({
      verdict: "confirmed",
      severity: "medium",
      fingerprintKey: "webfont:brand sans",
    });
    expect(f.actual).toContain("Georgia (installed font)");
    expect(f.message).toContain("400 normal: error");
  });

  it("accepts a web font whose file names its family with a style or width suffix", async () => {
    // Ascendion: CSS "PP Neue Machina" is drawn with the web font "PP Neue Machina Plain", and
    // "IBM Plex Sans" (variable font) with "IBM Plex Sans SemiCondensed": the declared fonts.
    const q = quality({
      paragraphs: [
        paragraph({ fontFamily: '"PP Neue Machina", sans-serif' }),
        paragraph({ fontFamily: '"IBM Plex Sans", sans-serif' }),
      ],
      fonts: [
        { family: "PP Neue Machina", status: "loaded", weight: "400", style: "normal" },
        { family: "IBM Plex Sans", status: "loaded", weight: "400", style: "normal" },
      ],
      rendered: {
        error: null,
        samples: [
          ["PP Neue Machina", "PP Neue Machina Plain", "PPNeueMachina-PlainRegular"],
          ["IBM Plex Sans", "IBM Plex Sans SemiCondensed", "IBMPlexSansSemiCondensed-Bold"],
        ].map(([declared, familyName, postScriptName], index) => ({
          kind: "paragraph" as const,
          index,
          declared: `"${declared}", sans-serif`,
          fonts: [
            {
              familyName: familyName!,
              postScriptName: postScriptName!,
              isCustomFont: true,
              glyphCount: 20,
            },
          ],
          error: null,
        })),
      },
    });
    q.paragraphs.forEach((p, i) => (q.rendered!.samples[i]!.index = p.index));
    const r = await designQualityScanner.run(ctx([page("home", [capture(q)])]));
    expect(rules(r)).not.toContain("dq-webfont-not-rendered");
  });

  it("does not blame the site when a non-web font is missing on the scan machine", async () => {
    const q = quality({
      paragraphs: [paragraph({ fontFamily: "Helvetica, Arial, sans-serif" })],
      fonts: [],
      rendered: {
        error: null,
        samples: [
          {
            kind: "paragraph",
            index: 0,
            declared: "Helvetica, Arial, sans-serif",
            fonts: [
              {
                familyName: "Arial",
                postScriptName: "ArialMT",
                isCustomFont: false,
                glyphCount: 30,
              },
            ],
            error: null,
          },
        ],
      },
    });
    const r = await designQualityScanner.run(ctx([page("home", [capture(q)])]));
    expect(rules(r)).not.toContain("dq-webfont-not-rendered");
    expect(r.checks.inconclusive.map((i) => i.reason).join(" ")).toContain("cannot be verified");
  });

  it("compares text fonts with the uploaded brand fonts and reports their rendering", async () => {
    const q = quality({
      headings: [heading(1), heading(2, { fontFamily: "Roboto, sans-serif" })],
      rendered: {
        error: null,
        samples: [
          {
            kind: "heading",
            index: 0,
            declared: "Inter, sans-serif",
            fonts: [
              {
                familyName: "Inter",
                postScriptName: "Inter-Bold",
                isCustomFont: true,
                glyphCount: 12,
              },
            ],
            error: null,
          },
        ],
      },
    });
    const r = await designQualityScanner.run(
      ctx([page("home", [capture(q)])], {
        approvedFonts: [
          {
            id: "f1",
            filename: "Inter.woff2",
            families: ["Inter", "Inter Bold"],
            weight: 700,
            italic: false,
          },
          {
            id: "f2",
            filename: "Serif.ttf",
            families: ["Brand Serif"],
            weight: 400,
            italic: false,
          },
        ],
      }),
    );
    const f = r.findings.find((x) => x.ruleId === "dq-font-not-approved")!;
    expect(f).toMatchObject({ verdict: "potential", fingerprintKey: "font-not-approved:roboto" });
    expect(f.actual).toContain("H2 headings");
    const items = r.checks.comparison!.items;
    expect(items.find((i) => i.key === "font.f1")).toMatchObject({ verdict: "match" });
    expect(items.find((i) => i.key === "font.f2")).toMatchObject({
      verdict: "unable_to_verify",
      actual: "Not used by the measured headings or body text",
    });
  });

  it("measures enlarged and stretched images; skips SVG, tiny and broken images", async () => {
    expect(
      displayScale({
        naturalWidth: 100,
        naturalHeight: 100,
        renderedWidth: 200,
        renderedHeight: 100,
        objectFit: "contain",
      }),
    ).toBe(1);
    expect(
      displayScale({
        naturalWidth: 100,
        naturalHeight: 100,
        renderedWidth: 200,
        renderedHeight: 100,
        objectFit: "cover",
      }),
    ).toBe(2);
    expect(
      aspectDistortion({
        naturalWidth: 300,
        naturalHeight: 100,
        renderedWidth: 200,
        renderedHeight: 100,
        objectFit: "cover",
      }),
    ).toBe(0);
    const q = quality({
      images: [
        image({
          src: "https://example.com/team.png",
          naturalWidth: 40,
          naturalHeight: 40,
          renderedWidth: 160,
          renderedHeight: 160,
        }),
        image({
          src: "https://example.com/soft.png",
          naturalWidth: 400,
          naturalHeight: 300,
          renderedWidth: 500,
          renderedHeight: 375,
        }),
        image({
          src: "https://example.com/hero.png",
          naturalWidth: 600,
          naturalHeight: 200,
          renderedWidth: 400,
          renderedHeight: 200,
        }),
        image({
          src: "https://example.com/logo.svg",
          isSvg: true,
          naturalWidth: 10,
          naturalHeight: 10,
        }),
        image({
          src: "https://example.com/icon.png",
          naturalWidth: 8,
          naturalHeight: 8,
          renderedWidth: 24,
          renderedHeight: 24,
        }),
        image({
          src: "https://example.com/broken.png",
          broken: true,
          naturalWidth: 0,
          naturalHeight: 0,
        }),
      ],
    });
    const r = await designQualityScanner.run(ctx([page("home", [capture(q)])]));
    const up = r.findings.filter((f) => f.ruleId === "dq-image-upscaled");
    expect(up.map((f) => [f.fingerprintKey, f.verdict, f.severity])).toEqual([
      ["upscaled:https://example.com/team.png", "confirmed", "medium"],
      ["upscaled:https://example.com/soft.png", "potential", "low"],
    ]);
    const stretched = r.findings.find((f) => f.ruleId === "dq-image-distorted")!;
    expect(stretched).toMatchObject({
      verdict: "confirmed",
      fingerprintKey: "distorted:https://example.com/hero.png",
    });
    expect(stretched.title).toContain("33%");
    expect(r.checks.notes!.join(" ")).toContain(
      "reported by the Responsive / visual and Broken links scanners",
    );
    expect(r.checks.notes!.join(" ")).toContain("Blur, compression artifacts");
  });

  it("checks spacing against an explicit scale only, and reports near-miss alignment and uneven gaps", async () => {
    const q = quality({
      spacing: [
        { property: "margin-bottom", value: 16, count: 20, sample: "main > p" },
        { property: "margin-top", value: 13, count: 4, sample: "main > div.card" },
      ],
      alignment: [
        {
          parent: "main > div.stack",
          a: { selector: "main > div.stack > div.a", left: 16, box },
          b: { selector: "main > div.stack > div.b", left: 19, box },
          offsetPx: 3,
        },
      ],
      gaps: [
        {
          parent: "main > div.cards",
          axis: "vertical",
          item: "div.card",
          gaps: [16, 28, 16],
          items: [{ selector: "main > div.cards > div:nth-of-type(1)", box }],
        },
      ],
    });
    const noScale = await designQualityScanner.run(ctx([page("home", [capture(q)])]));
    expect(rules(noScale)).toEqual(["dq-alignment-near-miss", "dq-spacing-inconsistent"]);
    expect(part(noScale, "layout").detail).toContain("No spacing scale");
    expect(noScale.checks.inconclusive.map((i) => i.check)).toContain(
      "Spacing and alignment against design frames",
    );
    const spec = designSpecSchema.parse({ spacing: { scale: { values: [4, 8, 16, 24, 32] } } });
    const withScale = await designQualityScanner.run(
      ctx([page("home", [capture(q)])], {
        references: { designSpec: { id: "d", version: 1, spec }, content: null },
      }),
    );
    const off = withScale.findings.find((f) => f.ruleId === "dq-spacing-off-scale")!;
    expect(off).toMatchObject({ verdict: "potential", actual: "13px" });
    expect(off.message).toContain("4 of 24 measured");
    const gap = noScale.findings.find((f) => f.ruleId === "dq-spacing-inconsistent")!;
    expect(gap.expected).toBe("Equal gaps (most common: 16px)");
  });

  it("reports approved-content verification from the content comparison, or why it could not run", async () => {
    const content = {
      documents: [{ id: "doc", filename: "copy.md", targetPath: "/", blocks: [] }],
      missing: [],
    };
    const done = await designQualityScanner.run(
      ctx([page("home", [capture(quality())])], {
        references: { designSpec: null, content },
        steps: {
          content: {
            status: "completed",
            statusReason: "ok",
            error: null,
            findingCount: 2,
            checks: {
              comparison: {
                matched: 5,
                confirmedMismatch: 1,
                potentialMismatch: 1,
                unableToVerify: 0,
                items: [],
              },
            },
          },
        },
      }),
    );
    expect(part(done, "content")).toMatchObject({ status: "completed" });
    expect(part(done, "content").detail).toContain("5 matched, 1 confirmed mismatch");
    expect(done.status).toBe("completed");

    const failed = await designQualityScanner.run(
      ctx([page("home", [capture(quality())])], {
        references: { designSpec: null, content },
        steps: {
          content: {
            status: "failed",
            statusReason: null,
            error: "boom",
            findingCount: 0,
            checks: null,
          },
        },
      }),
    );
    expect(part(failed, "content")).toMatchObject({ status: "failed" });
    expect(failed.status).toBe("inconclusive");
    expect(failed.statusReason).toMatch(/Completed: Heading typography/);
  });

  it("is inconclusive (not successful) when no capture has measurements", async () => {
    const r = await designQualityScanner.run(ctx([page("home", [capture(null)])]));
    expect(r.status).toBe("inconclusive");
    expect(r.findings).toEqual([]);
  });

  it("produces only findings that pass the finding schema", async () => {
    const q = quality({
      headings: [
        heading(1),
        heading(2),
        heading(2, { fontSize: 20 }),
        heading(3, { fontSize: 40 }),
      ],
      images: [
        image({ naturalWidth: 100, naturalHeight: 100, renderedWidth: 300, renderedHeight: 200 }),
      ],
    });
    const r = await designQualityScanner.run(
      ctx([page("a", [capture(q)]), page("b", [capture(q)], "/b")]),
    );
    expect(r.findings.length).toBeGreaterThan(2);
    for (const f of r.findings)
      expect(findingDraftSchema.safeParse(f).success, f.ruleId).toBe(true);
  });
});
