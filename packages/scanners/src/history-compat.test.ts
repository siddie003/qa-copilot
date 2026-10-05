import { readFileSync } from "node:fs";
import { PAGE_LEVEL_GAP_CHECKS, pageKey, SCANNER_WIDE_GAP_CHECKS } from "@qa/core";
import { normalizeUrl } from "@qa/crawler";
import { describe, expect, it } from "vitest";

/**
 * The scan comparison (`@qa/core/comparison`) relies on check labels the scanners write into
 * their inconclusive checks, and on the crawler's URL normalization. Keep them in step.
 */
const source = (name: string) => readFileSync(new URL(`./${name}.ts`, import.meta.url), "utf8");
const ALL = ["accessibility", "security", "seo", "links", "performance", "responsive"]
  .map(source)
  .join("\n");

describe("scan comparison ↔ scanners", () => {
  it("page-level gap checks are labels the scanners actually write", () => {
    for (const check of PAGE_LEVEL_GAP_CHECKS) expect(ALL).toContain(`check: "${check}"`);
  });

  it("scanner-wide gap checks are written by that scanner with a site-wide page", () => {
    for (const [scanner, checks] of Object.entries(SCANNER_WIDE_GAP_CHECKS))
      for (const check of checks) expect(source(scanner)).toContain(`check: "${check}"`);
  });

  it("page keys match the crawler's normalized path and query", () => {
    for (const url of [
      "https://a.example/about?utm_source=news&z=1&a=2#x",
      "http://a.example:80/products/widget",
      "https://a.example/blog/?gclid=1",
      "https://a.example/search?q=a%20b&q=c",
    ]) {
      const n = new URL(normalizeUrl(url)!);
      expect(pageKey(url)).toBe(`${n.pathname}${n.search}`);
    }
  });
});
