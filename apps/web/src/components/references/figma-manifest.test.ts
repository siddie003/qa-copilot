import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FigmaManifestSummary } from "./figma-manifest";

const manifest = (over: Record<string, unknown> = {}) => ({
  version: "100",
  mode: "pages",
  pagesDiscovered: 45,
  pages: [
    ...Array.from({ length: 20 }, (_, i) => ({
      id: `0:${i + 1}`,
      name: `Page ${i + 1}`,
      status: "done",
      framesTotal: 3,
      nodes: 10,
    })),
    { id: "0:21", name: "Huge page", status: "failed", error: "This page is larger than 50 MB" },
    ...Array.from({ length: 24 }, (_, i) => ({
      id: `0:${i + 22}`,
      name: `Page ${i + 22}`,
      status: "pending",
    })),
  ],
  requests: { tier1: 4, tier3: 1, retries: 0 },
  rateLimit: {
    retryAfterSeconds: 86_400,
    planTier: "starter",
    rateLimitType: "low",
    upgradeLink: "https://www.figma.com/settings",
    at: "2026-10-09T10:00:00Z",
  },
  warnings: ["The file is larger than 50 MB in one response; it was read page by page."],
  runs: 1,
  complete: false,
  finishedAt: null,
  unchangedCheckedAt: null,
  ...over,
});

const render = (m: unknown) =>
  renderToStaticMarkup(createElement(FigmaManifestSummary, { manifest: m }));
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

describe("Figma manifest summary (rendered)", () => {
  it("shows real page counts, requests, failures and rate-limit details", () => {
    const out = text(render(manifest()));
    expect(out).toContain(
      "20 of 45 pages read · 1 failed · 24 not read yet · 60 top-level frames · Figma version 100 · read page by page",
    );
    expect(out).toContain("4 file-content (Tier 1), 1 metadata (Tier 3) over 1 run");
    expect(out).toContain("View/Collab seat: file requests are limited to a few per month");
    expect(out).toContain("Huge page (0:21): This page is larger than 50 MB");
    expect(out).toContain("All pages (45)");
    expect(render(manifest())).toContain('href="https://www.figma.com/settings"');
  });

  it("never links to a host other than Figma", () => {
    const html = render(
      manifest({
        rateLimit: { ...manifest().rateLimit, upgradeLink: "https://evil.example/figma.com" },
      }),
    );
    expect(html).not.toContain("evil.example");
    expect(html).not.toContain("<a ");
  });

  it("renders nothing without a manifest", () => {
    expect(render(null)).toBe("");
  });
});
