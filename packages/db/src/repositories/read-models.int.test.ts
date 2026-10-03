import { defaultScanDefaults } from "@qa/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestUser, hasTestDb, resetDatabase } from "../../../../tests/setup/db";
import { closeDb, getDb } from "../client";
import { issueTrack, page, rawFinding, report, scan, scannerRun } from "../schema";
import { getDashboardSummary } from "./dashboard";
import { listIssueCategories, listIssues } from "./issues";
import { listPagesForScan } from "./pages";
import { createProject } from "./projects";
import { addFigmaReference, listReferenceSources } from "./references";
import { listReports } from "./reports";
import { getLatestScan, listScans } from "./scans";

// Rows inserted here are test fixtures in the _test database, used to verify the queries.
describe.skipIf(!hasTestDb)("read models (real PostgreSQL)", () => {
  const db = () => getDb();
  let ownerId: string;
  let strangerId: string;
  let projectId: string;
  let scan2Id: string;
  let homePageId: string;

  beforeAll(async () => {
    await resetDatabase();
    ownerId = (await createTestUser("Owner")).id;
    strangerId = (await createTestUser("Stranger")).id;
    const p = await createProject(db(), ownerId, {
      name: "Shop",
      websiteUrl: "https://shop.example.com/",
      scanDefaults: defaultScanDefaults(),
    });
    projectId = p.id;

    const [s1] = await db()
      .insert(scan)
      .values({
        projectId,
        number: 1,
        status: "completed",
        configSnapshot: {},
        createdAt: new Date("2026-09-28T10:00:00Z"),
      })
      .returning();
    const [s2] = await db()
      .insert(scan)
      .values({
        projectId,
        number: 2,
        status: "completed_with_failures",
        configSnapshot: {},
        createdAt: new Date("2026-10-01T10:00:00Z"),
      })
      .returning();
    scan2Id = s2!.id;

    const runs = await db()
      .insert(scannerRun)
      .values([
        { scanId: scan2Id, stepKey: "seo", position: 2, status: "completed", findingCount: 2 },
        {
          scanId: scan2Id,
          stepKey: "accessibility",
          position: 1,
          status: "completed",
          findingCount: 1,
        },
        {
          scanId: scan2Id,
          stepKey: "performance",
          position: 3,
          status: "failed",
          error: "Lighthouse timed out",
        },
        { scanId: s1!.id, stepKey: "seo", position: 1, status: "completed", findingCount: 5 },
      ])
      .returning();
    const seoRun = runs.find((r) => r.stepKey === "seo" && r.scanId === scan2Id)!;
    const a11yRun = runs.find((r) => r.stepKey === "accessibility")!;

    const pages = await db()
      .insert(page)
      .values([
        {
          scanId: scan2Id,
          url: "https://shop.example.com/",
          normalizedUrl: "https://shop.example.com/",
          depth: 0,
          httpStatus: 200,
          title: "Home",
        },
        {
          scanId: scan2Id,
          url: "https://shop.example.com/about",
          normalizedUrl: "https://shop.example.com/about",
          depth: 1,
          httpStatus: 404,
        },
      ])
      .returning();
    homePageId = pages.find((x) => x.depth === 0)!.id;

    const finding = (displayId: string, runId: string, category: string) => ({
      scanId: scan2Id,
      scannerRunId: runId,
      pageId: homePageId,
      displayId,
      scanner: category,
      ruleId: `${category}-rule`,
      category,
      title: "t",
      message: "m",
      proposedSeverity: "medium" as const,
      verdict: "confirmed" as const,
      confidence: 1,
      fingerprint: displayId,
    });
    await db()
      .insert(rawFinding)
      .values([
        finding("SEO-001", seoRun.id, "seo"),
        finding("SEO-002", seoRun.id, "seo"),
        finding("A11Y-001", a11yRun.id, "accessibility"),
      ]);

    const track = (
      n: number,
      title: string,
      severity: "critical" | "high" | "low",
      status: "open" | "resolved" | "in_progress",
      category: string,
      updatedAt: string,
    ) => ({
      projectId,
      displayNo: n,
      fingerprint: `fp${n}`,
      title,
      severity,
      status,
      category,
      updatedAt: new Date(updatedAt),
    });
    await db()
      .insert(issueTrack)
      .values([
        track(1, "Missing meta description", "low", "open", "seo", "2026-10-01T10:00:00Z"),
        track(
          2,
          "Image without alt text",
          "critical",
          "open",
          "accessibility",
          "2026-09-30T10:00:00Z",
        ),
        track(3, "Duplicate title", "high", "resolved", "seo", "2026-10-02T10:00:00Z"),
        track(
          4,
          "Low contrast 100% text",
          "high",
          "in_progress",
          "accessibility",
          "2026-09-29T10:00:00Z",
        ),
      ]);
    await db()
      .insert(report)
      .values({ scanId: scan2Id, format: "pdf", status: "completed", sizeBytes: 1234 });
  });
  afterAll(() => closeDb());

  it("dashboard aggregates counts and the latest scan's steps in pipeline order", async () => {
    const d = await getDashboardSummary(db(), ownerId);
    expect(d.projectCount).toBe(1);
    expect(d.issueCounts).toMatchObject({
      total: 4,
      open: 2,
      inProgress: 1,
      resolved: 1,
      critical: 1,
      high: 1,
      low: 1,
    });
    expect(d.recentScans.map((s) => s.number)).toEqual([2, 1]);
    expect(d.latestScan).toMatchObject({ number: 2, findingCount: 3, failedSteps: 1 });
    expect(d.latestScan!.runs.map((r) => r.stepKey)).toEqual([
      "accessibility",
      "seo",
      "performance",
    ]);
  });

  it("returns nothing to another user", async () => {
    const d = await getDashboardSummary(db(), strangerId);
    expect(d).toMatchObject({ projectCount: 0, recentScans: [], latestScan: null });
    expect(d.issueCounts.total).toBe(0);
    expect((await listIssues(db(), strangerId, { page: 1, pageSize: 20 })).total).toBe(0);
    expect(await listPagesForScan(db(), strangerId, scan2Id)).toEqual([]);
    expect((await listReports(db(), strangerId, { page: 1, pageSize: 20 })).total).toBe(0);
    expect(await getLatestScan(db(), strangerId, projectId)).toBeNull();
    expect((await listScans(db(), strangerId, { page: 1, pageSize: 20 })).total).toBe(0);
  });

  it("filters, searches and sorts issues", async () => {
    const all = await listIssues(db(), ownerId, { page: 1, pageSize: 20 });
    expect(all.items.map((i) => i.displayNo)).toEqual([2, 3, 4, 1]); // severity, then most recent

    const open = await listIssues(db(), ownerId, {
      statuses: ["open", "in_progress"],
      page: 1,
      pageSize: 20,
    });
    expect(open.items.map((i) => i.displayNo).sort()).toEqual([1, 2, 4]);

    const seoHigh = await listIssues(db(), ownerId, {
      category: "seo",
      severities: ["high"],
      page: 1,
      pageSize: 20,
    });
    expect(seoHigh.items.map((i) => i.displayNo)).toEqual([3]);

    expect(
      (await listIssues(db(), ownerId, { q: "alt text", page: 1, pageSize: 20 })).items[0]
        ?.displayNo,
    ).toBe(2);
    expect(
      (await listIssues(db(), ownerId, { q: "ISSUE-4", page: 1, pageSize: 20 })).items[0]
        ?.displayNo,
    ).toBe(4);
    expect(
      (await listIssues(db(), ownerId, { q: "100%", page: 1, pageSize: 20 })).items.map(
        (i) => i.displayNo,
      ),
    ).toEqual([4]);

    const byDate = await listIssues(db(), ownerId, { sort: "date", page: 1, pageSize: 20 });
    expect(byDate.items.map((i) => i.displayNo)).toEqual([3, 1, 2, 4]);

    expect(await listIssueCategories(db(), ownerId)).toEqual(["accessibility", "seo"]);
  });

  it("lists pages with per-category finding counts", async () => {
    const pages = await listPagesForScan(db(), ownerId, scan2Id);
    expect(pages.map((p) => p.httpStatus)).toEqual([200, 404]);
    expect(pages[0]!.findingsByCategory).toEqual({ seo: 2, accessibility: 1 });
    expect(pages[1]!.findingsByCategory).toEqual({});
  });

  it("returns the latest scan for a project and lists reports", async () => {
    const latest = await getLatestScan(db(), ownerId, projectId);
    expect(latest?.number).toBe(2);
    const reports = await listReports(db(), ownerId, { projectId, page: 1, pageSize: 20 });
    expect(reports.items[0]).toMatchObject({ format: "pdf", scanNumber: 2, projectName: "Shop" });
  });

  it("stores Figma references as pending (nothing fetched yet)", async () => {
    await addFigmaReference(db(), projectId, {
      figmaUrl: "https://www.figma.com/design/AbCdEf123456/Site",
      figmaFileKey: "AbCdEf123456",
      figmaNodeIds: ["1:2"],
    });
    const refs = await listReferenceSources(db(), projectId);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      kind: "figma",
      status: "pending",
      figmaFileKey: "AbCdEf123456",
      fetchedAt: null,
    });
  });
});
