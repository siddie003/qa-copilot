import { describe, expect, it } from "vitest";
import {
  buildCorpus,
  extractFacts,
  normalizeFact,
  numberSupported,
  unsupportedFacts,
} from "./values";

describe("extractFacts", () => {
  it("reads numbers with units, thousands separators and signs", () => {
    const f = extractFacts("LCP 4,232 ms, gap -0.5px, 83% of 40px. Ends at 12px.");
    expect(f.numbers.map((n) => [n.raw, n.value])).toEqual([
      ["4,232 ms", 4232],
      ["-0.5px", -0.5],
      ["83%", 83],
      ["40px", 40],
      ["12px", 12],
    ]);
  });

  it("does not read numbers inside words, ids, versions, paths or sizes", () => {
    const f = extractFacts("h1 and h2, axe 4.13.0, A11Y-004, /blog/post-2, 1440x900, wcag2aa, 2nd");
    expect(f.numbers).toEqual([]);
    expect(f.findingIds).toEqual(["A11Y-004"]);
    expect(f.paths).toEqual(["/blog/post-2"]);
  });

  it("normalizes colors written as hex or rgb()", () => {
    const f = extractFacts("Use #1A56DB (not #fff, rgb(6, 69, 173) or rgba(0,0,0,0.5)).");
    expect(f.colors.map((c) => c.hex)).toEqual(["#0645ad", "#00000080", "#1a56db", "#ffffff"]);
    expect(f.numbers).toEqual([]);
  });

  it("reads URLs without trailing punctuation and keeps their digits out of numbers", () => {
    const f = extractFacts("See https://example.com/a/404, then http://localhost:4100/x.");
    expect(f.urls.map((u) => u.raw)).toEqual([
      "https://example.com/a/404",
      "http://localhost:4100/x",
    ]);
    expect(f.numbers).toEqual([]);
  });

  it("reads quoted text but not code spans or apostrophes", () => {
    const f = extractFacts(
      "The title “Acme Widgets” and 'Our Mission' — the page's text, `\"not quoted\"`.",
    );
    expect(f.quotes.map((q) => q.normalized)).toEqual(["acme widgets", "our mission"]);
  });

  it("only treats known scanner prefixes as finding ids", () => {
    expect(extractFacts("ISO-8601, RFC-9309, SEC-012, CNT-100").findingIds).toEqual([
      "SEC-012",
      "CNT-100",
    ]);
  });
});

describe("grounding values against a corpus", () => {
  const corpus = buildCorpus(
    [
      {
        values: { mobile: 4231.6 },
        ratio: "Expected contrast ratio of 4.5:1",
        colors: "foreground color: #c4c4c4, background rgb(255, 255, 255)",
        page: "http://localhost:4100/products",
        text: "Free shipping on all orders",
      },
    ],
    ["A11Y-001"],
  );

  it("accepts values from the evidence, rounded values and normalized forms", () => {
    const text =
      "LCP was 4,232 ms (4231.6 measured), ratio 4.5, color #C4C4C4 on #fff, see http://localhost:4100/products/ and /products: “free  shipping” (A11Y-001).";
    expect(unsupportedFacts(text, corpus)).toEqual([]);
  });

  it("rejects fabricated numbers, colors, URLs, paths, quotes and finding ids", () => {
    const text =
      "LCP was 9000 ms; use #123456; see https://evil.example/fix and /admin; “Buy now”; SEO-999.";
    expect(unsupportedFacts(text, corpus).sort()).toEqual(
      ["9000 ms", "#123456", "https://evil.example/fix", "/admin", "“Buy now”", "SEO-999"].sort(),
    );
  });

  it("does not round small values to integers (a rounded claim cannot change a threshold)", () => {
    const tok = (raw: string) => extractFacts(raw).numbers[0]!;
    expect(numberSupported(tok("4.5"), corpus)).toBe(true);
    expect(numberSupported(tok("5"), corpus)).toBe(false);
    expect(numberSupported(tok("4232"), corpus)).toBe(true);
    expect(numberSupported(tok("4231.6"), corpus)).toBe(true);
    expect(numberSupported(tok("4230"), corpus)).toBe(false);
  });

  it("normalizes typography in facts", () => {
    expect(normalizeFact("  “Our  Mission” – Today… ")).toBe('our mission" - today');
  });
});
