import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NoAIProvider } from "@qa/ai";
import { createLogger, defaultScanDefaults, parseConfig, planScanSteps } from "@qa/core";
import {
  closeDb,
  getDb,
  issuesRepo,
  pipelineRepo,
  projectsRepo,
  reportsRepo,
  schema,
} from "@qa/db";
import type { ReportData } from "@qa/reports";
import { createLocalStorage, type Storage } from "@qa/storage";
import { and, asc, eq } from "drizzle-orm";
import { extractText, getDocumentProxy } from "unpdf";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestUser, hasTestDb, resetDatabase } from "../../../../tests/setup/db";
import { groundingStep } from "../pipeline/issue-steps";
import { processNextReport, reportStorageKey } from "./generate";

type NewFinding = pipelineRepo.NewFinding;

const SITE = "http://localhost:4100";
const config = parseConfig({
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  BETTER_AUTH_SECRET: "integration-test-secret-0123456789abcdef",
});
const NOW = new Date("2026-10-05T12:00:00Z");

const f = (p: Partial<NewFinding> & Pick<NewFinding, "ruleId" | "title">): NewFinding => ({
  message: `${p.title}.`,
  category: "seo",
  subcategory: null,
  pageId: null,
  locationKey: "site",
  selector: null,
  viewport: null,
  severity: "medium",
  verdict: "confirmed",
  confidence: 0.95,
  expected: null,
  actual: null,
  fingerprintKey: null,
  evidence: [{ kind: "document", data: { note: "observed" } }],
  ...p,
});

describe.skipIf(!hasTestDb)("report generation from stored scan data (real PostgreSQL)", () => {
  const db = () => getDb();
  let ownerId: string;
  let projectId: string;
  let scanId: string;
  let storageDir: string;
  let storage: Storage;
  const rt = () => ({ db: db(), storage, log: createLogger(), now: () => NOW });

  async function newScan(findings: Record<string, NewFinding[]>) {
    const scan = (await pipelineRepo.createScan(db(), ownerId, projectId, {
      configSnapshot: {
        websiteUrl: SITE,
        scanners: ["accessibility", "seo", "links", "performance"],
        viewports: [{ name: "desktop", width: 1440, height: 900 }],
        maxPages: 10,
        maxDepth: 2,
        respectRobots: true,
      },
      steps: planScanSteps(["accessibility", "seo", "links", "performance"]),
      triggeredByUserId: ownerId,
    }))!;
    const pageId = (await pipelineRepo.insertPage(db(), scan.id, {
      url: `${SITE}/products`,
      normalizedUrl: `${SITE}/products`,
      finalUrl: null,
      httpStatus: 200,
      redirectChain: null,
      depth: 1,
      discoveredFrom: null,
      title: "Products",
      contentType: "text/html",
      responseHeaders: null,
      rawHtmlKey: null,
      crawlError: null,
    }))!;
    const prefix: Record<string, string> = { accessibility: "A11Y", seo: "SEO" };
    for (const [scanner, list] of Object.entries(findings))
      await pipelineRepo.insertFindings(
        db(),
        scan.id,
        scanner,
        prefix[scanner]!,
        list.map((x) => ({
          ...x,
          category: scanner,
          pageId: x.locationKey === "/products" ? pageId : null,
        })),
      );
    return scan.id;
  }

  const read = async (format: "json" | "md" | "pdf") => {
    const [row] = await db()
      .select()
      .from(schema.report)
      .where(and(eq(schema.report.scanId, scanId), eq(schema.report.format, format)));
    expect(row).toMatchObject({ status: "completed" });
    expect(row!.storageKey).toBe(reportStorageKey(scanId, row!.id, format));
    const body = await storage.read(row!.storageKey!);
    expect(row!.sizeBytes).toBe(body.length);
    return body;
  };

  beforeAll(async () => {
    await resetDatabase();
    storageDir = await mkdtemp(path.join(os.tmpdir(), "qa-reports-"));
    storage = createLocalStorage(storageDir);
    ownerId = (await createTestUser("Owner")).id;
    projectId = (
      await projectsRepo.createProject(db(), ownerId, {
        name: "Report <Fixture> & Co",
        websiteUrl: `${SITE}/`,
        scanDefaults: defaultScanDefaults(),
      })
    ).id;

    scanId = await newScan({
      accessibility: ["p.muted", "span.note"].map((selector) =>
        f({
          ruleId: "color-contrast",
          title: "Elements must meet minimum color contrast ratio thresholds",
          severity: "high",
          locationKey: "/products",
          selector,
          actual: "contrast 1.66 (foreground #c4c4c4, background #ffffff)",
          evidence: [{ kind: "axe_node", data: { ruleId: "color-contrast", target: selector } }],
        }),
      ),
      seo: [
        f({ ruleId: "title-missing", title: "Page has no <title>", locationKey: "/products" }),
        f({
          ruleId: "sitemap-unreachable",
          title: "Sitemap could not be checked",
          verdict: "inconclusive",
          confidence: 0.5,
          severity: "low",
        }),
      ],
    });
    // Issues exactly as the pipeline creates them (no AI provider).
    await groundingStep({
      db: db(),
      log: createLogger(),
      config,
      scanId,
      provider: new NoAIProvider(),
      signal: new AbortController().signal,
      designSpec: null,
      state: { runIds: new Map() },
    });
    await db()
      .update(schema.scannerRun)
      .set({ status: "completed", findingCount: 2 })
      .where(and(eq(schema.scannerRun.scanId, scanId), eq(schema.scannerRun.stepKey, "seo")));
    await db()
      .update(schema.scannerRun)
      .set({ status: "failed", error: "Performance scanner timed out after 120000 ms" })
      .where(
        and(eq(schema.scannerRun.scanId, scanId), eq(schema.scannerRun.stepKey, "performance")),
      );
    await db()
      .update(schema.scannerRun)
      .set({
        status: "inconclusive",
        statusReason: "2 of 9 links could not be checked (HTTP 429)",
        checks: {
          evaluated: 9,
          inconclusive: [
            { check: "link", reason: "HTTP 429 Too Many Requests", pageUrl: `${SITE}/about` },
          ],
          inconclusiveTotal: 2,
        },
      })
      .where(and(eq(schema.scannerRun.scanId, scanId), eq(schema.scannerRun.stepKey, "links")));
    await pipelineRepo.finishScan(db(), scanId, "completed_with_failures");
  });
  afterAll(async () => {
    await closeDb();
    await rm(storageDir, { recursive: true, force: true });
  });

  it("does nothing without queued reports", async () => {
    expect(await processNextReport(rt())).toBe(false);
  });

  it("builds JSON, Markdown and PDF reports from the stored records only", async () => {
    // A user status change before generation is reflected in the report.
    const [track] = await db()
      .select()
      .from(schema.issueTrack)
      .where(eq(schema.issueTrack.title, "Page has no <title>"));
    await issuesRepo.changeIssueStatus(db(), ownerId, [track!.id], {
      status: "in_progress",
      userId: ownerId,
    });
    for (const format of ["json", "md", "pdf"] as const)
      expect(await reportsRepo.createReport(db(), ownerId, scanId, format, ownerId)).toMatchObject({
        kind: "created",
      });
    expect(await processNextReport(rt())).toBe(true);
    expect(await processNextReport(rt())).toBe(true);
    expect(await processNextReport(rt())).toBe(true);
    expect(await processNextReport(rt())).toBe(false);

    const data = JSON.parse((await read("json")).toString("utf8")) as ReportData;
    const issues = await db()
      .select({ displayNo: schema.issueTrack.displayNo, status: schema.issueTrack.status })
      .from(schema.issue)
      .innerJoin(schema.issueTrack, eq(schema.issueTrack.id, schema.issue.trackId))
      .where(eq(schema.issue.scanId, scanId))
      .orderBy(asc(schema.issueTrack.displayNo));
    const findings = await db()
      .select()
      .from(schema.rawFinding)
      .where(eq(schema.rawFinding.scanId, scanId));

    expect(data).toMatchObject({
      format: "qa-copilot-report",
      schemaVersion: 1,
      generatedAt: NOW.toISOString(),
      project: { id: projectId, name: "Report <Fixture> & Co" },
      scan: { id: scanId, number: 1, status: "completed_with_failures", pagesCrawled: 1 },
    });
    // Same issues as the database, with the tracking statuses at generation time.
    expect(data.issues.map((i) => i.id).sort()).toEqual(
      issues.map((i) => `ISSUE-${i.displayNo}`).sort(),
    );
    expect(Object.fromEntries(data.issues.map((i) => [i.id, i.status]))).toEqual(
      Object.fromEntries(issues.map((i) => [`ISSUE-${i.displayNo}`, i.status])),
    );
    expect(data.issues.find((i) => i.title === "Page has no <title>")!.status).toBe("in_progress");
    // Every finding of the scan appears exactly once, and only real findings appear.
    const reported = data.issues.flatMap((i) => i.findings.map((x) => x.id));
    expect(reported.sort()).toEqual(findings.map((x) => x.displayId).sort());
    expect(data.unassignedFindings).toEqual([]);
    expect(data.summary.findings.total).toBe(findings.length);
    // Evidence-based states are kept.
    const sitemap = data.issues.find((i) => i.ruleId === "sitemap-unreachable")!;
    expect(sitemap).toMatchObject({ verdict: "inconclusive", status: "inconclusive" });
    expect(sitemap.description).toMatch(/^Unable to verify from available evidence\./);
    expect(data.summary.steps).toMatchObject({ failed: ["performance"], inconclusive: ["links"] });
    expect(data.steps.find((s) => s.key === "performance")).toMatchObject({
      status: "failed",
      error: "Performance scanner timed out after 120000 ms",
    });
    expect(data.steps.find((s) => s.key === "links")).toMatchObject({
      inconclusiveTotal: 2,
      inconclusiveChecks: [{ check: "link", reason: "HTTP 429 Too Many Requests" }],
    });
    expect(data.summary.ai).toMatchObject({ used: false, requests: 0 });
    const contrast = data.issues.find((i) => i.ruleId === "color-contrast")!;
    expect(contrast.findings[0]!.evidence[0]).toMatchObject({ kind: "axe_node" });

    const md = (await read("md")).toString("utf8");
    for (const i of data.issues) expect(md).toContain(`### ${i.id}: `);
    expect(md).toContain("# QA report: Report &lt;Fixture&gt; &amp; Co · Scan #1");
    expect(md).toContain("| Performance | **Failed** |");
    expect(md).toContain("| Status | In progress |");
    expect(md).toContain(
      "Unable to verify from available evidence. Review manually before acting.",
    );

    const pdf = await read("pdf");
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const { text } = await extractText(await getDocumentProxy(new Uint8Array(pdf)), {
      mergePages: true,
    });
    expect(text).toContain("QA report: Report <Fixture> & Co");
    for (const i of data.issues) expect(text).toContain(i.id);
    expect(text).toContain("Unable to verify from available evidence.");
    expect(text).toMatch(/Page 1 of \d+/);
  });

  it("lists findings of scans without issues instead of inventing issues", async () => {
    const legacy = await newScan({
      seo: [f({ ruleId: "meta-description-missing", title: "No meta description" })],
    });
    await pipelineRepo.finishScan(db(), legacy, "completed");
    await reportsRepo.createReport(db(), ownerId, legacy, "md", ownerId);
    await processNextReport(rt());
    const [row] = await db().select().from(schema.report).where(eq(schema.report.scanId, legacy));
    const md = (await storage.read(row!.storageKey!)).toString("utf8");
    expect(md).toContain("## Issues (0)");
    expect(md).toContain("its findings are listed below");
    expect(md).toContain("## Findings not grouped into issues (1)");
    expect(md).toContain("`SEO-001` No meta description");
  });

  it("marks only the affected report failed when storing it fails", async () => {
    const created = await reportsRepo.createReport(db(), ownerId, scanId, "json", ownerId);
    const failing: Storage = {
      ...storage,
      put: async () => {
        throw new Error("disk full");
      },
    };
    expect(await processNextReport({ ...rt(), storage: failing })).toBe(true);
    const [row] = await db()
      .select()
      .from(schema.report)
      .where(eq(schema.report.id, (created as { report: { id: string } }).report.id));
    expect(row).toMatchObject({
      status: "failed",
      error: "Report generation failed: disk full",
      storageKey: null,
    });
    // The earlier JSON report of the same scan is untouched.
    const ok = await db()
      .select()
      .from(schema.report)
      .where(and(eq(schema.report.scanId, scanId), eq(schema.report.status, "completed")));
    expect(ok).toHaveLength(3);
  });
});
