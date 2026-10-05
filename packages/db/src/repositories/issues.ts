import type { IssueStatus, Severity } from "@qa/core";
import { and, asc, count, desc, eq, gte, ilike, inArray, or, sql } from "drizzle-orm";
import type { Database } from "../client";
import {
  aiRun,
  evidence,
  groundingCheck,
  issue,
  issueFinding,
  issueStatusEvent,
  issueTrack,
  page,
  project,
  rawFinding,
  scan,
  user,
} from "../schema";
import { ownedProjects } from "./owned";
import { escapeLike } from "./projects";

export type IssueSort = "severity" | "status" | "category" | "date" | "number";
type Verdict = "confirmed" | "potential" | "inconclusive" | "unable_to_verify";

export interface IssueListOptions {
  projectId?: string;
  severities?: Severity[];
  statuses?: IssueStatus[];
  category?: string;
  /** Verdict of the latest occurrence (confirmed, needs review, unable to verify). */
  verdicts?: Verdict[];
  /** Substring of an affected page URL of the latest occurrence. */
  url?: string;
  /** Minimum confidence (0..1) of the latest occurrence. */
  minConfidence?: number;
  /** Only issues whose latest occurrence comes from a scan started at or after this time. */
  detectedSince?: Date;
  q?: string;
  sort?: IssueSort;
  page: number;
  pageSize: number;
}

export interface IssueListItem {
  id: string;
  displayNo: number;
  projectId: string;
  projectName: string;
  title: string;
  severity: Severity;
  status: IssueStatus;
  category: string;
  /** Scan of the latest occurrence (null if that scan was deleted). */
  lastSeenScanId: string | null;
  lastSeenScanNumber: number | null;
  lastSeenAt: Date | null;
  /** From the latest occurrence (null for tracks whose latest scan was deleted). */
  verdict: Verdict | null;
  confidence: number | null;
  pageCount: number | null;
  origin: "ai" | "deterministic" | null;
  /** Number of scans this issue was found in. */
  occurrences: number;
  updatedAt: Date;
}

// Postgres orders enums by declaration order: critical..info, open..inconclusive.
const ORDER: Record<IssueSort, ReturnType<typeof asc>[]> = {
  severity: [asc(issueTrack.severity), desc(issueTrack.updatedAt)],
  status: [asc(issueTrack.status), asc(issueTrack.severity)],
  category: [asc(issueTrack.category), asc(issueTrack.severity)],
  date: [desc(issueTrack.updatedAt)],
  number: [desc(issueTrack.displayNo)],
};

/** The occurrence of a track in the scan that last saw it. */
const latestOccurrence = and(
  eq(issue.trackId, issueTrack.id),
  eq(issue.scanId, issueTrack.lastSeenScanId),
);

/** Tracked issues across the user's projects, filtered and paginated. */
export async function listIssues(db: Database, ownerId: string, opts: IssueListOptions) {
  const filters = [
    ownedProjects(ownerId),
    opts.projectId ? eq(issueTrack.projectId, opts.projectId) : undefined,
    opts.severities?.length ? inArray(issueTrack.severity, opts.severities) : undefined,
    opts.statuses?.length ? inArray(issueTrack.status, opts.statuses) : undefined,
    opts.category ? eq(issueTrack.category, opts.category) : undefined,
    opts.verdicts?.length ? inArray(issue.verdict, opts.verdicts) : undefined,
    opts.url ? sql`${issue.affectedUrls}::text ilike ${`%${escapeLike(opts.url)}%`}` : undefined,
    opts.minConfidence !== undefined ? gte(issue.confidence, opts.minConfidence) : undefined,
    opts.detectedSince ? gte(scan.createdAt, opts.detectedSince) : undefined,
  ];
  if (opts.q) {
    const pattern = `%${escapeLike(opts.q)}%`;
    const asNumber = /^(issue-)?(\d+)$/i.exec(opts.q.trim());
    filters.push(
      or(
        ilike(issueTrack.title, pattern),
        asNumber ? eq(issueTrack.displayNo, Number(asNumber[2])) : undefined,
      ),
    );
  }
  const where = and(...filters);
  const [items, [totalRow]] = await Promise.all([
    db
      .select({
        id: issueTrack.id,
        displayNo: issueTrack.displayNo,
        projectId: issueTrack.projectId,
        projectName: project.name,
        title: issueTrack.title,
        severity: issueTrack.severity,
        status: issueTrack.status,
        category: issueTrack.category,
        lastSeenScanId: issueTrack.lastSeenScanId,
        lastSeenScanNumber: scan.number,
        lastSeenAt: scan.createdAt,
        verdict: issue.verdict,
        confidence: issue.confidence,
        pageCount: sql<number | null>`jsonb_array_length(${issue.affectedUrls})`,
        origin: issue.origin,
        occurrences:
          sql<number>`(select count(*) from ${issue} o where o.track_id = ${issueTrack.id})`.mapWith(
            Number,
          ),
        updatedAt: issueTrack.updatedAt,
      })
      .from(issueTrack)
      .innerJoin(project, eq(project.id, issueTrack.projectId))
      .leftJoin(issue, latestOccurrence)
      .leftJoin(scan, eq(scan.id, issueTrack.lastSeenScanId))
      .where(where)
      .orderBy(...ORDER[opts.sort ?? "severity"], asc(issueTrack.displayNo))
      .limit(opts.pageSize)
      .offset((opts.page - 1) * opts.pageSize),
    db
      .select({ total: count() })
      .from(issueTrack)
      .innerJoin(project, eq(project.id, issueTrack.projectId))
      .leftJoin(issue, latestOccurrence)
      .leftJoin(scan, eq(scan.id, issueTrack.lastSeenScanId))
      .where(where),
  ]);
  return { items: items as IssueListItem[], total: totalRow?.total ?? 0 };
}

/** Categories that actually occur in the user's issues (for filter options; no hardcoded list). */
export async function listIssueCategories(db: Database, ownerId: string, projectId?: string) {
  const rows = await db
    .selectDistinct({ category: issueTrack.category })
    .from(issueTrack)
    .innerJoin(project, eq(project.id, issueTrack.projectId))
    .where(and(ownedProjects(ownerId), projectId ? eq(issueTrack.projectId, projectId) : undefined))
    .orderBy(asc(issueTrack.category));
  return rows.map((r) => r.category);
}

/** Track id of ISSUE-<displayNo> in a project the user owns. */
export async function findIssueIdByNumber(
  db: Database,
  ownerId: string,
  projectId: string,
  displayNo: number,
) {
  const [row] = await db
    .select({ id: issueTrack.id })
    .from(issueTrack)
    .innerJoin(project, eq(project.id, issueTrack.projectId))
    .where(
      and(
        ownedProjects(ownerId),
        eq(issueTrack.projectId, projectId),
        eq(issueTrack.displayNo, displayNo),
      ),
    );
  return row?.id ?? null;
}

/**
 * One tracked issue with everything needed to act on it: every scan it occurred in, the selected
 * occurrence (latest by default) with its source findings and their evidence, the grounding
 * checks behind its text, and the audited status history. Owner-checked; null if not visible.
 */
export async function getIssueDetail(
  db: Database,
  ownerId: string,
  trackId: string,
  opts: { scanId?: string } = {},
) {
  const [track] = await db
    .select({
      id: issueTrack.id,
      displayNo: issueTrack.displayNo,
      projectId: issueTrack.projectId,
      projectName: project.name,
      fingerprint: issueTrack.fingerprint,
      status: issueTrack.status,
      severity: issueTrack.severity,
      category: issueTrack.category,
      title: issueTrack.title,
      firstSeenScanId: issueTrack.firstSeenScanId,
      lastSeenScanId: issueTrack.lastSeenScanId,
      resolvedAt: issueTrack.resolvedAt,
      createdAt: issueTrack.createdAt,
      updatedAt: issueTrack.updatedAt,
    })
    .from(issueTrack)
    .innerJoin(project, eq(project.id, issueTrack.projectId))
    .where(and(eq(issueTrack.id, trackId), ownedProjects(ownerId)));
  if (!track) return null;

  const [occurrences, history] = await Promise.all([
    db
      .select({
        issueId: issue.id,
        scanId: issue.scanId,
        scanNumber: scan.number,
        scanStatus: scan.status,
        scanCreatedAt: scan.createdAt,
        severity: issue.severity,
        verdict: issue.verdict,
        groundingStatus: issue.groundingStatus,
        findingCount:
          sql<number>`(select count(*) from ${issueFinding} f where f.issue_id = ${issue.id})`.mapWith(
            Number,
          ),
      })
      .from(issue)
      .innerJoin(scan, eq(scan.id, issue.scanId))
      .where(eq(issue.trackId, trackId))
      .orderBy(desc(scan.number)),
    db
      .select({
        id: issueStatusEvent.id,
        fromStatus: issueStatusEvent.fromStatus,
        toStatus: issueStatusEvent.toStatus,
        note: issueStatusEvent.note,
        userId: issueStatusEvent.userId,
        userName: user.name,
        scanId: issueStatusEvent.scanId,
        scanNumber: scan.number,
        createdAt: issueStatusEvent.createdAt,
      })
      .from(issueStatusEvent)
      .leftJoin(user, eq(user.id, issueStatusEvent.userId))
      .leftJoin(scan, eq(scan.id, issueStatusEvent.scanId))
      .where(eq(issueStatusEvent.trackId, trackId))
      .orderBy(desc(issueStatusEvent.createdAt), desc(issueStatusEvent.id)),
  ]);

  const selected =
    (opts.scanId && occurrences.find((o) => o.scanId === opts.scanId)) || occurrences[0] || null;
  let occurrence = null;
  if (selected) {
    const [row] = await db.select().from(issue).where(eq(issue.id, selected.issueId));
    const [findings, checks, run] = await Promise.all([
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
          selector: rawFinding.selector,
          viewport: rawFinding.viewport,
          expected: rawFinding.expected,
          actual: rawFinding.actual,
          pageUrl: page.url,
        })
        .from(issueFinding)
        .innerJoin(rawFinding, eq(rawFinding.id, issueFinding.rawFindingId))
        .leftJoin(page, eq(page.id, rawFinding.pageId))
        .where(eq(issueFinding.issueId, selected.issueId))
        .orderBy(asc(rawFinding.displayId)),
      db
        .select({
          checkType: groundingCheck.checkType,
          passed: groundingCheck.passed,
          detail: groundingCheck.detail,
        })
        .from(groundingCheck)
        .where(eq(groundingCheck.issueId, selected.issueId))
        .orderBy(asc(groundingCheck.position)),
      row?.aiRunId
        ? db
            .select({
              provider: aiRun.provider,
              model: aiRun.model,
              status: aiRun.status,
              createdAt: aiRun.createdAt,
            })
            .from(aiRun)
            .where(eq(aiRun.id, row.aiRunId))
        : Promise.resolve([]),
    ]);
    const ev = findings.length
      ? await db
          .select({
            rawFindingId: evidence.rawFindingId,
            kind: evidence.kind,
            data: evidence.data,
            storageKey: evidence.storageKey,
          })
          .from(evidence)
          .where(
            inArray(
              evidence.rawFindingId,
              findings.map((f) => f.id),
            ),
          )
          .orderBy(asc(evidence.createdAt))
      : [];
    if (row)
      occurrence = {
        id: row.id,
        scanId: row.scanId,
        scanNumber: selected.scanNumber,
        scanCreatedAt: selected.scanCreatedAt,
        category: row.category,
        ruleId: row.ruleId,
        severity: row.severity,
        severityRationale: row.severityRationale,
        title: row.title,
        description: row.description,
        affectedUrls: row.affectedUrls,
        affectedElement: row.affectedElement,
        expected: row.expected,
        actual: row.actual,
        recommendation: row.recommendation,
        confidence: row.confidence,
        verdict: row.verdict,
        origin: row.origin,
        groundingStatus: row.groundingStatus,
        aiModel: run[0]?.model ?? null,
        checks: checks.map((c) => ({ ...c, detail: c.detail ?? {} })),
        findings: findings.map((f) => ({
          ...f,
          evidence: ev
            .filter((e) => e.rawFindingId === f.id)
            .map(({ kind, data, storageKey }) => ({ kind, data, storageKey })),
        })),
      };
  }
  return { ...track, occurrences, occurrence, history };
}

export type IssueDetail = NonNullable<Awaited<ReturnType<typeof getIssueDetail>>>;

export type StatusChangeResult =
  { ok: true; changed: string[]; unchanged: string[] } | { ok: false; missing: string[] };

/**
 * Sets the status of tracked issues (one or many) and records an audit event for every actual
 * change, in one transaction. All ids must belong to the user's projects; otherwise nothing is
 * changed. Setting the current status again is a no-op (no event).
 */
export async function changeIssueStatus(
  db: Database,
  ownerId: string,
  trackIds: string[],
  change: { status: IssueStatus; note?: string; userId: string },
): Promise<StatusChangeResult> {
  const ids = [...new Set(trackIds)];
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: issueTrack.id, status: issueTrack.status })
      .from(issueTrack)
      .innerJoin(project, eq(project.id, issueTrack.projectId))
      .where(and(inArray(issueTrack.id, ids), ownedProjects(ownerId)))
      .for("update", { of: issueTrack });
    if (rows.length !== ids.length) {
      const found = new Set(rows.map((r) => r.id));
      return { ok: false, missing: ids.filter((id) => !found.has(id)) };
    }
    const changed = rows.filter((r) => r.status !== change.status);
    if (changed.length) {
      await tx
        .update(issueTrack)
        .set({
          status: change.status,
          resolvedAt: change.status === "resolved" ? sql`now()` : null,
        })
        .where(
          inArray(
            issueTrack.id,
            changed.map((r) => r.id),
          ),
        );
      await tx.insert(issueStatusEvent).values(
        changed.map((r) => ({
          trackId: r.id,
          fromStatus: r.status,
          toStatus: change.status,
          userId: change.userId,
          note: change.note ?? null,
        })),
      );
    }
    const changedIds = new Set(changed.map((r) => r.id));
    return {
      ok: true,
      changed: ids.filter((id) => changedIds.has(id)),
      unchanged: ids.filter((id) => !changedIds.has(id)),
    };
  });
}
