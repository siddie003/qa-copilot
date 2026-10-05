import {
  COMPARISON_VERSION,
  REPORTABLE_SCAN_STATUSES,
  type ComparisonScanInput,
  type ComparisonSummary,
  type ComparisonTrackInput,
  type ScanConfigSnapshot,
} from "@qa/core";
import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { Database } from "../client";
import {
  issue,
  issueFinding,
  issueTrack,
  page,
  pageCapture,
  project,
  rawFinding,
  scan,
  scanComparison,
  scannerRun,
} from "../schema";
import { ownedProjects } from "./owned";

/**
 * Scan history and comparison (Phase 9): loads the stored records two scans are compared from
 * (the comparison itself is the pure `compareScans` in `@qa/core/comparison`) and caches each
 * comparison's summary in `scan_comparison`. Nothing here writes scan, finding or issue data.
 */

const FINISHED = [...REPORTABLE_SCAN_STATUSES] as string[];

const chunks = <T>(items: T[], size = 1000) =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, (i + 1) * size),
  );

export interface HistoryScan {
  id: string;
  number: number;
  status: string;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  /** Status of the evidence-validation step that creates issues (null: scan predates it). */
  groundingStatus: string | null;
  issueCount: number;
  findingCount: number;
}

const historyColumns = {
  id: scan.id,
  number: scan.number,
  status: scan.status,
  createdAt: scan.createdAt,
  startedAt: scan.startedAt,
  finishedAt: scan.finishedAt,
  groundingStatus: sql<
    string | null
  >`(select ${scannerRun.status} from ${scannerRun} where ${scannerRun.scanId} = ${scan.id} and ${scannerRun.stepKey} = 'grounding')`,
  issueCount:
    sql<number>`(select count(*) from ${issue} where ${issue.scanId} = ${scan.id})`.mapWith(Number),
  findingCount:
    sql<number>`coalesce((select sum(${scannerRun.findingCount}) from ${scannerRun} where ${scannerRun.scanId} = ${scan.id}), 0)`.mapWith(
      Number,
    ),
};

/** Every scan of a project (owner-checked), newest first, with issue counts. */
export async function listProjectScans(
  db: Database,
  ownerId: string,
  projectId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<HistoryScan[]> {
  return db
    .select(historyColumns)
    .from(scan)
    .innerJoin(project, eq(project.id, scan.projectId))
    .where(and(eq(scan.projectId, projectId), ownedProjects(ownerId)))
    .orderBy(desc(scan.number))
    .limit(opts.limit ?? 1000)
    .offset(opts.offset ?? 0);
}

/** One scan of the project (owner-checked), or null. */
export async function getProjectScan(
  db: Database,
  ownerId: string,
  projectId: string,
  scanId: string,
): Promise<HistoryScan | null> {
  const [row] = await db
    .select(historyColumns)
    .from(scan)
    .innerJoin(project, eq(project.id, scan.projectId))
    .where(and(eq(scan.id, scanId), eq(scan.projectId, projectId), ownedProjects(ownerId)));
  return row ?? null;
}

/** A finished scan with issue records: it can take part in an issue comparison. */
export const isComparable = (s: Pick<HistoryScan, "status" | "groundingStatus">) =>
  FINISHED.includes(s.status) && s.groundingStatus === "completed";

/** The latest finished scan with issue records before scan number `before` (no owner check). */
export async function previousComparableScan(db: Database, projectId: string, before: number) {
  const [row] = await db
    .select({ id: scan.id, number: scan.number })
    .from(scan)
    .innerJoin(scannerRun, and(eq(scannerRun.scanId, scan.id), eq(scannerRun.stepKey, "grounding")))
    .where(
      and(
        eq(scan.projectId, projectId),
        lt(scan.number, before),
        inArray(scan.status, FINISHED as Array<(typeof scan.status.enumValues)[number]>),
        eq(scannerRun.status, "completed"),
      ),
    )
    .orderBy(desc(scan.number))
    .limit(1);
  return row ?? null;
}

/** Everything a comparison needs about one scan, from stored records only (no owner check). */
export async function loadComparisonScan(
  db: Database,
  scanId: string,
): Promise<ComparisonScanInput | null> {
  const [s] = await db.select().from(scan).where(eq(scan.id, scanId));
  if (!s) return null;
  const snapshot = s.configSnapshot as Partial<ScanConfigSnapshot>;
  const [steps, pages, captures, findings, issues] = await Promise.all([
    db
      .select({
        stepKey: scannerRun.stepKey,
        status: scannerRun.status,
        statusReason: scannerRun.statusReason,
        error: scannerRun.error,
        findingCount: scannerRun.findingCount,
        checks: scannerRun.checks,
      })
      .from(scannerRun)
      .where(eq(scannerRun.scanId, scanId))
      .orderBy(asc(scannerRun.position)),
    db
      .select({
        id: page.id,
        url: page.url,
        finalUrl: page.finalUrl,
        httpStatus: page.httpStatus,
        contentType: page.contentType,
        crawlError: page.crawlError,
      })
      .from(page)
      .where(eq(page.scanId, scanId)),
    db
      .select({
        pageId: pageCapture.pageId,
        viewport: pageCapture.viewport,
        error: pageCapture.error,
      })
      .from(pageCapture)
      .innerJoin(page, eq(page.id, pageCapture.pageId))
      .where(eq(page.scanId, scanId)),
    db
      .select({
        id: rawFinding.id,
        displayId: rawFinding.displayId,
        scanner: rawFinding.scanner,
        ruleId: rawFinding.ruleId,
        title: rawFinding.title,
        severity: rawFinding.proposedSeverity,
        verdict: rawFinding.verdict,
        selector: rawFinding.selector,
        viewport: rawFinding.viewport,
        expected: rawFinding.expected,
        actual: rawFinding.actual,
        fingerprint: rawFinding.fingerprint,
        pageUrl: sql<string | null>`coalesce(${page.finalUrl}, ${page.url})`,
      })
      .from(rawFinding)
      .leftJoin(page, eq(page.id, rawFinding.pageId))
      .where(eq(rawFinding.scanId, scanId))
      .orderBy(asc(rawFinding.scanner), asc(rawFinding.displayId)),
    db
      .select({
        id: issue.id,
        trackId: issue.trackId,
        displayNo: issueTrack.displayNo,
        category: issue.category,
        ruleId: issue.ruleId,
        title: issue.title,
        severity: issue.severity,
        verdict: issue.verdict,
        confidence: issue.confidence,
        affectedUrls: issue.affectedUrls,
      })
      .from(issue)
      .innerJoin(issueTrack, eq(issueTrack.id, issue.trackId))
      .where(eq(issue.scanId, scanId)),
  ]);
  const findingIdsOf = new Map<string, string[]>();
  for (const ids of chunks(issues.map((i) => i.id)))
    for (const link of await db
      .select({ issueId: issueFinding.issueId, rawFindingId: issueFinding.rawFindingId })
      .from(issueFinding)
      .where(inArray(issueFinding.issueId, ids)))
      findingIdsOf.set(link.issueId, [
        ...(findingIdsOf.get(link.issueId) ?? []),
        link.rawFindingId,
      ]);
  const capturesOf = new Map<string, Array<{ viewport: string; error: string | null }>>();
  for (const c of captures)
    capturesOf.set(c.pageId, [
      ...(capturesOf.get(c.pageId) ?? []),
      { viewport: c.viewport, error: c.error },
    ]);
  return {
    id: s.id,
    projectId: s.projectId,
    number: s.number,
    status: s.status,
    createdAt: s.createdAt,
    startedAt: s.startedAt,
    finishedAt: s.finishedAt,
    websiteUrl: typeof snapshot.websiteUrl === "string" ? snapshot.websiteUrl : null,
    scanners: Array.isArray(snapshot.scanners) ? [...snapshot.scanners] : [],
    viewports: Array.isArray(snapshot.viewports) ? snapshot.viewports.map((v) => v.name) : [],
    maxPages: typeof snapshot.maxPages === "number" ? snapshot.maxPages : null,
    maxDepth: typeof snapshot.maxDepth === "number" ? snapshot.maxDepth : null,
    designSpecId: s.designSpecId,
    designSpecVersion:
      typeof snapshot.designSpecVersion === "number" ? snapshot.designSpecVersion : null,
    contentSnapshotHash: s.contentSnapshotHash,
    steps,
    pages: pages.map(({ id, ...p }) => ({ ...p, captures: capturesOf.get(id) ?? [] })),
    findings,
    issues: issues.map((i) => ({ ...i, findingIds: findingIdsOf.get(i.id) ?? [] })),
  };
}

/**
 * Workflow facts for the tracked issues of a comparison: current status, the latest earlier
 * occurrence before the base scan, and whether the target scan reopened the issue.
 */
export async function loadComparisonTracks(
  db: Database,
  trackIds: string[],
  base: { number: number },
  target: { id: string },
): Promise<ComparisonTrackInput[]> {
  const out: ComparisonTrackInput[] = [];
  for (const ids of chunks(trackIds))
    out.push(
      ...(await db
        .select({
          trackId: issueTrack.id,
          displayNo: issueTrack.displayNo,
          status: issueTrack.status,
          // Aliased explicitly: drizzle renders single-table column references unqualified.
          lastSeenBeforeBase: sql<number | null>`(
            select max(s.number) from issue i join scan s on s.id = i.scan_id
            where i.track_id = issue_track.id and s.number < ${base.number})`,
          reopenedAt: sql<Date | null>`(
            select max(e.created_at) from issue_status_event e
            where e.track_id = issue_track.id and e.scan_id = ${target.id}
              and e.to_status = 'reopened')`,
        })
        .from(issueTrack)
        .where(inArray(issueTrack.id, ids))
        .then((rows) =>
          rows.map(({ reopenedAt, lastSeenBeforeBase, ...r }) => ({
            ...r,
            lastSeenBeforeBase: lastSeenBeforeBase === null ? null : Number(lastSeenBeforeBase),
            reopenedByTarget: reopenedAt ? { at: reopenedAt } : null,
          })),
        )),
    );
  return out;
}

/** Cached summaries of the current comparison version for the given pairs. */
export async function cachedSummaries(
  db: Database,
  pairs: Array<{ baseScanId: string; targetScanId: string }>,
) {
  const out = new Map<string, ComparisonSummary>();
  const targets = [...new Set(pairs.map((p) => p.targetScanId))];
  if (!targets.length) return out;
  const rows = await db
    .select({
      baseScanId: scanComparison.baseScanId,
      targetScanId: scanComparison.targetScanId,
      summary: scanComparison.summary,
    })
    .from(scanComparison)
    .where(inArray(scanComparison.targetScanId, targets));
  const wanted = new Set(pairs.map((p) => `${p.baseScanId}:${p.targetScanId}`));
  for (const r of rows) {
    const key = `${r.baseScanId}:${r.targetScanId}`;
    const summary = r.summary as unknown as ComparisonSummary;
    if (wanted.has(key) && summary.version === COMPARISON_VERSION) out.set(key, summary);
  }
  return out;
}

/**
 * For each target scan, the cached comparison with the closest earlier base scan (dashboard;
 * nothing is computed here, so scans whose comparison was never viewed have no entry).
 */
export async function latestCachedForTargets(db: Database, targetScanIds: string[]) {
  const out = new Map<
    string,
    { baseScanId: string; baseNumber: number; summary: ComparisonSummary }
  >();
  if (!targetScanIds.length) return out;
  const rows = await db
    .select({
      targetScanId: scanComparison.targetScanId,
      baseScanId: scanComparison.baseScanId,
      baseNumber: scan.number,
      summary: scanComparison.summary,
    })
    .from(scanComparison)
    .innerJoin(scan, eq(scan.id, scanComparison.baseScanId))
    .where(inArray(scanComparison.targetScanId, targetScanIds))
    .orderBy(desc(scan.number));
  for (const r of rows) {
    const summary = r.summary as unknown as ComparisonSummary;
    if (summary.version !== COMPARISON_VERSION || out.has(r.targetScanId)) continue;
    out.set(r.targetScanId, { baseScanId: r.baseScanId, baseNumber: r.baseNumber, summary });
  }
  return out;
}

/**
 * Stores a comparison summary (cache only: always recomputable from the scans). Only finished
 * scans are compared, and their records no longer change, so a cached summary stays valid.
 */
export async function saveSummary(
  db: Database,
  projectId: string,
  baseScanId: string,
  targetScanId: string,
  summary: ComparisonSummary,
) {
  await db
    .insert(scanComparison)
    .values({
      projectId,
      baseScanId,
      targetScanId,
      summary: summary as unknown as Record<string, unknown>,
    })
    .onConflictDoUpdate({
      target: [scanComparison.baseScanId, scanComparison.targetScanId],
      set: { summary: summary as unknown as Record<string, unknown>, computedAt: sql`now()` },
    });
}

/** Issue occurrences per scan by severity and verdict (history chart), for the given scans. */
export async function issueBreakdown(db: Database, scanIds: string[]) {
  const out = new Map<
    string,
    {
      severity: Record<string, number>;
      confirmed: number;
      needsReview: number;
      unableToVerify: number;
    }
  >();
  if (!scanIds.length) return out;
  const rows = await db
    .select({
      scanId: issue.scanId,
      severity: issue.severity,
      verdict: issue.verdict,
      n: sql<number>`count(*)`.mapWith(Number),
    })
    .from(issue)
    .where(inArray(issue.scanId, scanIds))
    .groupBy(issue.scanId, issue.severity, issue.verdict);
  for (const r of rows) {
    const e = out.get(r.scanId) ?? {
      severity: {},
      confirmed: 0,
      needsReview: 0,
      unableToVerify: 0,
    };
    e.severity[r.severity] = (e.severity[r.severity] ?? 0) + r.n;
    if (r.verdict === "confirmed") e.confirmed += r.n;
    else if (r.verdict === "potential") e.needsReview += r.n;
    else e.unableToVerify += r.n;
    out.set(r.scanId, e);
  }
  return out;
}
