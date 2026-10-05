import { and, asc, count, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { Database } from "../client";
import {
  aiRun,
  evidence,
  groundingCheck,
  issue,
  issueFinding,
  issueTrack,
  page,
  project,
  rawFinding,
  report,
  scan,
  scannerRun,
} from "../schema";
import { ownedProjects } from "./owned";

/**
 * Reports: one row per generated file (PDF, Markdown, JSON) of one scan. The row is the job: the
 * web app inserts it as pending and NOTIFYs; the worker claims it with SKIP LOCKED, builds the
 * report from stored rows only and stores the file. Files are never served without an owner check.
 */

export const REPORT_QUEUED_CHANNEL = "report_queued";

type Format = "pdf" | "md" | "json";

/** Scan statuses a report can be generated for (the scan's data no longer changes). */
const REPORTABLE = new Set(["completed", "completed_with_failures", "failed", "cancelled"]);

const listColumns = {
  id: report.id,
  format: report.format,
  status: report.status,
  sizeBytes: report.sizeBytes,
  error: report.error,
  createdAt: report.createdAt,
  startedAt: report.startedAt,
  completedAt: report.completedAt,
  scanId: scan.id,
  scanNumber: scan.number,
  projectId: project.id,
  projectName: project.name,
};

export async function listReports(
  db: Database,
  ownerId: string,
  opts: { projectId?: string; scanId?: string; page: number; pageSize: number },
) {
  const where = and(
    ownedProjects(ownerId),
    opts.projectId ? eq(scan.projectId, opts.projectId) : undefined,
    opts.scanId ? eq(report.scanId, opts.scanId) : undefined,
  );
  const [items, [totalRow]] = await Promise.all([
    db
      .select(listColumns)
      .from(report)
      .innerJoin(scan, eq(scan.id, report.scanId))
      .innerJoin(project, eq(project.id, scan.projectId))
      .where(where)
      .orderBy(desc(report.createdAt))
      .limit(opts.pageSize)
      .offset((opts.page - 1) * opts.pageSize),
    db
      .select({ total: count() })
      .from(report)
      .innerJoin(scan, eq(scan.id, report.scanId))
      .innerJoin(project, eq(project.id, scan.projectId))
      .where(where),
  ]);
  return { items, total: totalRow?.total ?? 0 };
}

export type ReportListItem = Awaited<ReturnType<typeof listReports>>["items"][number];

/** One report with its storage key (for downloads), owner-checked. */
export async function getReport(db: Database, ownerId: string, reportId: string) {
  const [row] = await db
    .select({ ...listColumns, storageKey: report.storageKey })
    .from(report)
    .innerJoin(scan, eq(scan.id, report.scanId))
    .innerJoin(project, eq(project.id, scan.projectId))
    .where(and(eq(report.id, reportId), ownedProjects(ownerId)));
  return row ?? null;
}

export type CreateReportResult =
  | { kind: "created"; report: ReportListItem }
  | { kind: "not_found" }
  | { kind: "not_finished"; scanStatus: string }
  | { kind: "in_progress"; reportId: string };

/**
 * Queues a report for a finished scan. A second request for the same scan and format while one
 * is still pending or running is refused (the client should wait for it).
 */
export async function createReport(
  db: Database,
  ownerId: string,
  scanId: string,
  format: Format,
  userId: string,
): Promise<CreateReportResult> {
  return db.transaction(async (tx) => {
    const [s] = await tx
      .select({ id: scan.id, status: scan.status })
      .from(scan)
      .innerJoin(project, eq(project.id, scan.projectId))
      .where(and(eq(scan.id, scanId), ownedProjects(ownerId)))
      .for("update", { of: scan });
    if (!s) return { kind: "not_found" };
    if (!REPORTABLE.has(s.status)) return { kind: "not_finished", scanStatus: s.status };
    const [busy] = await tx
      .select({ id: report.id })
      .from(report)
      .where(
        and(
          eq(report.scanId, scanId),
          eq(report.format, format),
          inArray(report.status, ["pending", "running"]),
        ),
      );
    if (busy) return { kind: "in_progress", reportId: busy.id };
    const [created] = await tx
      .insert(report)
      .values({ scanId, format, status: "pending", createdByUserId: userId })
      .returning({ id: report.id });
    await tx.execute(sql`select pg_notify(${REPORT_QUEUED_CHANNEL}, '')`);
    const [row] = await tx
      .select(listColumns)
      .from(report)
      .innerJoin(scan, eq(scan.id, report.scanId))
      .innerJoin(project, eq(project.id, scan.projectId))
      .where(eq(report.id, created!.id));
    return { kind: "created", report: row! };
  });
}

export type DeleteReportResult =
  { kind: "deleted"; storageKey: string | null } | { kind: "not_found" } | { kind: "running" };

/** Deletes a report row (the caller removes the file). Running reports cannot be deleted. */
export async function deleteReport(
  db: Database,
  ownerId: string,
  reportId: string,
): Promise<DeleteReportResult> {
  const existing = await getReport(db, ownerId, reportId);
  if (!existing) return { kind: "not_found" };
  const [row] = await db
    .delete(report)
    .where(and(eq(report.id, reportId), inArray(report.status, ["pending", "completed", "failed"])))
    .returning({ storageKey: report.storageKey });
  return row ? { kind: "deleted", storageKey: row.storageKey } : { kind: "running" };
}

// ---- worker side -------------------------------------------------------------------------------

/** Claims the oldest pending report (SKIP LOCKED). */
export async function claimNextReport(db: Database) {
  const rows = await db.execute<{ id: string }>(sql`
    update ${report} set status = 'running', started_at = now(), error = null
    where id = (
      select id from ${report}
      where status = 'pending'
      order by created_at for update skip locked limit 1
    )
    returning id`);
  const id = rows.rows[0]?.id;
  if (!id) return null;
  const [row] = await db
    .select({
      id: report.id,
      scanId: report.scanId,
      format: report.format,
      projectId: scan.projectId,
      scanNumber: scan.number,
    })
    .from(report)
    .innerJoin(scan, eq(scan.id, report.scanId))
    .where(eq(report.id, id));
  return row ?? null;
}

export async function completeReport(
  db: Database,
  reportId: string,
  v: { storageKey: string; sizeBytes: number },
) {
  const rows = await db
    .update(report)
    .set({
      status: "completed",
      storageKey: v.storageKey,
      sizeBytes: v.sizeBytes,
      error: null,
      completedAt: sql`now()`,
    })
    .where(and(eq(report.id, reportId), eq(report.status, "running")))
    .returning({ id: report.id });
  return rows.length > 0;
}

export async function failReport(db: Database, reportId: string, error: string) {
  await db
    .update(report)
    .set({ status: "failed", error: error.slice(0, 1000), completedAt: sql`now()` })
    .where(eq(report.id, reportId));
}

/** Reports left "running" by a stopped worker are failed with a retry hint. */
export async function recoverStaleReports(db: Database, staleAfterMs: number) {
  const rows = await db
    .update(report)
    .set({
      status: "failed",
      error: "Generation was interrupted (the worker stopped). Generate the report again.",
      completedAt: sql`now()`,
    })
    .where(
      and(
        eq(report.status, "running"),
        lt(report.startedAt, sql`now() - (${staleAfterMs} || ' milliseconds')::interval`),
      ),
    )
    .returning({ id: report.id });
  return rows.map((r) => r.id);
}

const chunks = <T>(items: T[], size = 1000) =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, (i + 1) * size),
  );

/**
 * Everything a report contains, read from stored rows: project, scan, steps, issues (with their
 * current tracking status, finding links and grounding checks), findings with evidence, AI
 * requests. Shape matches `ReportSource` in `@qa/reports`.
 */
export async function loadReportSource(db: Database, scanId: string) {
  const [s] = await db
    .select({
      id: scan.id,
      number: scan.number,
      status: scan.status,
      createdAt: scan.createdAt,
      startedAt: scan.startedAt,
      finishedAt: scan.finishedAt,
      error: scan.error,
      configSnapshot: scan.configSnapshot,
      technology: scan.technology,
      projectId: project.id,
      projectName: project.name,
      websiteUrl: project.websiteUrl,
    })
    .from(scan)
    .innerJoin(project, eq(project.id, scan.projectId))
    .where(eq(scan.id, scanId));
  if (!s) return null;

  const [[pages], steps, issues, findings, aiRuns] = await Promise.all([
    db.select({ n: count() }).from(page).where(eq(page.scanId, scanId)),
    db
      .select({
        stepKey: scannerRun.stepKey,
        status: scannerRun.status,
        statusReason: scannerRun.statusReason,
        error: scannerRun.error,
        findingCount: scannerRun.findingCount,
        durationMs: scannerRun.durationMs,
        toolName: scannerRun.toolName,
        toolVersion: scannerRun.toolVersion,
        checks: scannerRun.checks,
      })
      .from(scannerRun)
      .where(eq(scannerRun.scanId, scanId))
      .orderBy(asc(scannerRun.position)),
    db
      .select({
        id: issue.id,
        trackId: issue.trackId,
        displayNo: issueTrack.displayNo,
        trackStatus: issueTrack.status,
        category: issue.category,
        subcategory: issue.subcategory,
        ruleId: issue.ruleId,
        severity: issue.severity,
        severityRationale: issue.severityRationale,
        title: issue.title,
        description: issue.description,
        affectedUrls: issue.affectedUrls,
        affectedElement: issue.affectedElement,
        expected: issue.expected,
        actual: issue.actual,
        recommendation: issue.recommendation,
        confidence: issue.confidence,
        verdict: issue.verdict,
        origin: issue.origin,
        groundingStatus: issue.groundingStatus,
      })
      .from(issue)
      .innerJoin(issueTrack, eq(issueTrack.id, issue.trackId))
      .where(eq(issue.scanId, scanId)),
    db
      .select({
        id: rawFinding.id,
        displayId: rawFinding.displayId,
        scanner: rawFinding.scanner,
        ruleId: rawFinding.ruleId,
        title: rawFinding.title,
        message: rawFinding.message,
        severity: rawFinding.proposedSeverity,
        verdict: rawFinding.verdict,
        confidence: rawFinding.confidence,
        pageUrl: sql<string | null>`coalesce(${page.finalUrl}, ${page.url})`,
        selector: rawFinding.selector,
        viewport: rawFinding.viewport,
        expected: rawFinding.expected,
        actual: rawFinding.actual,
      })
      .from(rawFinding)
      .leftJoin(page, eq(page.id, rawFinding.pageId))
      .where(eq(rawFinding.scanId, scanId)),
    db
      .select({
        provider: aiRun.provider,
        model: aiRun.model,
        status: aiRun.status,
        inputTokens: aiRun.inputTokens,
        outputTokens: aiRun.outputTokens,
      })
      .from(aiRun)
      .where(eq(aiRun.scanId, scanId))
      .orderBy(asc(aiRun.createdAt)),
  ]);

  const issueIds = issues.map((i) => i.id);
  const links: Array<{ issueId: string; rawFindingId: string }> = [];
  const checks: Array<typeof groundingCheck.$inferSelect> = [];
  for (const ids of chunks(issueIds)) {
    links.push(
      ...(await db
        .select({ issueId: issueFinding.issueId, rawFindingId: issueFinding.rawFindingId })
        .from(issueFinding)
        .where(inArray(issueFinding.issueId, ids))),
    );
    checks.push(
      ...(await db
        .select()
        .from(groundingCheck)
        .where(inArray(groundingCheck.issueId, ids))
        .orderBy(asc(groundingCheck.position))),
    );
  }
  const evidenceOf = new Map<
    string,
    Array<{ kind: string; data: Record<string, unknown>; storageKey: string | null }>
  >();
  for (const ids of chunks(findings.map((f) => f.id)))
    for (const e of await db
      .select({
        rawFindingId: evidence.rawFindingId,
        kind: evidence.kind,
        data: evidence.data,
        storageKey: evidence.storageKey,
      })
      .from(evidence)
      .where(inArray(evidence.rawFindingId, ids))
      .orderBy(asc(evidence.createdAt))) {
      const list = evidenceOf.get(e.rawFindingId) ?? [];
      list.push({ kind: e.kind, data: e.data, storageKey: e.storageKey });
      evidenceOf.set(e.rawFindingId, list);
    }
  const findingIdsOf = new Map<string, string[]>();
  for (const l of links)
    findingIdsOf.set(l.issueId, [...(findingIdsOf.get(l.issueId) ?? []), l.rawFindingId]);
  const checksOf = new Map<
    string,
    Array<{ checkType: string; passed: boolean; detail: Record<string, unknown> }>
  >();
  for (const c of checks)
    checksOf.set(c.issueId, [
      ...(checksOf.get(c.issueId) ?? []),
      { checkType: c.checkType, passed: c.passed, detail: c.detail ?? {} },
    ]);

  return {
    project: { id: s.projectId, name: s.projectName, websiteUrl: s.websiteUrl },
    scan: {
      id: s.id,
      number: s.number,
      status: s.status,
      createdAt: s.createdAt,
      startedAt: s.startedAt,
      finishedAt: s.finishedAt,
      error: s.error,
      configSnapshot: s.configSnapshot,
      technology: s.technology,
    },
    pageCount: pages?.n ?? 0,
    steps,
    issues: issues.map(({ id, ...i }) => ({
      ...i,
      checks: checksOf.get(id) ?? [],
      findingIds: findingIdsOf.get(id) ?? [],
    })),
    findings: findings.map((f) => ({ ...f, evidence: evidenceOf.get(f.id) ?? [] })),
    aiRuns,
  };
}
