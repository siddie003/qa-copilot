import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createLogger,
  defaultScanDefaults,
  parseConfig,
  planScanSteps,
  type ScanAuth,
  type ScanConfigSnapshot,
} from "@qa/core";
import { closeDb, getDb, pipelineRepo, projectsRepo, schema, secretsRepo } from "@qa/db";
import { encryptSecret, type Resolver } from "@qa/security";
import { createLocalStorage } from "@qa/storage";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  HERO_PNG_BYTES,
  MEMBERS_PASSWORD,
  MEMBERS_USER,
  startDemoSite,
} from "../../../../fixtures/demo-site/server.mjs";
import { createTestUser, hasTestDb, resetDatabase } from "../../../../tests/setup/db";
import { runScan, type ScanRuntime } from "./run-scan";

// Deterministic DNS: only localhost exists, so external links never touch the internet.
const offlineDns: Resolver = async (host) => {
  if (host === "localhost") return [{ address: "127.0.0.1", family: 4 }];
  throw Object.assign(new Error(`${host} not found`), { code: "ENOTFOUND" });
};
const ENCRYPTION_KEY = "ab".repeat(32);

// Full pipeline: real test database, local fixture website, real Chromium and all six scanners.
describe.skipIf(!hasTestDb)("scan pipeline (preflight → crawl → capture → scanners)", () => {
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
      ENCRYPTION_KEY,
      SCAN_ALLOWED_PRIVATE_HOSTS: `localhost:${site.port}`,
      LINK_CHECK_RETRIES: "1",
      SCAN_SCANNER_TIMEOUT_MS: "240000",
    });
    rt = {
      db: getDb(),
      storage: createLocalStorage(storageDir),
      config,
      log: createLogger(),
      heartbeatMs: 200,
      resolve: offlineDns,
    };
    ownerId = (await createTestUser()).id;
  }, 60_000);
  afterAll(async () => {
    await site?.close();
    await rm(storageDir, { recursive: true, force: true });
    await closeDb();
  });

  async function queueScan(
    websiteUrl: string,
    overrides: Partial<ScanConfigSnapshot> = {},
    credentials?: ScanAuth,
  ) {
    const defaults = defaultScanDefaults();
    const project = await projectsRepo.createProject(getDb(), ownerId, {
      name: `Fixture ${Date.now()}`,
      websiteUrl,
      scanDefaults: defaults,
    });
    if (credentials)
      await secretsRepo.setProjectSecret(
        getDb(),
        project.id,
        secretsRepo.SCAN_AUTH_KIND,
        encryptSecret(JSON.stringify(credentials), ENCRYPTION_KEY, project.id),
        { type: credentials.type },
      );
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
      authType: credentials?.type ?? null,
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
  const pagesOf = async (scanId: string) =>
    new Map(
      (await getDb().select().from(schema.page).where(eq(schema.page.scanId, scanId))).map((p) => [
        new URL(p.url).pathname,
        p,
      ]),
    );

  it("crawls, captures and runs all six scanners on the fixture site", async () => {
    const queued = await queueScan(site.url);
    const claimed = await pipelineRepo.claimNextScan(getDb(), "test-worker");
    expect(claimed?.id).toBe(queued.id);
    expect(await pipelineRepo.claimNextScan(getDb(), "other-worker")).toBeNull();

    await runScan(rt, claimed!);

    const detail = await pipelineRepo.getScanDetail(getDb(), ownerId, queued.id);
    expect(detail!.status).toBe("completed");
    const steps = await stepsOf(queued.id);
    expect(steps.preflight!.statusReason).toMatch(
      /Reachable: HTTP 200.*technology: could not determine.*robots.txt: found/,
    );
    expect(steps.crawl!.statusReason).toMatch(
      /18 pages fetched; 3 returned an error.*; 1 skipped \(robots.txt\)/,
    );
    expect(steps.capture!.statusReason).toMatch(
      /39 of 39 page captures succeeded \(2 redirecting URLs not captured twice\)/,
    );
    for (const key of ["accessibility", "security", "seo", "links", "performance", "responsive"]) {
      expect(steps[key], key).toMatchObject({ status: "completed" });
      expect(steps[key]!.findingCount, key).toBeGreaterThan(0);
      expect(steps[key]!.toolName, key).toBeTruthy();
      expect(steps[key]!.checks, key).toMatchObject({ evaluated: expect.any(Number) });
    }
    expect(steps.ai).toMatchObject({
      status: "skipped",
      statusReason: expect.stringMatching(/Phase 7/),
    });

    const pages = await pagesOf(queued.id);
    expect(pages.size).toBe(19);
    expect(pages.get("/members")!.httpStatus).toBe(401);
    expect(pages.get("/private/secret")!.crawlError).toBe("Not crawled: disallowed by robots.txt");
    expect(pages.get("/chain-start")!.redirectChain).toHaveLength(2);

    // Every intentional fixture defect is detected by the responsible scanner.
    const findings = (await pipelineRepo.listFindingsForScan(getDb(), ownerId, queued.id))!;
    const has = (scanner: string, ruleId: string, pathname?: string) =>
      findings.some(
        (f) =>
          f.scanner === scanner &&
          f.ruleId === ruleId &&
          (pathname === undefined || (f.pageUrl && new URL(f.pageUrl).pathname === pathname)),
      );
    const expected: Array<[string, string, string?]> = [
      ["accessibility", "image-alt", "/about"],
      ["accessibility", "label", "/contact"],
      ["accessibility", "button-name", "/contact"],
      ["accessibility", "color-contrast", "/products"],
      ["accessibility", "heading-order", "/blog/post-2"],
      ["security", "https-not-used"],
      ["security", "csp-missing"],
      ["security", "frame-protection-missing"],
      ["security", "server-version-disclosure"],
      ["security", "cookie-flags"],
      ["security", "exposed-secret-aws-access-key", "/"],
      ["seo", "meta-description-missing", "/about"],
      ["seo", "title-duplicate"],
      ["seo", "h1-multiple", "/blog/post-2"],
      ["seo", "structured-data-invalid", "/"],
      ["seo", "sitemap-not-found"],
      ["links", "broken-internal-link"],
      ["links", "broken-external-link"],
      ["links", "redirect-chain"],
      ["links", "failed-resource", "/products/gadget"],
      ["performance", "ttfb-slow", "/slow"],
      ["performance", "image-large"],
      ["performance", "render-blocking-resource"],
      ["responsive", "horizontal-overflow", "/wide"],
      ["responsive", "text-clipped", "/wide"],
      ["responsive", "tap-target-small", "/contact"],
      ["responsive", "interactive-overlap", "/contact"],
    ];
    for (const [scanner, ruleId, pathname] of expected)
      expect(has(scanner, ruleId, pathname), `${scanner}/${ruleId} ${pathname ?? ""}`).toBe(true);

    // Redirecting URLs are not analyzed twice.
    expect(findings.some((f) => f.pageUrl && /old-page|chain-start/.test(f.pageUrl))).toBe(false);
    expect(findings.filter((f) => f.ruleId === "title-duplicate")).toHaveLength(1);
    // Every finding has evidence, a display id and a stored fingerprint.
    expect(
      findings.every((f) => f.evidence.length > 0 && /^[A-Z0-9]+-\d{3}$/.test(f.displayId)),
    ).toBe(true);
    // The members area (401 without credentials) is inconclusive, not "broken".
    expect(
      findings.some(
        (f) => f.ruleId.startsWith("broken") && /members/.test(JSON.stringify(f.evidence)),
      ),
    ).toBe(false);
    expect(JSON.stringify(steps.links!.checks)).toMatch(/members.*HTTP 401/);

    // Capture measurements are stored.
    const homeCapture = (
      await getDb()
        .select()
        .from(schema.pageCapture)
        .where(eq(schema.pageCapture.pageId, pages.get("/")!.id))
    ).find((c) => c.viewport === "desktop")!;
    expect(homeCapture.metrics).toMatchObject({
      vitals: expect.any(Object),
      images: expect.any(Array),
    });
    const requests = await getDb()
      .select()
      .from(schema.networkRequest)
      .where(eq(schema.networkRequest.pageCaptureId, homeCapture.id));
    expect(requests.find((r) => r.url.endsWith("/images/hero.png"))).toMatchObject({
      status: 200,
      decodedSize: HERO_PNG_BYTES,
      resourceType: "image",
      fromCache: null,
    });
  }, 300_000);

  it("scans the login-protected area with site credentials (and reports rejected ones)", async () => {
    const ok = await queueScan(
      `${site.url}members`,
      {
        maxPages: 10,
        maxDepth: 1,
        viewports: [{ name: "desktop", width: 1280, height: 800 }],
        scanners: ["links"],
      },
      { type: "basic", username: MEMBERS_USER, password: MEMBERS_PASSWORD },
    );
    await runScan(rt, (await pipelineRepo.claimNextScan(getDb(), "w"))!);
    const okSteps = await stepsOf(ok.id);
    expect(okSteps.preflight!.statusReason).toMatch(/site credentials: basic/);
    const okPages = await pagesOf(ok.id);
    expect(okPages.get("/members")!.httpStatus).toBe(200);
    expect(okPages.get("/members/profile")!.httpStatus).toBe(200);
    expect(okSteps.capture!.status).toBe("completed");

    const bad = await queueScan(
      `${site.url}members`,
      {
        maxPages: 10,
        maxDepth: 1,
        viewports: [{ name: "desktop", width: 1280, height: 800 }],
        scanners: ["links"],
      },
      { type: "basic", username: MEMBERS_USER, password: "wrong" },
    );
    await runScan(rt, (await pipelineRepo.claimNextScan(getDb(), "w"))!);
    const badSteps = await stepsOf(bad.id);
    expect(badSteps.preflight).toMatchObject({
      status: "inconclusive",
      statusReason: expect.stringMatching(/even with the configured basic credentials/),
    });
    expect((await pipelineRepo.getScanDetail(getDb(), ownerId, bad.id))!.status).toBe("failed");
  }, 180_000);

  it("fails clearly when credentials were removed after queueing", async () => {
    const queued = await queueScan(
      site.url,
      { scanners: ["seo"] },
      { type: "header", name: "X-Key", value: "k" },
    );
    await secretsRepo.deleteProjectSecret(
      getDb(),
      (await pipelineRepo.getScanDetail(getDb(), ownerId, queued.id))!.projectId,
      secretsRepo.SCAN_AUTH_KIND,
    );
    await runScan(rt, (await pipelineRepo.claimNextScan(getDb(), "w"))!);
    const steps = await stepsOf(queued.id);
    expect(steps.preflight).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/removed after this scan was queued/),
    });
    expect(steps.seo!.status).toBe("skipped");
  }, 60_000);

  it("respects page limits and ignores robots.txt when configured", async () => {
    const queued = await queueScan(site.url, {
      maxPages: 3,
      respectRobots: false,
      viewports: [{ name: "desktop", width: 1280, height: 800 }],
      scanners: ["seo"],
    });
    await runScan(rt, (await pipelineRepo.claimNextScan(getDb(), "test-worker"))!);
    const steps = await stepsOf(queued.id);
    expect(steps.crawl!.statusReason).toMatch(/3 pages fetched.*page limit of 3 reached/);
    expect(steps.preflight!.statusReason).toMatch(/robots.txt: ignored/);
    expect(steps.links).toBeUndefined(); // scanners not selected get no pipeline step at all
  }, 120_000);

  it("fails clearly when the website is unreachable and skips the rest", async () => {
    const queued = await queueScan(`http://localhost:${site.port}/`);
    await site.close();
    try {
      await runScan(rt, (await pipelineRepo.claimNextScan(getDb(), "test-worker"))!);
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
      expect(steps.accessibility!.status).toBe("skipped");
    } finally {
      site = await startDemoSite(site.port);
    }
  }, 60_000);

  it("refuses public hostnames that resolve to internal addresses", async () => {
    const queued = await queueScan("https://internal-alias.example/");
    await runScan(
      { ...rt, resolve: async () => [{ address: "10.1.2.3", family: 4 }] },
      (await pipelineRepo.claimNextScan(getDb(), "test-worker"))!,
    );
    const steps = await stepsOf(queued.id);
    expect(steps.preflight).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/Blocked for safety: .*10\.1\.2\.3/),
    });
  }, 60_000);

  it("cancels a running scan", async () => {
    const queued = await queueScan(site.url);
    const claimed = await pipelineRepo.claimNextScan(getDb(), "test-worker");
    expect(await pipelineRepo.requestCancel(getDb(), ownerId, queued.id)).toMatchObject({
      previousStatus: "running",
    });
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
    expect(await pipelineRepo.getScanDetail(getDb(), ownerId, orphan.id)).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/worker stopped/),
    });
  }, 60_000);
});
