import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGuardedDispatcher } from "@qa/security";
import { startDemoSite } from "../../../fixtures/demo-site/server.mjs";
import { crawl, type CrawledPage } from "./crawl";
import { guardedFetch, sanitizeHeaders, type FetchOptions } from "./fetcher";
import { extractLinks, extractTitle } from "./links";
import { loadRobots } from "./robots";
import { detectTechnology } from "./tech";
import { isSameSite, looksLikePage, normalizeUrl } from "./url";

describe("normalizeUrl", () => {
  it.each([
    ["HTTP://Example.COM:80/a?b=2&a=1#frag", "http://example.com/a?a=1&b=2"],
    ["https://example.com:443/", "https://example.com/"],
    ["https://example.com/p?utm_source=x&id=5&gclid=y", "https://example.com/p?id=5"],
    ["https://u:p@example.com/x", "https://example.com/x"],
    ["mailto:a@b.c", null],
    ["javascript:void(0)", null],
  ])("%s", (input, expected) => {
    expect(normalizeUrl(input)).toBe(expected);
  });

  it("resolves relative URLs and dot segments against a base", () => {
    expect(normalizeUrl("/relative/../path", "https://base.example/x/")).toBe(
      "https://base.example/path",
    );
  });

  it("treats www and bare domain as the same site, but not other hosts or ports", () => {
    expect(isSameSite("https://www.example.com/a", "https://example.com/")).toBe(true);
    expect(isSameSite("https://shop.example.com/", "https://example.com/")).toBe(false);
    expect(isSameSite("http://localhost:4100/", "http://localhost:4200/")).toBe(false);
  });

  it("distinguishes pages from resources", () => {
    expect(looksLikePage("https://e.com/docs/guide.pdf")).toBe(false);
    expect(looksLikePage("https://e.com/blog/")).toBe(true);
    expect(looksLikePage("https://e.com/page.php?id=1")).toBe(true);
  });
});

describe("extractLinks", () => {
  it("resolves against <base>, skips non-navigational schemes and keeps link text", () => {
    const html = `<base href="https://cdn.example.com/sub/"><a href="a">  A   link </a><a href="mailto:x@y">m</a>
      <a href="javascript:void(0)">j</a><area href="/b"><a href="">empty</a><a href="https://other.org/">o</a>`;
    const links = extractLinks(html, "https://example.com/page");
    expect(links.map((l) => l.url)).toEqual([
      "https://cdn.example.com/sub/a",
      "https://cdn.example.com/b",
      "https://other.org/",
    ]);
    expect(links[0]!.text).toBe("A link");
  });
  it("extracts the title", () => {
    expect(extractTitle("<title> Hello\n World </title>")).toBe("Hello World");
    expect(extractTitle("<p>none</p>")).toBeNull();
  });
});

describe("detectTechnology", () => {
  const detect = (html: string, headers: Record<string, string> = {}, url = "https://e.com/") =>
    detectTechnology({ url, headers, html }).map((t) => `${t.name}:${t.confidence}`);

  it.each([
    [
      `<meta name="generator" content="WordPress 6.5"><link href="/wp-content/themes/x.css">`,
      {},
      ["WordPress:high"],
    ],
    [
      `<script id="__NEXT_DATA__" type="application/json">{}</script><script src="/_next/static/chunks/a.js">`,
      {},
      ["Next.js:high", "React:medium"],
    ],
    [`<script src="https://cdn.shopify.com/s/files/x.js"></script>`, {}, ["Shopify:high"]],
    [`<p>hi</p>`, { "x-powered-by": "PHP/8.2" }, ["PHP:high"]],
    [`<div ng-version="17.0.0"></div>`, {}, ["Angular:high"]],
  ])("detects %#", (html, headers, expected) => {
    expect(detect(html, headers)).toEqual(expected);
  });

  it("returns nothing (could not determine) for plain HTML, and lists signals", () => {
    expect(detect("<h1>Plain</h1>")).toEqual([]);
    const [wp] = detectTechnology({
      url: "https://e.com/",
      headers: {},
      html: "<link href='/wp-includes/x.js'>",
    });
    expect(wp!.signals).toEqual(["/wp-content/ or /wp-includes/ asset paths"]);
  });

  it("reports the server header separately", () => {
    expect(
      detectTechnology({ url: "https://e.com/", headers: { server: "nginx/1.25" }, html: "" }),
    ).toEqual([
      { name: "nginx", category: "server", confidence: "high", signals: ["server: nginx/1.25"] },
    ]);
  });
});

describe("sanitizeHeaders", () => {
  it("redacts cookie values but keeps names and flags", () => {
    expect(
      sanitizeHeaders({ "Set-Cookie": ["sid=abc123; HttpOnly; Secure", "theme=dark"], "X-A": "1" }),
    ).toEqual({
      "set-cookie": ["sid=[redacted]; HttpOnly; Secure", "theme=[redacted]"],
      "x-a": "1",
    });
  });
});

describe("crawling the fixture site (real HTTP)", () => {
  let site: { port: number; url: string; close: () => Promise<void> };
  let fetchOpts: FetchOptions;

  beforeAll(async () => {
    site = await startDemoSite(0);
    const policy = { allowedPrivateHosts: [`localhost:${site.port}`] };
    fetchOpts = {
      policy,
      dispatcher: createGuardedDispatcher(policy),
      userAgent: "QACopilotTest/1.0",
      timeoutMs: 5000,
      retries: 1,
    };
  });
  afterAll(async () => {
    await site.close();
    await fetchOpts.dispatcher.close();
  });

  it("follows and records redirect chains", async () => {
    const r = await guardedFetch(`${site.url}chain-start`, fetchOpts);
    expect(r.status).toBe(200);
    expect(r.finalUrl).toBe(`${site.url}products`);
    expect(r.redirectChain.map((h) => h.status)).toEqual([302, 301]);
  });

  it("retries a failing page and then reports its status", async () => {
    const r = await guardedFetch(`${site.url}server-error`, fetchOpts);
    expect(r.status).toBe(500);
    expect(r.attempts).toBe(1); // 500 is not transient (only 502/503/504 are retried)
  });

  it("blocks hosts that are not allowlisted", async () => {
    const r = await guardedFetch(`http://127.0.0.1:${site.port}/`, fetchOpts);
    expect(r.error?.code).toBe("PRIVATE_ADDRESS");
    expect(r.status).toBeNull();
  });

  it("parses robots.txt", async () => {
    const robots = await loadRobots(site.url, fetchOpts);
    expect(robots.status).toBe("found");
    expect(robots.isAllowed(`${site.url}private/secret`)).toBe(false);
    expect(robots.isAllowed(`${site.url}about`)).toBe(true);
  });

  it("crawls same-site pages breadth-first within limits, respecting robots.txt", async () => {
    const pages: CrawledPage[] = [];
    const robots = await loadRobots(site.url, fetchOpts);
    const summary = await crawl(
      {
        startUrl: site.url,
        maxPages: 50,
        maxDepth: 3,
        concurrency: 3,
        fetch: fetchOpts,
        robots,
        // Simulates the browser hook: the homepage's JavaScript adds /js-only.
        renderLinks: async (url) => (new URL(url).pathname === "/" ? [`${site.url}js-only`] : []),
      },
      async (p) => {
        pages.push(p);
      },
    );
    const byPath = new Map(pages.map((p) => [new URL(p.url).pathname, p]));
    expect([...byPath.keys()].sort()).toEqual(
      [
        "/",
        "/about",
        "/old-page",
        "/chain-start",
        "/private/secret",
        "/missing",
        "/server-error",
        "/products",
        "/blog/",
        "/contact",
        "/js-only",
        "/products/widget",
        "/products/gadget",
        "/blog/post-1",
        "/blog/post-2",
        "/blog/archive",
        "/members",
        "/wide",
        "/slow",
      ].sort(),
    );
    // Depth 4 page, external link, PDF and tracking-parameter duplicate are not visited.
    expect(byPath.has("/blog/archive/2019")).toBe(false);
    expect(pages.some((p) => p.url.includes("example.org"))).toBe(false);
    expect(pages.some((p) => p.url.includes(".pdf"))).toBe(false);
    expect(pages.filter((p) => new URL(p.url).pathname === "/about")).toHaveLength(1);

    expect(byPath.get("/private/secret")!.blockedByRobots).toBe(true);
    expect(byPath.get("/missing")!.result!.status).toBe(404);
    expect(byPath.get("/old-page")!.result!.finalUrl).toBe(`${site.url}about`);
    expect(byPath.get("/js-only")!.discoveredFrom).toBe(site.url);
    expect(byPath.get("/")!.renderedOnlyLinks).toEqual([`${site.url}js-only`]);
    expect(byPath.get("/")!.title).toBe("Demo Store – Home");
    expect(byPath.get("/blog/archive")!.depth).toBe(3);

    expect(summary).toMatchObject({ blockedByRobots: 1, limitReached: false, cancelled: false });
    expect(summary.failed).toBe(3); // /missing (404), /server-error (500), /members (401)
  });

  it("stops at the page limit", async () => {
    let visited = 0;
    const summary = await crawl(
      {
        startUrl: site.url,
        maxPages: 4,
        maxDepth: 3,
        concurrency: 2,
        fetch: fetchOpts,
        robots: null,
      },
      async (p) => {
        if (!p.blockedByRobots) visited += 1;
      },
    );
    expect(visited).toBe(4);
    expect(summary.limitReached).toBe(true);
    expect(summary.queuedButNotVisited).toBeGreaterThan(0);
  });

  it("stops when cancelled", async () => {
    const controller = new AbortController();
    let visited = 0;
    const summary = await crawl(
      {
        startUrl: site.url,
        maxPages: 50,
        maxDepth: 3,
        concurrency: 1,
        fetch: fetchOpts,
        robots: null,
        signal: controller.signal,
      },
      async () => {
        visited += 1;
        if (visited === 2) controller.abort();
      },
    );
    expect(summary.cancelled).toBe(true);
    expect(visited).toBeLessThanOrEqual(3);
  });
});
