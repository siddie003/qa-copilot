import { and, asc, eq, inArray, sql } from "drizzle-orm";
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
} from "../schema";
import { canReadScanArtifacts } from "./pipeline";

/**
 * Issues of a scan: one occurrence (`issue`) per tracked problem (`issue_track`), linked to the
 * raw findings it is built from, with the grounding checks that decided its text and the AI
 * requests that were made. Raw findings and evidence are only read here, never changed.
 */

type Severity = "critical" | "high" | "medium" | "low" | "info";
type Verdict = "confirmed" | "potential" | "inconclusive" | "unable_to_verify";

const chunks = <T>(items: T[], size = 1000) =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, (i + 1) * size),
  );

/** A scan's raw findings with evidence and page URL, for the interpretation step (worker only). */
export async function loadScanFindings(db: Database, scanId: string) {
  const rows = await db
    .select({
      id: rawFinding.id,
      displayId: rawFinding.displayId,
      scanner: rawFinding.scanner,
      ruleId: rawFinding.ruleId,
      subcategory: rawFinding.subcategory,
      title: rawFinding.title,
      message: rawFinding.message,
      severity: rawFinding.proposedSeverity,
      verdict: rawFinding.verdict,
      confidence: rawFinding.confidence,
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
    .orderBy(asc(rawFinding.scanner), asc(rawFinding.displayId));
  const byFinding = new Map<string, Array<{ kind: string; data: Record<string, unknown> }>>();
  for (const ids of chunks(rows.map((r) => r.id)))
    for (const e of await db
      .select({ rawFindingId: evidence.rawFindingId, kind: evidence.kind, data: evidence.data })
      .from(evidence)
      .where(inArray(evidence.rawFindingId, ids))
      .orderBy(asc(evidence.createdAt))) {
      const list = byFinding.get(e.rawFindingId) ?? [];
      list.push({ kind: e.kind, data: e.data });
      byFinding.set(e.rawFindingId, list);
    }
  return rows.map((r) => ({ ...r, evidence: byFinding.get(r.id) ?? [] }));
}

export interface NewAiRun {
  provider: string;
  model: string;
  status: "completed" | "failed";
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number | null;
  error: string | null;
  detail: Record<string, unknown>;
}

export async function insertAiRun(db: Database, scanId: string, run: NewAiRun) {
  const [row] = await db
    .insert(aiRun)
    .values({ scanId, ...run })
    .returning({ id: aiRun.id });
  return row!.id;
}

export interface NewScanIssue {
  fingerprint: string;
  category: string;
  ruleId: string;
  subcategory: string | null;
  severity: Severity;
  severityRationale: string;
  title: string;
  description: string;
  affectedUrls: string[];
  affectedElement: string | null;
  expected: string | null;
  actual: string | null;
  recommendation: string;
  confidence: number;
  verdict: Verdict;
  /** Status for a new track (existing tracks keep user-set statuses). */
  status: "open" | "inconclusive";
  origin: "ai" | "deterministic";
  groundingStatus: "passed" | "partial" | "rejected" | "not_applicable";
  aiRunId: string | null;
  findingIds: string[];
  checks: Array<{ checkType: string; passed: boolean; detail: Record<string, unknown> }>;
}

/** Statuses the system sets from evidence; anything else was chosen by a user and is kept. */
const SYSTEM_STATUSES = new Set(["open", "inconclusive"]);

/** Notes on audit events written by the system (user id null, scan id set). */
export const SYSTEM_EVENT_NOTES = {
  detected: "First detected by this scan.",
  evidence: "Status set from the evidence of this scan.",
  reopened: "Found again by this scan after it was marked resolved.",
} as const;

/**
 * Reopen rule (Phase 9): a track a user marked resolved is set to reopened when a scan finds it
 * again with evidence (confirmed or needs review, i.e. system status "open"), and only if it was
 * resolved before that scan started (a scan that started earlier may predate the fix). An
 * inconclusive occurrence cannot show that the fix failed, so the track stays resolved.
 */
export function shouldReopen(
  track: { status: string; resolvedAt: Date | null },
  occurrenceStatus: "open" | "inconclusive",
  scanStartedAt: Date,
) {
  return (
    track.status === "resolved" &&
    occurrenceStatus === "open" &&
    (track.resolvedAt === null || track.resolvedAt.getTime() <= scanStartedAt.getTime())
  );
}

/**
 * Stores a scan's issues in one transaction. Tracks are matched by fingerprint within the
 * project; new tracks get the next ISSUE numbers. Re-running replaces the scan's occurrences
 * (idempotent). Every issue must reference at least one finding of this scan.
 */
export async function materializeScanIssues(db: Database, scanId: string, issues: NewScanIssue[]) {
  return db.transaction(async (tx) => {
    const [s] = await tx
      .select({ projectId: scan.projectId, startedAt: scan.startedAt, createdAt: scan.createdAt })
      .from(scan)
      .where(eq(scan.id, scanId));
    if (!s) throw new Error(`Scan ${scanId} not found`);
    const projectId = s.projectId;
    const scanStartedAt = s.startedAt ?? s.createdAt;
    // Serializes numbering and track updates per project.
    await tx.execute(sql`select id from ${project} where id = ${projectId} for update`);
    await tx.delete(issue).where(eq(issue.scanId, scanId));
    if (!issues.length) return { issues: 0, newTracks: 0, updatedTracks: 0, reopened: 0 };

    const fingerprints = new Set(issues.map((i) => i.fingerprint));
    if (fingerprints.size !== issues.length) throw new Error("Duplicate issue fingerprints");
    const allFindings = issues.flatMap((i) => i.findingIds);
    if (issues.some((i) => i.findingIds.length === 0))
      throw new Error("Every issue needs at least one finding");
    if (new Set(allFindings).size !== allFindings.length)
      throw new Error("A finding was assigned to more than one issue");
    let owned = 0;
    for (const ids of chunks(allFindings))
      owned += (
        await tx
          .select({ id: rawFinding.id })
          .from(rawFinding)
          .where(and(eq(rawFinding.scanId, scanId), inArray(rawFinding.id, ids)))
      ).length;
    if (owned !== allFindings.length) throw new Error("Issue references findings of another scan");

    const existing = await tx
      .select({
        id: issueTrack.id,
        fingerprint: issueTrack.fingerprint,
        status: issueTrack.status,
        resolvedAt: issueTrack.resolvedAt,
      })
      .from(issueTrack)
      .where(
        and(
          eq(issueTrack.projectId, projectId),
          inArray(issueTrack.fingerprint, [...fingerprints]),
        ),
      );
    const tracks = new Map(existing.map((t) => [t.fingerprint, t]));
    const fresh = issues.filter((i) => !tracks.has(i.fingerprint));
    if (fresh.length) {
      const [counter] = await tx
        .update(project)
        .set({ issueCounter: sql`${project.issueCounter} + ${fresh.length}` })
        .where(eq(project.id, projectId))
        .returning({ value: project.issueCounter });
      const first = counter!.value - fresh.length + 1;
      const inserted = await tx
        .insert(issueTrack)
        .values(
          fresh.map((i, k) => ({
            projectId,
            displayNo: first + k,
            fingerprint: i.fingerprint,
            status: i.status,
            severity: i.severity,
            category: i.category,
            title: i.title.slice(0, 500),
            firstSeenScanId: scanId,
            lastSeenScanId: scanId,
          })),
        )
        .returning({
          id: issueTrack.id,
          fingerprint: issueTrack.fingerprint,
          status: issueTrack.status,
          resolvedAt: issueTrack.resolvedAt,
        });
      for (const t of inserted) tracks.set(t.fingerprint, t);
      // Audit trail: every track starts with a system event naming the scan that found it.
      await tx.insert(issueStatusEvent).values(
        inserted.map((t) => ({
          trackId: t.id,
          fromStatus: null,
          toStatus: t.status,
          userId: null,
          scanId,
          note: SYSTEM_EVENT_NOTES.detected,
        })),
      );
    }
    const statusEvents: Array<typeof issueStatusEvent.$inferInsert> = [];
    let reopened = 0;
    for (const t of existing) {
      const i = issues.find((x) => x.fingerprint === t.fingerprint)!;
      const systemChange = SYSTEM_STATUSES.has(t.status) && t.status !== i.status;
      const reopen = shouldReopen(t, i.status, scanStartedAt);
      await tx
        .update(issueTrack)
        .set({
          severity: i.severity,
          category: i.category,
          title: i.title.slice(0, 500),
          lastSeenScanId: scanId,
          ...(SYSTEM_STATUSES.has(t.status) ? { status: i.status } : {}),
          ...(reopen ? { status: "reopened" as const, resolvedAt: null } : {}),
        })
        .where(eq(issueTrack.id, t.id));
      if (reopen) {
        reopened += 1;
        statusEvents.push({
          trackId: t.id,
          fromStatus: t.status,
          toStatus: "reopened",
          userId: null,
          scanId,
          note: SYSTEM_EVENT_NOTES.reopened,
        });
      }
      if (systemChange)
        statusEvents.push({
          trackId: t.id,
          fromStatus: t.status,
          toStatus: i.status,
          userId: null,
          scanId,
          note: SYSTEM_EVENT_NOTES.evidence,
        });
    }
    if (statusEvents.length) await tx.insert(issueStatusEvent).values(statusEvents);

    const rows = await tx
      .insert(issue)
      .values(
        issues.map((i) => ({
          trackId: tracks.get(i.fingerprint)!.id,
          scanId,
          category: i.category,
          subcategory: i.subcategory,
          ruleId: i.ruleId,
          severity: i.severity,
          severityRationale: i.severityRationale,
          title: i.title,
          description: i.description,
          affectedUrls: i.affectedUrls,
          affectedElement: i.affectedElement,
          expected: i.expected,
          actual: i.actual,
          recommendation: i.recommendation,
          confidence: i.confidence,
          verdict: i.verdict,
          origin: i.origin,
          groundingStatus: i.groundingStatus,
          aiRunId: i.aiRunId,
        })),
      )
      .returning({ id: issue.id });
    const links = rows.flatMap((r, k) =>
      issues[k]!.findingIds.map((rawFindingId) => ({ issueId: r.id, rawFindingId })),
    );
    for (const batch of chunks(links)) await tx.insert(issueFinding).values(batch);
    const checks = rows.flatMap((r, k) =>
      issues[k]!.checks.map((c, position) => ({
        issueId: r.id,
        checkType: c.checkType,
        passed: c.passed,
        detail: c.detail,
        position,
      })),
    );
    for (const batch of chunks(checks)) await tx.insert(groundingCheck).values(batch);
    return {
      issues: rows.length,
      newTracks: fresh.length,
      updatedTracks: existing.length,
      reopened,
    };
  });
}

/** Issues of a scan with their findings, grounding checks and AI requests (owner-checked). */
export async function listScanIssues(db: Database, ownerId: string, scanId: string) {
  if (!(await canReadScanArtifacts(db, ownerId, scanId))) return null;
  const rows = await db
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
      aiRunId: issue.aiRunId,
    })
    .from(issue)
    .innerJoin(issueTrack, eq(issueTrack.id, issue.trackId))
    .where(eq(issue.scanId, scanId))
    .orderBy(asc(issue.severity), asc(issueTrack.displayNo));
  const ids = rows.map((r) => r.id);
  const findings = ids.length
    ? await db
        .select({
          issueId: issueFinding.issueId,
          id: rawFinding.id,
          displayId: rawFinding.displayId,
          title: rawFinding.title,
          severity: rawFinding.proposedSeverity,
          verdict: rawFinding.verdict,
        })
        .from(issueFinding)
        .innerJoin(rawFinding, eq(rawFinding.id, issueFinding.rawFindingId))
        .where(eq(rawFinding.scanId, scanId))
        .orderBy(asc(rawFinding.displayId))
    : [];
  const checks: Array<typeof groundingCheck.$inferSelect> = [];
  for (const batch of chunks(ids))
    checks.push(
      ...(await db
        .select()
        .from(groundingCheck)
        .where(inArray(groundingCheck.issueId, batch))
        .orderBy(asc(groundingCheck.position))),
    );
  const aiRuns = await db
    .select()
    .from(aiRun)
    .where(eq(aiRun.scanId, scanId))
    .orderBy(asc(aiRun.createdAt));
  const findingsOf = new Map<string, Array<Omit<(typeof findings)[number], "issueId">>>();
  for (const { issueId, ...f } of findings)
    findingsOf.set(issueId, [...(findingsOf.get(issueId) ?? []), f]);
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
    issues: rows.map((r) => ({
      ...r,
      findings: findingsOf.get(r.id) ?? [],
      checks: checksOf.get(r.id) ?? [],
    })),
    aiRuns,
  };
}

/** Which issue each finding of a scan belongs to (for the findings view). */
export async function findingIssueLinks(db: Database, scanId: string) {
  const rows = await db
    .select({
      rawFindingId: issueFinding.rawFindingId,
      issueId: issue.id,
      displayNo: issueTrack.displayNo,
    })
    .from(issueFinding)
    .innerJoin(issue, eq(issue.id, issueFinding.issueId))
    .innerJoin(issueTrack, eq(issueTrack.id, issue.trackId))
    .where(eq(issue.scanId, scanId));
  return new Map(rows.map((r) => [r.rawFindingId, { issueId: r.issueId, displayNo: r.displayNo }]));
}

/** Issue counts of a scan by origin and grounding outcome (scan page summary). */
export async function scanIssueSummary(db: Database, scanId: string) {
  const [row] = await db
    .select({
      total: sql<number>`count(*)`.mapWith(Number),
      ai: sql<number>`count(*) filter (where ${issue.origin} = 'ai')`.mapWith(Number),
      partial: sql<number>`count(*) filter (where ${issue.groundingStatus} = 'partial')`.mapWith(
        Number,
      ),
      rejected: sql<number>`count(*) filter (where ${issue.groundingStatus} = 'rejected')`.mapWith(
        Number,
      ),
    })
    .from(issue)
    .where(eq(issue.scanId, scanId));
  return row ?? { total: 0, ai: 0, partial: 0, rejected: 0 };
}
