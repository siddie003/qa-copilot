import { describe, expect, it } from "vitest";
import { buildFigmaFile, figmaResponse } from "../../../fixtures/figma/large-file.mjs";
import { FigmaClient } from "./figma/client";
import { finalizeFigma, normalizeFigma } from "./figma/normalize";
import { readFigmaReference, type FigmaCheckpoint, type FigmaManifest } from "./figma/pages";

/**
 * Multi-page Figma reads against a mock of the documented REST endpoints (GET file meta, GET file
 * with depth/version, GET file nodes with ids/version). No real Figma API is called.
 */

const KEY = "LargeFile12345";

const buildFile = buildFigmaFile;

interface MockOpts {
  file: ReturnType<typeof buildFile>;
  /** Called per request; return a Response to override. */
  intercept?: (url: URL, n: number) => Response | null;
  metaVersion?: string;
}

function mockFigma(o: MockOpts) {
  const calls: URL[] = [];
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url);
    const hit = o.intercept?.(url, calls.length);
    if (hit) return hit;
    if (url.pathname.endsWith("/meta") && o.metaVersion)
      return json({ file: { name: o.file.name, version: o.metaVersion } });
    const body = figmaResponse(o.file, url);
    if (body) return json(body);
    return json({ status: 404, err: "Not found" }, 404);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const client = (fetchImpl: typeof fetch, maxBytes = 50 * 1024 * 1024) =>
  new FigmaClient({
    token: "figd_test",
    baseUrl: "https://api.figma.test",
    fetchImpl,
    maxBytes,
    retryBaseMs: 1,
  });

async function read(c: FigmaClient, over: Partial<Parameters<typeof readFigmaReference>[0]> = {}) {
  const saved: Array<{ manifest: FigmaManifest; checkpoint: FigmaCheckpoint | null }> = [];
  const result = await readFigmaReference({
    client: c,
    fileKey: KEY,
    nodeIds: [],
    previous: null,
    checkpoint: null,
    pagesPerRequest: 10,
    maxResponseMb: 1,
    onProgress: async (manifest, checkpoint) => {
      saved.push(structuredClone({ manifest, checkpoint }));
      return true;
    },
    ...over,
  });
  return { result, saved };
}

const nodeRequests = (calls: URL[]) => calls.filter((u) => u.pathname.endsWith("/nodes"));
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));

describe("Figma reads: whole file vs page by page", () => {
  it("reads a small file in one file-content request (plus one metadata request)", async () => {
    const file = buildFile(3);
    const m = mockFigma({ file });
    const { result } = await read(client(m.fetchImpl));
    expect(result.status).toBe("done");
    expect(result.manifest).toMatchObject({
      mode: "whole_file",
      complete: true,
      pagesDiscovered: 3,
      version: "100",
      requests: { tier1: 1, tier3: 1, retries: 0 },
    });
    expect(result.manifest.pages.map((p) => [p.id, p.status, p.framesTotal])).toEqual([
      ["0:1", "done", 3],
      ["0:2", "done", 3],
      ["0:3", "done", 3],
    ]);
    expect(result.manifest.pages[0]!.frames![0]).toEqual({
      id: "1:10",
      name: "Screen 1.1",
      type: "FRAME",
      width: 1440,
      height: 900,
    });
  });

  it("reads a large file (60 pages, beyond the response cap) page by page with identical results", async () => {
    const file = buildFile(60);
    const m = mockFigma({ file });
    // The cap lets ~5 pages through per response but not the whole file.
    const maxBytes = bytes(file.document.children![0]) * 6 + 20_000;
    expect(bytes(file)).toBeGreaterThan(maxBytes);
    const { result, saved } = await read(client(m.fetchImpl, maxBytes));
    if (result.status !== "done") throw new Error(result.status);
    const pages = result.manifest.pages;
    expect(pages).toHaveLength(60);
    expect(pages.every((p) => p.status === "done" && p.framesTotal === 3)).toBe(true);
    expect(result.manifest).toMatchObject({ mode: "pages", pagesDiscovered: 60, complete: true });
    expect(result.manifest.warnings.join(" ")).toMatch(/read page by page/);
    // Every page requested; after the first oversized batch the batch size adapts, so only that
    // first batch is requested twice. Every request is pinned to the listed version.
    const asked = nodeRequests(m.calls).flatMap((u) => u.searchParams.get("ids")!.split(","));
    expect([...new Set(asked)].sort()).toEqual(pages.map((p) => p.id).sort());
    expect(asked.length).toBeLessThanOrEqual(70);
    expect(nodeRequests(m.calls).every((u) => u.searchParams.get("version") === "100")).toBe(true);
    // Same design values as reading everything at once.
    const whole = normalizeFigma(
      {
        name: file.name,
        lastModified: null,
        version: "100",
        roots: [file.document],
        styles: file.styles,
      },
      KEY,
    );
    expect(finalizeFigma(result.collect, KEY)).toEqual(whole);
    // 60 page colors; "Brand/Primary" is defined but used by no node, so neither path reads it.
    expect(Object.keys(whole.spec.colors)).toHaveLength(60);
    // Progress was persisted after the page list and after every batch.
    expect(saved.length).toBeGreaterThan(3);
    expect(saved.at(-1)!.checkpoint!.pending).toEqual([]);
    // Requests: meta + whole (too large) + page list + batches.
    expect(result.manifest.requests.tier3).toBe(1);
    expect(result.manifest.requests.tier1).toBe(2 + nodeRequests(m.calls).length);
  });

  it("goes straight to page mode when the previous read needed it", async () => {
    const file = buildFile(12);
    const m = mockFigma({ file, metaVersion: "101" });
    const previous = { mode: "pages", complete: true, version: "100" } as FigmaManifest;
    const { result } = await read(client(m.fetchImpl), { previous });
    expect(result.status).toBe("done");
    expect(m.calls.filter((u) => u.pathname === `/v1/files/${KEY}`).map((u) => u.search)).toEqual([
      "?depth=1",
    ]);
  });

  it("splits an oversized batch and records a single page that is too large as failed", async () => {
    const file = buildFile(8, { hugePage: 5 });
    const m = mockFigma({ file });
    const maxBytes = bytes(file.document.children![0]) * 4;
    const { result } = await read(client(m.fetchImpl, maxBytes), { pagesPerRequest: 8 });
    if (result.status !== "done") throw new Error(result.status);
    const byId = Object.fromEntries(result.manifest.pages.map((p) => [p.id, p]));
    expect(byId["0:5"]).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/larger than 1 MB.*link one of its frames/),
    });
    expect(Object.values(byId).filter((p) => p.status === "done")).toHaveLength(7);
    // The other pages' values are still read (page 5's own color could not be).
    const colors = Object.keys(finalizeFigma(result.collect, KEY).spec.colors);
    expect(colors).toHaveLength(7);
    expect(colors).not.toContain("Palette/Color 5");
  });

  it("records a page Figma does not return (null node) without stopping", async () => {
    const file = buildFile(4);
    const m = mockFigma({
      file,
      intercept: (url) => {
        if (!url.pathname.endsWith("/nodes")) return null;
        const ids = url.searchParams.get("ids")!.split(",");
        const nodes = Object.fromEntries(
          ids.map((id) => [
            id,
            id === "0:2"
              ? null
              : { document: file.document.children!.find((c) => c.id === id), styles: file.styles },
          ]),
        );
        return new Response(JSON.stringify({ name: file.name, nodes }), { status: 200 });
      },
    });
    const { result } = await read(client(m.fetchImpl, bytes(file) - 10));
    expect(result.manifest.pages.find((p) => p.id === "0:2")).toMatchObject({
      status: "failed",
      error: "Page not returned by Figma for this version",
    });
    expect(result.manifest.pages.filter((p) => p.status === "done")).toHaveLength(3);
  });
});

describe("Figma rate limits, resume and caching", () => {
  it("waits for a short Retry-After and carries on", async () => {
    const file = buildFile(2);
    const m = mockFigma({
      file,
      intercept: (url, n) =>
        n === 2 ? new Response("{}", { status: 429, headers: { "retry-after": "0" } }) : null,
    });
    const { result } = await read(client(m.fetchImpl));
    expect(result.status).toBe("done");
    expect(result.manifest.requests).toMatchObject({ tier1: 2, retries: 1 });
  });

  it("stops at a long rate limit with Figma's plan details, then continues with only the missing pages", async () => {
    const file = buildFile(40);
    const maxBytes = bytes(file.document.children![0]) * 12;
    let limited = true;
    const m = mockFigma({
      file,
      intercept: (url) => {
        const n = nodeRequests([url]).length ? (limitedCalls += 1) : 0;
        if (limited && n === 3)
          return new Response("{}", {
            status: 429,
            headers: {
              "retry-after": "2592000",
              "x-figma-plan-tier": "starter",
              "x-figma-rate-limit-type": "low",
              "x-figma-upgrade-link": "https://www.figma.com/pricing",
            },
          });
        return null;
      },
    });
    let limitedCalls = 0;
    const first = await read(client(m.fetchImpl, maxBytes));
    if (first.result.status !== "stopped") throw new Error("expected a stop");
    expect(first.result.error.code).toBe("RATE_LIMITED");
    expect(first.result.error.message).toMatch(/plan: starter.*30 days.*View or Collab seat/);
    expect(first.result.manifest.rateLimit).toMatchObject({
      retryAfterSeconds: 2_592_000,
      planTier: "starter",
      rateLimitType: "low",
      upgradeLink: "https://www.figma.com/pricing",
    });
    expect(first.result.manifest.pages.filter((p) => p.status === "done")).toHaveLength(20);
    expect(first.result.checkpoint.pending).toHaveLength(20);
    expect(first.result.manifest.requests.retries).toBe(0); // a 30-day wait is not waited for

    limited = false;
    const before = m.calls.length;
    const second = await read(client(m.fetchImpl, maxBytes), {
      previous: first.result.manifest,
      checkpoint: first.result.checkpoint,
    });
    if (second.result.status !== "done") throw new Error(second.result.status);
    const later = m.calls.slice(before);
    // Only the metadata check and the missing pages: no new whole-file or page-list request.
    expect(later.filter((u) => u.pathname === `/v1/files/${KEY}`)).toHaveLength(0);
    expect(nodeRequests(later).flatMap((u) => u.searchParams.get("ids")!.split(","))).toEqual(
      first.result.checkpoint.pending,
    );
    expect(second.result.manifest.pages.every((p) => p.status === "done")).toBe(true);
    expect(second.result.manifest.runs).toBe(2);
    const whole = normalizeFigma(
      {
        name: file.name,
        lastModified: null,
        version: "100",
        roots: [file.document],
        styles: file.styles,
      },
      KEY,
    );
    expect(finalizeFigma(second.result.collect, KEY)).toEqual(whole);
  });

  it("starts over when the file changed since an interrupted read", async () => {
    const file = buildFile(6);
    const m = mockFigma({ file, metaVersion: "205" });
    const checkpoint: FigmaCheckpoint = {
      version: "100",
      pending: ["0:5", "0:6"],
      collect: {
        textStyles: {},
        fillStyles: {},
        buttons: [],
        container: null,
        styles: {},
        nodes: 0,
      },
    };
    const { result } = await read(client(m.fetchImpl), {
      checkpoint,
      previous: { mode: "pages", pages: [] } as unknown as FigmaManifest,
    });
    expect(result.status).toBe("done");
    expect(result.manifest.warnings.join(" ")).toMatch(
      /changed \(version 100 → 205\).*from the start/,
    );
    expect(result.manifest.pages).toHaveLength(6);
  });

  it("makes no file-content request when the version is unchanged since a complete read", async () => {
    const file = buildFile(3);
    const m = mockFigma({ file });
    const first = await read(client(m.fetchImpl));
    const before = m.calls.length;
    const again = await read(client(m.fetchImpl), { previous: first.result.manifest });
    expect(again.result.status).toBe("unchanged");
    expect(m.calls.slice(before).map((u) => u.pathname)).toEqual([`/v1/files/${KEY}/meta`]);
    expect(again.result.manifest.requests).toMatchObject({ tier1: 1, tier3: 2 });
  });

  it("reads without the version check when the token lacks the metadata scope", async () => {
    const file = buildFile(2);
    const m = mockFigma({
      file,
      intercept: (url) =>
        url.pathname.endsWith("/meta") ? new Response("{}", { status: 403 }) : null,
    });
    const { result } = await read(client(m.fetchImpl));
    expect(result.status).toBe("done");
    expect(result.manifest.warnings.join(" ")).toMatch(/file_metadata:read scope/);
  });

  it("stops between batches when cancelled and keeps the checkpoint", async () => {
    const file = buildFile(30);
    const m = mockFigma({ file });
    let batches = 0;
    const { result } = await read(client(m.fetchImpl, bytes(file.document.children![0]) * 12), {
      onProgress: async () => (batches += 1) < 3,
    });
    if (result.status !== "stopped") throw new Error("expected a stop");
    expect(result.error.code).toBe("CANCELLED");
    expect(result.checkpoint.pending).toHaveLength(10);
  });

  it("reads linked nodes in one request and reports ids that are missing", async () => {
    const file = buildFile(3);
    const m = mockFigma({ file });
    const { result } = await read(client(m.fetchImpl), { nodeIds: ["0:2", "9:9"] });
    expect(result.manifest).toMatchObject({ mode: "nodes", pagesDiscovered: 2 });
    expect(result.manifest.pages.map((p) => [p.id, p.status])).toEqual([
      ["0:2", "done"],
      ["9:9", "failed"],
    ]);
    expect(nodeRequests(m.calls)).toHaveLength(1);
  });
});
