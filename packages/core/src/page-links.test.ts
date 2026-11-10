import { describe, expect, it } from "vitest";
import { defaultScanDefaults, SCANNER_KEYS } from "./domain";
import { checkPageLink, pageLinkKey } from "./page-links";
import { planScanSteps } from "./pipeline";

const site = "https://www.example.com/";

describe("checkPageLink", () => {
  it("accepts full URLs and paths of the same site (www and bare domain count as one site)", () => {
    expect(checkPageLink("https://www.example.com/about", site)).toEqual({
      ok: true,
      url: "https://www.example.com/about",
      path: "/about",
    });
    expect(checkPageLink("/services?tab=2#top", site)).toEqual({
      ok: true,
      url: "https://www.example.com/services?tab=2",
      path: "/services?tab=2",
    });
    expect(checkPageLink("example.com/contact", site)).toMatchObject({
      ok: true,
      url: "https://example.com/contact",
      path: "/contact",
    });
    // A path keeps the website's scheme (plain-http fixture sites).
    expect(checkPageLink("/about", "http://localhost:4100/")).toMatchObject({
      ok: true,
      url: "http://localhost:4100/about",
    });
  });

  it("rejects other websites, other ports, Figma links, files, credentials and other schemes", () => {
    expect(checkPageLink("https://other.org/about", site)).toMatchObject({
      ok: false,
      message: expect.stringContaining("different website (other.org)"),
    });
    expect(checkPageLink("http://localhost:4200/a", "http://localhost:4100/")).toMatchObject({
      ok: false,
    });
    expect(checkPageLink("https://www.figma.com/design/abc/x", site)).toMatchObject({
      ok: false,
      message: expect.stringContaining("Figma link"),
    });
    expect(checkPageLink("/brochure.pdf", site)).toMatchObject({
      ok: false,
      message: "This links to a file, not a web page.",
    });
    expect(checkPageLink("https://user:pw@www.example.com/a", site)).toMatchObject({ ok: false });
    expect(checkPageLink("ftp://www.example.com/a", site)).toMatchObject({ ok: false });
    expect(checkPageLink("   ", site)).toMatchObject({ ok: false });
    expect(checkPageLink("http://[bad", site)).toMatchObject({ ok: false });
  });

  it("treats trailing slashes, www and query order as the same page for duplicates", () => {
    expect(pageLinkKey("https://www.example.com/about/")).toBe(
      pageLinkKey("https://example.com/about"),
    );
    expect(pageLinkKey("https://example.com/p?b=2&a=1")).toBe(
      pageLinkKey("https://example.com/p?a=1&b=2"),
    );
    expect(pageLinkKey("https://example.com/About")).not.toBe(
      pageLinkKey("https://example.com/about"),
    );
  });
});

describe("Design Quality & Typography in the scan plan", () => {
  it("is a selectable scanner, enabled by default for new projects", () => {
    expect(SCANNER_KEYS).toContain("design_quality");
    expect(defaultScanDefaults().scanners).toContain("design_quality");
  });

  it("runs after the reference comparisons and before AI and grounding", () => {
    const keys = planScanSteps(["seo", "design_quality"], { designSpec: true, content: false }).map(
      (s) => `${s.stepKey}${s.status === "skipped" ? " (skipped)" : ""}`,
    );
    expect(keys).toEqual([
      "preflight",
      "crawl",
      "capture",
      "seo",
      "design",
      "content (skipped)",
      "design_quality",
      "ai",
      "grounding",
    ]);
    expect(planScanSteps(["seo"]).map((s) => s.stepKey)).not.toContain("design_quality");
  });
});
