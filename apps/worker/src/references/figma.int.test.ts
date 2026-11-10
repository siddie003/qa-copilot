import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createLogger, defaultScanDefaults, parseConfig } from "@qa/core";
import {
  closeDb,
  designSpecsRepo,
  getDb,
  projectsRepo,
  referencesRepo,
  schema,
  secretsRepo,
} from "@qa/db";
import { encryptSecret } from "@qa/security";
import { createLocalStorage } from "@qa/storage";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildFigmaFile, figmaResponse } from "../../../../fixtures/figma/large-file.mjs";
import { createTestUser, hasTestDb, resetDatabase } from "../../../../tests/setup/db";
import { processNextReferenceJob, type ReferenceRuntime } from "./process";

/**
 * Figma references on the real test database against a local HTTP server that implements the
 * documented REST endpoints (meta, file with depth/version, nodes). Mock API, not live Figma.
 */

const KEY = "LargeFile12345";
const ENCRYPTION_KEY = "ab".repeat(32);

describe.skipIf(!hasTestDb)("Figma multi-page references (worker, real PostgreSQL)", () => {
  let server: http.Server;
  let baseUrl: string;
  let ownerId: string;
  let file = buildFigmaFile(45);
  const requests: URL[] = [];
  /** Per-request override (e.g. a rate limit). */
  let intercept:
    ((url: URL) => { status: number; headers?: Record<string, string> } | null) | null = null;

  const rt = (): ReferenceRuntime => ({
    db: getDb(),
    storage: createLocalStorage("."),
    config: parseConfig({
      DATABASE_URL: process.env.TEST_DATABASE_URL,
      BETTER_AUTH_SECRET: "integration-test-secret-0123456789abcdef",
      ENCRYPTION_KEY,
      FIGMA_PAGES_PER_REQUEST: "10",
      FIGMA_MAX_RETRIES: "1",
    }),
    log: createLogger(),
    figmaBaseUrl: baseUrl,
    // Response cap that lets ~12 pages through but not the whole file: page-by-page mode.
    figmaMaxBytes: Buffer.byteLength(JSON.stringify(file.document.children[0])) * 12,
    figmaRetryBaseMs: 1,
  });

  beforeAll(async () => {
    await resetDatabase();
    server = http.createServer((req, res) => {
      const url = new URL(req.url!, "http://figma.local");
      requests.push(url);
      if (req.headers["x-figma-token"] !== "figd_valid") {
        res.writeHead(403, { "content-type": "application/json" });
        return res.end('{"status":403,"err":"Invalid token"}');
      }
      const forced = intercept?.(url);
      if (forced) {
        res.writeHead(forced.status, { "content-type": "application/json", ...forced.headers });
        return res.end("{}");
      }
      const body = figmaResponse(file, url);
      res.writeHead(body ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify(body ?? { status: 404, err: "Not found" }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    ownerId = (await createTestUser()).id;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await closeDb();
  });

  async function newReference() {
    const project = await projectsRepo.createProject(getDb(), ownerId, {
      name: `Figma ${randomUUID().slice(0, 8)}`,
      websiteUrl: "https://example.com/",
      scanDefaults: defaultScanDefaults(),
    });
    await secretsRepo.setProjectSecret(
      getDb(),
      project.id,
      secretsRepo.FIGMA_TOKEN_KIND,
      encryptSecret(JSON.stringify({ token: "figd_valid" }), ENCRYPTION_KEY, project.id),
      { configured: true },
    );
    const ref = await referencesRepo.addFigmaReference(getDb(), project.id, {
      figmaUrl: `https://www.figma.com/design/${KEY}`,
      figmaFileKey: KEY,
      figmaNodeIds: [],
    });
    return { project, ref };
  }
  const drain = async (runtime = rt()) => {
    while (await processNextReferenceJob(runtime)) {
      /* drain */
    }
  };
  const row = async (id: string) =>
    (
      await getDb().select().from(schema.referenceSource).where(eq(schema.referenceSource.id, id))
    )[0]!;
  type Manifest = {
    mode: string;
    complete: boolean;
    pagesDiscovered: number;
    pages: Array<{ id: string; status: string; framesTotal?: number }>;
    requests: { tier1: number; tier3: number };
    rateLimit: Record<string, unknown> | null;
    runs: number;
  };

  it("reads a 45-page file page by page into a draft, with a complete manifest", async () => {
    file = buildFigmaFile(45);
    const { project, ref } = await newReference();
    await drain();
    const r = await row(ref.id);
    const m = r.manifest as unknown as Manifest;
    expect(r).toMatchObject({
      status: "ready",
      outcome: "completed_with_warnings",
      checkpoint: null,
      attempts: 1,
    });
    expect(m).toMatchObject({ mode: "pages", complete: true, pagesDiscovered: 45, runs: 1 });
    expect(m.pages.filter((p) => p.status === "done")).toHaveLength(45);
    expect(m.pages.every((p) => p.framesTotal === 3)).toBe(true);
    // 45 page colors + 5 heading values (family, size, weight, line height, color).
    expect(r.meta).toMatchObject({
      valuesFound: 50,
      version: "100",
      draftVersion: 1,
      extractedTotal: 46,
    });
    const draft = designSpecsRepo.specOf(
      (await designSpecsRepo.getDesignSpecState(getDb(), project.id)).draft!,
    );
    expect(Object.keys(draft.colors)).toHaveLength(45);
    expect(draft.typography.h1).toMatchObject({
      fontSize: 48,
      source: { type: "figma", fileKey: KEY },
    });
  });

  it("stops at a long rate limit as Partial with a draft, then continues with only the missing pages", async () => {
    file = buildFigmaFile(45);
    const { project, ref } = await newReference();
    let nodesCalls = 0;
    intercept = (url) => {
      if (!url.pathname.endsWith("/nodes")) return null;
      nodesCalls += 1;
      return nodesCalls === 3
        ? {
            status: 429,
            headers: {
              "retry-after": "86400",
              "x-figma-plan-tier": "starter",
              "x-figma-rate-limit-type": "low",
              "x-figma-upgrade-link": "https://www.figma.com/settings",
            },
          }
        : null;
    };
    await drain();
    intercept = null;
    let r = await row(ref.id);
    let m = r.manifest as unknown as Manifest;
    expect(r).toMatchObject({ status: "ready", outcome: "partial" });
    expect(r.checkpoint).not.toBeNull();
    expect(m.pages.filter((p) => p.status === "done")).toHaveLength(20);
    expect(m.pages.filter((p) => p.status === "pending")).toHaveLength(25);
    expect(m.rateLimit).toMatchObject({
      planTier: "starter",
      rateLimitType: "low",
      retryAfterSeconds: 86_400,
    });
    expect(String((r.meta as { note: string }).note)).toMatch(
      /Stopped after 20 of 45 pages: Figma's rate limit was reached \(plan: starter\)\. Figma asks to wait 24 h\..*remaining 25 page/,
    );
    // A partial draft (reviewed before use) holds the values of the pages read.
    let draft = designSpecsRepo.specOf(
      (await designSpecsRepo.getDesignSpecState(getDb(), project.id)).draft!,
    );
    expect(Object.keys(draft.colors)).toHaveLength(20);

    // Continue: only the 25 missing pages are requested, then the read is complete.
    const before = requests.length;
    expect(await referencesRepo.requeueReference(getDb(), project.id, ref.id)).toMatchObject({
      resumable: true,
    });
    await drain();
    const later = requests.slice(before);
    expect(later.filter((u) => u.pathname === `/v1/files/${KEY}`)).toHaveLength(0);
    expect(
      later
        .filter((u) => u.pathname.endsWith("/nodes"))
        .flatMap((u) => u.searchParams.get("ids")!.split(",")),
    ).toHaveLength(25);
    r = await row(ref.id);
    m = r.manifest as unknown as Manifest;
    expect(r).toMatchObject({ status: "ready", checkpoint: null });
    expect(r.outcome).not.toBe("partial");
    expect(m).toMatchObject({ complete: true, runs: 2 });
    expect(m.pages.every((p) => p.status === "done")).toBe(true);
    draft = designSpecsRepo.specOf(
      (await designSpecsRepo.getDesignSpecState(getDb(), project.id)).draft!,
    );
    expect(Object.keys(draft.colors)).toHaveLength(45);
  });

  it("cancels between batches and continues later; a stale run resumes from its checkpoint", async () => {
    file = buildFigmaFile(45);
    const { project, ref } = await newReference();
    let batches = 0;
    await drain({
      ...rt(),
      afterReferenceBatch: async (id) => {
        batches += 1;
        if (batches === 2) await referencesRepo.cancelReference(getDb(), project.id, id);
      },
    });
    let r = await row(ref.id);
    expect(r).toMatchObject({
      status: "cancelled",
      error: expect.stringMatching(/continues where it stopped/),
    });
    const pendingAfterCancel = (r.manifest as unknown as Manifest).pages.filter(
      (p) => p.status === "pending",
    ).length;
    expect(pendingAfterCancel).toBeGreaterThan(0);
    expect(r.checkpoint).not.toBeNull();

    // Simulate a worker that died while continuing: the row stays "processing" and goes stale.
    await referencesRepo.requeueReference(getDb(), project.id, ref.id);
    await getDb()
      .update(schema.referenceSource)
      .set({
        status: "processing",
        attempts: 1,
        processingStartedAt: sql`now() - interval '10 minutes'`,
      })
      .where(eq(schema.referenceSource.id, ref.id));
    expect(await referencesRepo.recoverStaleReferences(getDb(), 5 * 60_000)).toEqual([ref.id]);
    expect((await row(ref.id)).status).toBe("pending");
    const before = requests.length;
    await drain();
    r = await row(ref.id);
    expect(r).toMatchObject({ status: "ready", checkpoint: null });
    expect(
      requests
        .slice(before)
        .filter((u) => u.pathname.endsWith("/nodes"))
        .flatMap((u) => u.searchParams.get("ids")!.split(",")),
    ).toHaveLength(pendingAfterCancel);
    expect((r.manifest as unknown as Manifest).pages.every((p) => p.status === "done")).toBe(true);
  });

  it("skips unchanged files, and reports a page Figma cannot return as Partial", async () => {
    file = buildFigmaFile(3);
    const { ref, project } = await newReference();
    await drain();
    expect((await row(ref.id)).manifest).toMatchObject({
      mode: "whole_file",
      requests: { tier1: 1 },
    });
    const before = requests.length;
    await referencesRepo.requeueReference(getDb(), project.id, ref.id);
    await drain();
    expect(requests.slice(before).map((u) => u.pathname)).toEqual([`/v1/files/${KEY}/meta`]);
    expect((await row(ref.id)).meta).toMatchObject({ note: expect.stringMatching(/unchanged/) });

    // A new version (30 pages, page mode) where Figma answers HTTP 500 for any request that
    // includes page 0:7: the batch is split until that page is isolated; the rest is read.
    file = buildFigmaFile(30, { version: "200" });
    intercept = (url) =>
      url.pathname.endsWith("/nodes") && url.searchParams.get("ids")!.split(",").includes("0:7")
        ? { status: 500 }
        : null;
    await referencesRepo.requeueReference(getDb(), project.id, ref.id);
    await drain();
    intercept = null;
    const r = await row(ref.id);
    const m = r.manifest as unknown as Manifest & {
      pages: Array<{ id: string; status: string; error?: string }>;
    };
    expect(r).toMatchObject({ status: "ready", outcome: "partial", checkpoint: null });
    expect(m).toMatchObject({ mode: "pages", complete: true, pagesDiscovered: 30 });
    expect(m.pages.find((p) => p.id === "0:7")).toMatchObject({
      status: "failed",
      error: "Figma could not return this page (Figma answered HTTP 500).",
    });
    expect(m.pages.filter((p) => p.status === "done")).toHaveLength(29);
    expect(String((r.meta as { note: string }).note)).toMatch(/1 page\(s\) could not be read/);
  });

  it("fails without a checkpoint when the token is rejected", async () => {
    file = buildFigmaFile(2);
    const { project, ref } = await newReference();
    await secretsRepo.setProjectSecret(
      getDb(),
      project.id,
      secretsRepo.FIGMA_TOKEN_KIND,
      encryptSecret(JSON.stringify({ token: "figd_wrong" }), ENCRYPTION_KEY, project.id),
      { configured: true },
    );
    await drain();
    expect(await row(ref.id)).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/rejected the access token/),
      checkpoint: null,
    });
  });
});
