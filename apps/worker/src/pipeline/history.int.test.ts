import type { LookupAddress } from "node:dns";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NoAIProvider } from "@qa/ai";
import {
  compareScans,
  createLogger,
  defaultScanDefaults,
  parseConfig,
  planScanSteps,
  type IssueComparisonItem,
  type ScanComparisonResult,
  type ScanConfigSnapshot,
} from "@qa/core";
import {
  closeDb,
  comparisonsRepo,
  getDb,
  issuesRepo,
  pipelineRepo,
  projectsRepo,
  schema,
} from "@qa/db";
import { createLocalStorage, type Storage } from "@qa/storage";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDemoSite } from "../../../../fixtures/demo-site/server.mjs";
import { createTestUser, hasTestDb, resetDatabase } from "../../../../tests/setup/db";
import { runScan } from "./run-scan";

/**
 * Phase 9 exit criterion: comparison results verified on real scans of the fixture site, which
 * changes between scans (fixture variant v1 → v2 → v1; see fixtures/demo-site/README.md).
 * Real crawl, real Chromium capture and real scanners; no AI provider.
 */

const SCANNERS = ["accessibility", "seo", "links", "responsive"] as const;

// Offline resolver: only the fixture resolves, so results never depend on the internet.
const resolve = async (host: string): Promise<LookupAddress[]> => {
  if (host === "localhost" || host === "127.0.0.1") return [{ address: "127.0.0.1", family: 4 }];
  throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
};

describe.skipIf(!hasTestDb)("scan comparison on real fixture scans (v1 → v2 → v1)", () => {
  const db = () => getDb();
  let site: Awaited<ReturnType<typeof startDemoSite>>;
  let storageDir: string;
  let storage: Storage;
  let ownerId: string;
  let projectId: string;
  const scans: string[] = [];

  async function scanFixture() {
    const snapshot: ScanConfigSnapshot = {
      websiteUrl: site.url,
      scanners: [...SCANNERS],
      viewports: [
        { name: "desktop", width: 1440, height: 900 },
        { name: "mobile", width: 390, height: 844 },
      ],
      maxPages: 25,
      maxDepth: 3,
      respectRobots: true,
      pageTimeoutMs: 15_000,
      concurrency: 3,
      userAgent: "QACopilotTest/1.0",
      authorizationAttestedAt: new Date().toISOString(),
      authType: null,
      designSpecVersion: null,
      contentDocuments: [],
    };
    await pipelineRepo.createScan(db(), ownerId, projectId, {
      configSnapshot: snapshot as unknown as Record<string, unknown>,
      steps: planScanSteps([...SCANNERS]),
      triggeredByUserId: ownerId,
    });
    const claimed = (await pipelineRepo.claimNextScan(db(), "history-test"))!;
    await runScan(
      {
        db: db(),
        storage,
        log: createLogger(),
        resolve,
        ai: new NoAIProvider(),
        config: parseConfig({
          DATABASE_URL: process.env.TEST_DATABASE_URL,
          BETTER_AUTH_SECRET: "integration-test-secret-0123456789abcdef",
          SCAN_ALLOWED_PRIVATE_HOSTS: `localhost:${site.port}`,
          SCAN_SCANNER_TIMEOUT_MS: "120000",
        }),
      },
      claimed,
    );
    const [row] = await db().select().from(schema.scan).where(eq(schema.scan.id, claimed.id));
    expect(row!.status).toBe("completed");
    scans.push(claimed.id);
    return claimed.id;
  }

  /** Same computation as GET /api/v1/projects/:id/comparisons (records → compareScans). */
  async function compare(baseId: string, targetId: string): Promise<ScanComparisonResult> {
    const [b, t] = await Promise.all([
      comparisonsRepo.loadComparisonScan(db(), baseId),
      comparisonsRepo.loadComparisonScan(db(), targetId),
    ]);
    const trackIds = [...new Set([...b!.issues, ...t!.issues].map((i) => i.trackId))];
    return compareScans(b!, t!, await comparisonsRepo.loadComparisonTracks(db(), trackIds, b!, t!));
  }

  const rule = (r: ScanComparisonResult, source: string, ruleId: string) => {
    const item = r.issues.find((i) => i.source === source && i.ruleId === ruleId);
    expect(item, `${source}/${ruleId}`).toBeDefined();
    return item!;
  };
  const describeItem = (i: IssueComparisonItem) =>
    `${i.source}/${i.ruleId}: ${i.category} – ${i.reason}`;
  const findingPaths = (i: IssueComparisonItem, side: "base" | "target") =>
    i.findings
      .map((f) => f[side]?.pageUrl)
      .filter((u): u is string => !!u)
      .map((u) => new URL(u).pathname);

  beforeAll(async () => {
    await resetDatabase();
    site = await startDemoSite(0, { variant: "v1" });
    storageDir = await mkdtemp(path.join(os.tmpdir(), "qa-history-"));
    storage = createLocalStorage(storageDir);
    ownerId = (await createTestUser("History owner")).id;
    projectId = (
      await projectsRepo.createProject(db(), ownerId, {
        name: "History fixture",
        websiteUrl: site.url,
        scanDefaults: defaultScanDefaults(),
      })
    ).id;
  }, 60_000);

  afterAll(async () => {
    await site?.close();
    if (storageDir) await rm(storageDir, { recursive: true, force: true });
    await closeDb();
  });

  it("v1 → v2: fixes are resolved, the new defect is new, the failing page is not rechecked", async () => {
    const scan1 = await scanFixture();
    // A user marks the double-H1 issue on /blog/post-2 as fixed; v2 still has it.
    const [h1Multiple] = await db()
      .select()
      .from(schema.issueTrack)
      .innerJoin(schema.issue, eq(schema.issue.trackId, schema.issueTrack.id))
      .where(and(eq(schema.issue.scanId, scan1), eq(schema.issue.ruleId, "h1-multiple")));
    expect(h1Multiple).toBeDefined();
    const changed = await issuesRepo.changeIssueStatus(
      db(),
      ownerId,
      [h1Multiple!.issue_track.id],
      {
        status: "resolved",
        note: "Fixed in the v2 release",
        userId: ownerId,
      },
    );
    expect(changed.ok).toBe(true);

    site.setVariant("v2");
    const scan2 = await scanFixture();
    const r = await compare(scan1, scan2);
    const report = r.issues
      .filter((i) => i.category !== "persistent")
      .map(describeItem)
      .join("\n");
    expect(r.comparable, report).toBe(true);

    // Fixed in v2 and re-checked on the same pages → resolved.
    for (const [source, id] of [
      ["seo", "meta-description-missing"],
      ["seo", "structured-data-invalid"],
      ["seo", "img-alt-attribute-missing"],
      ["accessibility", "image-alt"],
    ])
      expect(rule(r, source!, id!).category, report).toBe("resolved");
    // New defect in v2 (no H1 on /blog/post-1) → new; every new issue is on that page.
    expect(rule(r, "seo", "h1-missing").category, report).toBe("new");
    for (const i of r.issues.filter((x) => x.category === "new"))
      expect(findingPaths(i, "target"), describeItem(i)).toEqual(
        findingPaths(i, "target").map(() => "/blog/post-1"),
      );
    // Marked resolved but found again → reopened (status and audit event).
    const reopened = rule(r, "seo", "h1-multiple");
    expect(reopened).toMatchObject({ category: "reopened", trackStatus: "reopened" });
    const events = await db()
      .select()
      .from(schema.issueStatusEvent)
      .where(eq(schema.issueStatusEvent.trackId, h1Multiple!.issue_track.id));
    expect(events.some((e) => e.toStatus === "reopened" && e.scanId === scan2 && !e.userId)).toBe(
      true,
    );
    // /wide answers HTTP 500 in v2: its clipped-text issue is not rechecked, never resolved.
    const clipped = rule(r, "responsive", "text-clipped");
    expect(clipped.category).toBe("not_rechecked");
    expect(clipped.reason).toContain("/wide could not be analyzed in scan #2 (HTTP 500)");
    for (const i of r.issues.filter((x) => x.category === "resolved"))
      expect(findingPaths(i, "base"), describeItem(i)).not.toContain("/wide");
    // The link to /wide is now broken: the link issue gained a finding.
    const links = r.issues.filter((i) => i.source === "links" && i.category === "changed");
    expect(links.length, report).toBeGreaterThan(0);
    expect(links.some((i) => i.findingCounts.new > 0)).toBe(true);
    // Nothing else changed between the two scans (results are deterministic).
    for (const i of r.issues.filter((x) => x.category === "changed"))
      expect(i.source, describeItem(i)).toBe("links");
    // Counts are the per-category totals of the listed issues.
    for (const [category, n] of Object.entries(r.summary.counts))
      expect(r.issues.filter((i) => i.category === category).length).toBe(n);
    expect(r.summary.counts.resolved).toBeGreaterThanOrEqual(4);
    expect(r.summary.counts.newly_checked).toBe(0);
  }, 300_000);

  it("v2 → v1: fixes that came back are reopened, the v2 defect is resolved, /wide is newly checked", async () => {
    site.setVariant("v1");
    const [scan1, scan2] = scans;
    const scan3 = await scanFixture();
    const r = await compare(scan2!, scan3);
    const report = r.issues
      .filter((i) => i.category !== "persistent")
      .map(describeItem)
      .join("\n");
    for (const [source, id] of [
      ["seo", "meta-description-missing"],
      ["seo", "structured-data-invalid"],
      ["accessibility", "image-alt"],
    ])
      expect(rule(r, source!, id!), report).toMatchObject({
        category: "reopened",
        reason: "Found in scan #1, not found by scan #2, and found again by scan #3.",
      });
    expect(rule(r, "seo", "h1-missing").category, report).toBe("resolved");
    // Scan 2 could not analyze /wide, so its issue is newly checked, not new or reopened.
    const clipped = rule(r, "responsive", "text-clipped");
    expect(clipped.category).toBe("newly_checked");
    expect(clipped.reason).toContain("/wide could not be analyzed in scan #2");
    // Still reopened from scan 2 (no user change since): persistent now.
    expect(rule(r, "seo", "h1-multiple")).toMatchObject({
      category: "persistent",
      trackStatus: "reopened",
    });

    // Same site version (v1 vs v1): nothing new, resolved, reopened or changed.
    const same = await compare(scan1!, scan3);
    const sameReport = same.issues
      .filter((i) => i.category !== "persistent")
      .map(describeItem)
      .join("\n");
    expect(same.summary.counts, sameReport).toMatchObject({
      new: 0,
      reopened: 0,
      changed: 0,
      resolved: 0,
      not_rechecked: 0,
      newly_checked: 0,
    });
    expect(same.summary.counts.persistent).toBe(same.summary.baseIssues);
  }, 300_000);
});
