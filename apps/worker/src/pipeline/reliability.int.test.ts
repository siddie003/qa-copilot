import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import {
  createLogger,
  defaultScanDefaults,
  parseConfig,
  planScanSteps,
  type ScanConfigSnapshot,
} from "@qa/core";
import { closeDb, getDb, pipelineRepo, projectsRepo, schema, secretsRepo } from "@qa/db";
import type { Resolver } from "@qa/security";
import { createLocalStorage } from "@qa/storage";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestUser, hasTestDb, resetDatabase } from "../../../../tests/setup/db";
import { runScan, type ScanRuntime } from "./run-scan";
import { startScanWorker } from "./scan-worker";

const offlineDns: Resolver = async (host) => {
  if (host === "localhost") return [{ address: "127.0.0.1", family: 4 }];
  throw Object.assign(new Error(`${host} not found`), { code: "ENOTFOUND" });
};

/** A website whose pages each take `delayMs` to answer; the home page links to 20 pages. */
function startSlowSite(delayMs: number) {
  const server = http.createServer((req, res) => {
    if (req.url === "/robots.txt") return res.writeHead(404).end();
    if (req.url === "/favicon.ico") return res.writeHead(404).end();
    setTimeout(() => {
      const links = Array.from({ length: 20 }, (_, i) => `<a href="/p${i + 1}">Page ${i + 1}</a>`);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><html lang="en"><head><title>Slow ${req.url}</title></head><body><h1>Slow</h1>${req.url === "/" ? links.join(" ") : '<a href="/">Home</a>'}</body></html>`,
      );
    }, delayMs);
  });
  return new Promise<{ url: string; port: number; close: () => Promise<void> }>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://localhost:${port}/`,
        port,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    }),
  );
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!hasTestDb)("worker reliability (Phase 10)", () => {
  let storageDir: string;
  let ownerId: string;
  const db = () => getDb();

  beforeAll(async () => {
    storageDir = await mkdtemp(path.join(os.tmpdir(), "qa-reliability-"));
  });
  beforeEach(async () => {
    await resetDatabase();
    ownerId = (await createTestUser()).id;
  });
  afterAll(async () => {
    await rm(storageDir, { recursive: true, force: true });
    await closeDb();
  });

  async function newProject(websiteUrl = "https://example.com/") {
    return projectsRepo.createProject(db(), ownerId, {
      name: `Reliability ${Date.now()}`,
      websiteUrl,
      scanDefaults: defaultScanDefaults(),
    });
  }

  function snapshotFor(websiteUrl: string): ScanConfigSnapshot {
    return {
      websiteUrl,
      scanners: ["seo"],
      viewports: [{ name: "desktop", width: 1280, height: 800 }],
      maxPages: 25,
      maxDepth: 1,
      respectRobots: true,
      pageTimeoutMs: 15_000,
      concurrency: 1,
      userAgent: "QACopilotTest/1.0",
      authorizationAttestedAt: new Date().toISOString(),
      authType: null,
      designSpecVersion: null,
      contentDocuments: [],
    };
  }

  async function queue(projectId: string, snapshot: ScanConfigSnapshot) {
    const scan = await pipelineRepo.createScan(db(), ownerId, projectId, {
      configSnapshot: snapshot as unknown as Record<string, unknown>,
      steps: planScanSteps(snapshot.scanners),
      triggeredByUserId: ownerId,
    });
    return scan!;
  }

  const stepsOf = async (scanId: string) =>
    Object.fromEntries(
      (await db().select().from(schema.scannerRun).where(eq(schema.scannerRun.scanId, scanId))).map(
        (r) => [r.stepKey, r],
      ),
    );
  const scanRow = async (id: string) =>
    (await db().select().from(schema.scan).where(eq(schema.scan.id, id)))[0]!;
  const pageCount = async (scanId: string) =>
    (
      await db()
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.page)
        .where(eq(schema.page.scanId, scanId))
    )[0]!.n;

  function runtime(port: number, extra: Partial<ScanRuntime> = {}): ScanRuntime {
    return {
      db: db(),
      storage: createLocalStorage(storageDir),
      log: createLogger(),
      heartbeatMs: 200,
      resolve: offlineDns,
      stepSettleMs: 10_000,
      config: parseConfig({
        DATABASE_URL: process.env.TEST_DATABASE_URL,
        BETTER_AUTH_SECRET: "integration-test-secret-0123456789abcdef",
        SCAN_ALLOWED_PRIVATE_HOSTS: `localhost:${port}`,
        LINK_CHECK_RETRIES: "0",
        SCAN_SCANNER_TIMEOUT_MS: "10000",
      }),
      ...extra,
    };
  }

  // ---- one active scan per project (database constraint) --------------------------------------

  it("allows only one queued or running scan per project, even for concurrent requests", async () => {
    const project = await newProject();
    const snapshot = snapshotFor(project.websiteUrl);
    const results = await Promise.allSettled([
      queue(project.id, snapshot),
      queue(project.id, snapshot),
      queue(project.id, snapshot),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((x) => x.status === "rejected"))
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(
        pipelineRepo.ActiveScanExistsError,
      );
    // The scan number of a refused request is not consumed.
    const scans = await db()
      .select()
      .from(schema.scan)
      .where(eq(schema.scan.projectId, project.id));
    expect(scans.map((s) => s.number)).toEqual([1]);
    // Once it finished, the next scan can start.
    await db()
      .update(schema.scan)
      .set({ status: "completed" })
      .where(eq(schema.scan.id, scans[0]!.id));
    expect((await queue(project.id, snapshot)).number).toBe(2);
    // Another project is never blocked.
    expect(await queue((await newProject()).id, snapshot)).toBeTruthy();
  });

  it("migration 0006 resolves existing duplicate active scans before creating the index", async () => {
    const project = await newProject();
    const snapshot = snapshotFor(project.websiteUrl);
    const sqlFile = readFileSync(
      path.resolve(
        import.meta.dirname,
        "../../../../packages/db/migrations/0006_production_hardening.sql",
      ),
      "utf8",
    );
    const [cleanup, createIndex] = sqlFile.split("--> statement-breakpoint");
    await db().execute(sql.raw("drop index scan_one_active_per_project_uq"));
    try {
      const running = await queue(project.id, snapshot);
      await db()
        .update(schema.scan)
        .set({ status: "running" })
        .where(eq(schema.scan.id, running.id));
      const dupA = await queue(project.id, snapshot);
      const dupB = await queue(project.id, snapshot);
      await db().execute(sql.raw(cleanup!));
      expect((await scanRow(running.id)).status).toBe("running");
      for (const id of [dupA.id, dupB.id]) {
        const row = await scanRow(id);
        expect(row.status).toBe("cancelled");
        expect(row.error).toMatch(/another scan of this project/);
        const steps = Object.values(await stepsOf(id));
        expect(steps.every((s) => s.status === "skipped")).toBe(true);
      }
    } finally {
      await db().execute(sql.raw(createIndex!));
    }
    await expect(queue(project.id, snapshot)).rejects.toBeInstanceOf(
      pipelineRepo.ActiveScanExistsError,
    );
  });

  // ---- stale scans, ownership ------------------------------------------------------------------

  it("recovers stale scans once (also when run concurrently) and never touches live ones", async () => {
    const snapshot = snapshotFor("https://example.com/");
    const stale = await queue((await newProject()).id, snapshot);
    const live = await queue((await newProject()).id, snapshot);
    await pipelineRepo.claimNextScan(db(), "w#1");
    await pipelineRepo.claimNextScan(db(), "w#2");
    await pipelineRepo.updateStep(db(), stale.id, "preflight", {
      status: "running",
      started: true,
    });
    await db()
      .update(schema.scan)
      .set({ heartbeatAt: sql`now() - interval '10 minutes'` })
      .where(eq(schema.scan.id, stale.id));

    const [a, b] = await Promise.all([
      pipelineRepo.failStaleScans(db(), 120_000),
      pipelineRepo.failStaleScans(db(), 120_000),
    ]);
    expect([...a, ...b]).toEqual([stale.id]);
    const row = await scanRow(stale.id);
    expect(row).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/stopped responding/),
    });
    const steps = await stepsOf(stale.id);
    expect(steps.preflight).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/Worker stopped/),
    });
    expect(steps.crawl).toMatchObject({ status: "skipped" });
    expect((await scanRow(live.id)).status).toBe("running");
  });

  it("heartbeats and the final status are bound to the worker that owns the scan", async () => {
    const scan = await queue((await newProject()).id, snapshotFor("https://example.com/"));
    const claimed = (await pipelineRepo.claimNextScan(db(), "owner#1"))!;
    expect(claimed.workerId).toBe("owner#1");
    expect(await pipelineRepo.heartbeat(db(), scan.id, "owner#1")).toEqual({
      cancelRequested: false,
      lost: false,
    });
    expect((await pipelineRepo.heartbeat(db(), scan.id, "other#1")).lost).toBe(true);
    expect(await pipelineRepo.finishScan(db(), scan.id, "completed", null, "other#1")).toBe(false);
    expect((await scanRow(scan.id)).status).toBe("running");
    // Recovered (failed) elsewhere: the owner can no longer overwrite it.
    await db().update(schema.scan).set({ status: "failed" }).where(eq(schema.scan.id, scan.id));
    expect((await pipelineRepo.heartbeat(db(), scan.id, "owner#1")).lost).toBe(true);
    expect(await pipelineRepo.finishScan(db(), scan.id, "completed", null, "owner#1")).toBe(false);
    expect((await scanRow(scan.id)).status).toBe("failed");
  });

  // ---- deleting a project ------------------------------------------------------------------------

  it("deleting a project cancels its scans and deletes its stored credentials", async () => {
    const project = await newProject();
    await secretsRepo.setProjectSecret(db(), project.id, secretsRepo.SCAN_AUTH_KIND, "v1.x.y.z", {
      type: "basic",
    });
    await secretsRepo.setProjectSecret(db(), project.id, secretsRepo.FIGMA_TOKEN_KIND, "v1.a.b.c", {
      configured: true,
    });
    const queued = await queue(project.id, snapshotFor(project.websiteUrl));
    const other = await newProject();
    const running = await queue(other.id, snapshotFor(other.websiteUrl));
    await pipelineRepo.claimNextScan(db(), "w#1"); // claims the oldest: `queued` of project 1
    await db()
      .update(schema.scan)
      .set({ status: "queued", workerId: null })
      .where(eq(schema.scan.id, queued.id));
    await pipelineRepo.claimNextScan(db(), "w#1");

    expect(await projectsRepo.softDeleteProject(db(), ownerId, project.id)).toBe(true);
    const row = await scanRow(queued.id);
    expect(row.status === "cancelled" || row.cancelRequestedAt !== null).toBe(true);
    expect(
      await secretsRepo.getProjectSecret(db(), project.id, secretsRepo.SCAN_AUTH_KIND),
    ).toBeNull();
    expect(
      await secretsRepo.getProjectSecret(db(), project.id, secretsRepo.FIGMA_TOKEN_KIND),
    ).toBeNull();
    // Other projects are untouched.
    expect((await scanRow(running.id)).cancelRequestedAt).toBeNull();

    // A queued scan is cancelled at once with its steps skipped.
    const third = await newProject();
    const waiting = await queue(third.id, snapshotFor(third.websiteUrl));
    await projectsRepo.softDeleteProject(db(), ownerId, third.id);
    expect((await scanRow(waiting.id)).status).toBe("cancelled");
    const steps = Object.values(await stepsOf(waiting.id));
    expect(steps.every((s) => s.status === "skipped")).toBe(true);
    expect(steps[0]!.statusReason).toMatch(/Project deleted/);
    // A running scan gets a cancellation request (its worker stops it).
    const fourth = await newProject();
    const active = await queue(fourth.id, snapshotFor(fourth.websiteUrl));
    await db().update(schema.scan).set({ status: "running" }).where(eq(schema.scan.id, active.id));
    await projectsRepo.softDeleteProject(db(), ownerId, fourth.id);
    expect(await scanRow(active.id)).toMatchObject({
      status: "running",
      cancelRequestedAt: expect.any(Date),
    });
  });

  // ---- real scans against a slow site (real Chromium) ---------------------------------------------

  it("a timed-out step is stopped and stores nothing after the scan moved on", async () => {
    const site = await startSlowSite(2_000);
    try {
      const project = await newProject(site.url);
      const queued = await queue(project.id, snapshotFor(site.url));
      const claimed = (await pipelineRepo.claimNextScan(db(), "t#1"))!;
      await runScan(runtime(site.port), claimed);

      const steps = await stepsOf(queued.id);
      expect(steps.crawl).toMatchObject({
        status: "failed",
        error: expect.stringMatching(/timed out after 10 s/),
      });
      expect((await scanRow(queued.id)).status).toMatch(/completed_with_failures|failed/);
      // Without the step's abort signal the crawl kept fetching and storing pages after it was
      // recorded as failed (and even after the scan finished).
      const after = await pageCount(queued.id);
      await delay(4_500);
      expect(await pageCount(queued.id)).toBe(after);
      // Grounding still ran on what was stored: every finding belongs to an issue.
      const orphans = await db().execute<{ n: number }>(sql`
          select count(*)::int as n from raw_finding f
          where f.scan_id = ${queued.id}
            and not exists (select 1 from issue_finding i where i.raw_finding_id = f.id)`);
      expect(orphans.rows[0]!.n).toBe(0);
    } finally {
      await site.close();
    }
  }, 120_000);

  it("a worker shutdown stops the scan and records it as interrupted, keeping what it stored", async () => {
    const site = await startSlowSite(1_500);
    try {
      const project = await newProject(site.url);
      const queued = await queue(project.id, snapshotFor(site.url));
      const claimed = (await pipelineRepo.claimNextScan(db(), "t#1"))!;
      const shutdown = new AbortController();
      const run = runScan(runtime(site.port, { shutdown: shutdown.signal }), claimed);
      // Wait until the crawl is under way, then shut down.
      for (let i = 0; i < 100 && (await stepsOf(queued.id)).crawl?.status !== "running"; i++)
        await delay(100);
      shutdown.abort();
      await run;

      const row = await scanRow(queued.id);
      expect(row).toMatchObject({
        status: "failed",
        error: expect.stringMatching(/worker was shut down/),
      });
      const steps = await stepsOf(queued.id);
      expect(steps.preflight!.status).toBe("completed");
      expect(steps.crawl).toMatchObject({
        status: "failed",
        error: expect.stringMatching(/Interrupted: the worker was shut down/),
      });
      for (const key of ["capture", "seo", "grounding"])
        expect(steps[key]).toMatchObject({
          status: "skipped",
          statusReason: expect.stringMatching(/worker was shut down/),
        });
    } finally {
      await site.close();
    }
  }, 120_000);

  it("a scan recovered elsewhere is never overwritten by its original worker", async () => {
    const site = await startSlowSite(1_500);
    try {
      const project = await newProject(site.url);
      const queued = await queue(project.id, snapshotFor(site.url));
      const claimed = (await pipelineRepo.claimNextScan(db(), "t#1"))!;
      const run = runScan(runtime(site.port), claimed);
      for (let i = 0; i < 100 && (await stepsOf(queued.id)).crawl?.status !== "running"; i++)
        await delay(100);
      // Another worker recovered it (e.g. after this worker lost the database for minutes).
      await db()
        .update(schema.scan)
        .set({ status: "failed", error: "recovered elsewhere", finishedAt: sql`now()` })
        .where(and(eq(schema.scan.id, queued.id), eq(schema.scan.status, "running")));
      await run;
      expect(await scanRow(queued.id)).toMatchObject({
        status: "failed",
        error: "recovered elsewhere",
      });
      const steps = await stepsOf(queued.id);
      expect(steps.capture!.status).toBe("pending");
      expect(steps.seo!.status).toBe("pending");
    } finally {
      await site.close();
    }
  }, 120_000);

  it("the worker loop stops taking scans on shutdown and records running ones as interrupted", async () => {
    const site = await startSlowSite(1_500);
    try {
      const project = await newProject(site.url);
      const queued = await queue(project.id, snapshotFor(site.url));
      const worker = await startScanWorker(runtime(site.port), process.env.TEST_DATABASE_URL!, {
        concurrency: 1,
        recoveryIntervalMs: 60_000,
      });
      for (let i = 0; i < 100 && (await stepsOf(queued.id)).crawl?.status !== "running"; i++)
        await delay(100);
      expect(worker.currentScanIds()).toEqual([queued.id]);
      // Another project's scan queued meanwhile must not be picked up any more.
      const other = await newProject(site.url);
      const waiting = await queue(other.id, snapshotFor(site.url));
      const started = Date.now();
      await worker.stop({ graceMs: 300 });
      expect(Date.now() - started).toBeLessThan(45_000);
      expect(await scanRow(queued.id)).toMatchObject({
        status: "failed",
        error: expect.stringMatching(/worker was shut down/),
      });
      expect((await scanRow(waiting.id)).status).toBe("queued");
    } finally {
      await site.close();
    }
  }, 120_000);
});
