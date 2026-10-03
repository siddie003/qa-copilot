import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createLogger,
  defaultScanDefaults,
  parseConfig,
  planScanSteps,
  type ScanConfigSnapshot,
} from "@qa/core";
import { closeDb, getDb, pipelineRepo, projectsRepo, schema } from "@qa/db";
import { createLocalStorage } from "@qa/storage";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDemoSite } from "../../../../fixtures/demo-site/server.mjs";
import { createTestUser, hasTestDb, resetDatabase } from "../../../../tests/setup/db";
import { runScan, type ScanRuntime } from "./run-scan";

// Full pipeline against the real test database, the local fixture website and real Chromium.
describe.skipIf(!hasTestDb)("scan pipeline (preflight → crawl → capture)", () => {
  let site: Awaited<ReturnType<typeof startDemoSite>>;
  let storageDir: string;
  let rt: ScanRuntime;
  let ownerId: string;

  beforeAll(async () => {
    await resetDatabase();
    site = await startDemoSite(0);
    storageDir = await mkdtemp(path.join(os.tmpdir(), "qa-scan-"));
    const config = parseConfig({
      DATABASE_URL: process.env.TEST_DATABASE_URL,
      BETTER_AUTH_SECRET: "integration-test-secret-0123456789abcdef",
      SCAN_ALLOWED_PRIVATE_HOSTS: `localhost:${site.port}`,
      LINK_CHECK_RETRIES: "1",
      SCAN_SCANNER_TIMEOUT_MS: "120000",
    });
    rt = {
      db: getDb(),
      storage: createLocalStorage(storageDir),
      config,
      log: createLogger(),
      heartbeatMs: 200,
    };
    ownerId = (await createTestUser()).id;
  }, 60_000);
  afterAll(async () => {
    await site?.close();
    await rm(storageDir, { recursive: true, force: true });
    await closeDb();
  });

  async function queueScan(websiteUrl: string, overrides: Partial<ScanConfigSnapshot> = {}) {
    const defaults = defaultScanDefaults();
    const project = await projectsRepo.createProject(getDb(), ownerId, {
      name: `Fixture ${Date.now()}`,
      websiteUrl,
      scanDefaults: defaults,
    });
    const snapshot: ScanConfigSnapshot = {
      websiteUrl,
      scanners: defaults.scanners,
      viewports: defaults.viewports,
      maxPages: 25,
      maxDepth: 3,
      respectRobots: true,
      pageTimeoutMs: 15_000,
      concurrency: 3,
      userAgent: "QACopilotTest/1.0",
      authorizationAttestedAt: new Date().toISOString(),
      ...overrides,
    };
    const scan = await pipelineRepo.createScan(getDb(), ownerId, project.id, {
      configSnapshot: snapshot as unknown as Record<string, unknown>,
      steps: planScanSteps(snapshot.scanners),
      triggeredByUserId: ownerId,
    });
    return scan!;
  }

  const stepsOf = async (scanId: string) =>
    Object.fromEntries(
      (
        await getDb().select().from(schema.scannerRun).where(eq(schema.scannerRun.scanId, scanId))
      ).map((r) => [r.stepKey, r]),
    );

  it("crawls and captures the fixture site and records everything", async () => {
    const queued = await queueScan(site.url);
    expect(queued.number).toBe(1);
    const claimed = await pipelineRepo.claimNextScan(getDb(), "test-worker");
    expect(claimed?.id).toBe(queued.id);
    expect(await pipelineRepo.claimNextScan(getDb(), "other-worker")).toBeNull(); // claimed once only

    await runScan(rt, claimed!);

    const detail = await pipelineRepo.getScanDetail(getDb(), ownerId, queued.id);
    expect(detail!.status).toBe("completed");
    expect(detail!.finishedAt).not.toBeNull();
    const steps = await stepsOf(queued.id);
    expect(steps.preflight).toMatchObject({ status: "completed" });
    expect(steps.preflight!.statusReason).toMatch(/Reachable: HTTP 200/);
    expect(steps.preflight!.statusReason).toMatch(/technology: could not determine/);
    expect(steps.preflight!.statusReason).toMatch(/robots.txt: found/);
    expect(steps.crawl).toMatchObject({ status: "completed" });
    expect(steps.crawl!.statusReason).toMatch(
      /15 pages fetched; 2 returned an error.*; 1 skipped \(robots.txt\)/,
    );
    expect(steps.capture).toMatchObject({ status: "completed", toolName: "Playwright" });
    for (const k of ["preflight", "crawl", "capture"]) {
      expect(steps[k]!.startedAt).not.toBeNull();
      expect(steps[k]!.durationMs).toBeGreaterThanOrEqual(0);
    }
    // Not-yet-implemented steps are honestly skipped, never "completed".
    expect(steps.seo).toMatchObject({
      status: "skipped",
      statusReason: expect.stringMatching(/Phase 5/),
    });
    expect(steps.ai).toMatchObject({
      status: "skipped",
      statusReason: expect.stringMatching(/Phase 7/),
    });
    expect(detail!.technology).toMatchObject({ detected: [], note: "Could not determine" });

    const pages = await getDb().select().from(schema.page).where(eq(schema.page.scanId, queued.id));
    const byPath = new Map(pages.map((p) => [new URL(p.url).pathname, p]));
    expect(pages).toHaveLength(16);
    expect(byPath.get("/private/secret")!.crawlError).toBe("Not crawled: disallowed by robots.txt");
    expect(byPath.get("/missing")!.httpStatus).toBe(404);
    expect(byPath.get("/server-error")!.httpStatus).toBe(500);
    expect(byPath.get("/chain-start")!.redirectChain).toEqual([
      { url: `${site.url}chain-start`, status: 302 },
      { url: `${site.url}chain-mid`, status: 301 },
    ]);
    expect(byPath.get("/js-only")).toBeDefined(); // discovered through the browser
    expect(byPath.get("/")!.responseHeaders!["content-type"]).toContain("text/html");
    expect(await rt.storage.exists(byPath.get("/")!.rawHtmlKey!)).toBe(true);

    // Captures: every successful HTML page × 3 viewports, with screenshots on disk.
    const captures = await pipelineRepo.listCapturesForScan(getDb(), ownerId, queued.id);
    const capturable = pages.filter(
      (p) => !p.crawlError && (p.httpStatus ?? 999) < 400 && p.contentType?.startsWith("text/html"),
    );
    expect(captures).toHaveLength(capturable.length * 3);
    expect(new Set(captures.map((c) => c.viewport))).toEqual(
      new Set(["desktop", "tablet", "mobile"]),
    );
    expect(captures.every((c) => c.error === null && c.screenshotKey)).toBe(true);
    expect(await rt.storage.exists(captures[0]!.screenshotKey!)).toBe(true);

    const homeCapture = (
      await getDb()
        .select()
        .from(schema.pageCapture)
        .where(eq(schema.pageCapture.pageId, byPath.get("/")!.id))
    ).find((c) => c.viewport === "desktop")!;
    expect(
      homeCapture.consoleMessages!.some((m) =>
        String(m.text).includes("intentional console error"),
      ),
    ).toBe(true);
    const requests = await getDb()
      .select()
      .from(schema.networkRequest)
      .where(eq(schema.networkRequest.pageCaptureId, homeCapture.id));
    expect(requests.find((r) => r.url.endsWith("/images/hero.jpg"))).toMatchObject({
      status: 200,
      decodedSize: 307200,
      resourceType: "image",
    });
  }, 180_000);

  it("respects page limits and ignores robots.txt when configured", async () => {
    const queued = await queueScan(site.url, {
      maxPages: 3,
      respectRobots: false,
      viewports: [{ name: "desktop", width: 1280, height: 800 }],
    });
    const claimed = await pipelineRepo.claimNextScan(getDb(), "test-worker");
    await runScan(rt, claimed!);
    const steps = await stepsOf(queued.id);
    expect(steps.crawl!.statusReason).toMatch(/3 pages fetched.*page limit of 3 reached/);
    expect(steps.preflight!.statusReason).toMatch(/robots.txt: ignored/);
  }, 120_000);

  it("fails clearly when the website is unreachable and skips the rest", async () => {
    const queued = await queueScan(`http://localhost:${site.port}/`); // allowlisted host…
    await site.close(); // …but nothing listens any more
    try {
      const claimed = await pipelineRepo.claimNextScan(getDb(), "test-worker");
      await runScan(rt, claimed!);
      const detail = await pipelineRepo.getScanDetail(getDb(), ownerId, queued.id);
      expect(detail).toMatchObject({ status: "failed", error: "Website unreachable" });
      const steps = await stepsOf(queued.id);
      expect(steps.preflight).toMatchObject({
        status: "failed",
        error: expect.stringMatching(/Website unreachable: ECONNREFUSED/),
      });
      expect(steps.crawl).toMatchObject({
        status: "skipped",
        statusReason: "Not run: Website unreachable",
      });
      expect(steps.capture!.status).toBe("skipped");
    } finally {
      site = await startDemoSite(site.port);
    }
  }, 60_000);

  it("refuses public hostnames that resolve to internal addresses", async () => {
    const queued = await queueScan("https://internal-alias.example/");
    const claimed = await pipelineRepo.claimNextScan(getDb(), "test-worker");
    await runScan({ ...rt, resolve: async () => [{ address: "10.1.2.3", family: 4 }] }, claimed!);
    const steps = await stepsOf(queued.id);
    expect(steps.preflight).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/Blocked for safety: .*10\.1\.2\.3/),
    });
    expect((await pipelineRepo.getScanDetail(getDb(), ownerId, queued.id))!.status).toBe("failed");
  }, 60_000);

  it("cancels a running scan", async () => {
    const queued = await queueScan(site.url);
    const claimed = await pipelineRepo.claimNextScan(getDb(), "test-worker");
    const cancel = await pipelineRepo.requestCancel(getDb(), ownerId, queued.id);
    expect(cancel).toMatchObject({ previousStatus: "running", status: "running" });
    await runScan(rt, claimed!);
    const detail = await pipelineRepo.getScanDetail(getDb(), ownerId, queued.id);
    expect(detail!.status).toBe("cancelled");
    expect(detail!.runs.filter((r) => r.status === "pending" || r.status === "running")).toEqual(
      [],
    );
  }, 60_000);

  it("cancels queued scans immediately and recovers scans whose worker died", async () => {
    const queued = await queueScan(site.url);
    expect(await pipelineRepo.requestCancel(getDb(), ownerId, queued.id)).toMatchObject({
      status: "cancelled",
    });
    expect(await pipelineRepo.claimNextScan(getDb(), "w")).toBeNull();

    const orphan = await queueScan(site.url);
    await pipelineRepo.claimNextScan(getDb(), "crashed-worker");
    await getDb()
      .update(schema.scan)
      .set({ heartbeatAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(schema.scan.id, orphan.id));
    expect(await pipelineRepo.failStaleScans(getDb(), 120_000)).toEqual([orphan.id]);
    const detail = await pipelineRepo.getScanDetail(getDb(), ownerId, orphan.id);
    expect(detail).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/worker stopped/),
    });
  }, 60_000);
});
