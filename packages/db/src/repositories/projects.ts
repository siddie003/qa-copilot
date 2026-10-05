import type { ScanDefaults } from "@qa/core";
import { and, count, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import type { Database } from "../client";
import { issueTrack, project, referenceSource, scan } from "../schema";
import { notifyReferenceQueued } from "./content";
import type { FigmaReferenceValues } from "./references";

export interface IssueCounts {
  total: number;
  open: number;
  inProgress: number;
  resolved: number;
  reopened: number;
  ignored: number;
  inconclusive: number;
  /** Severity counts cover outstanding issues only (open, in progress, reopened). */
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
}

export interface LastScanSummary {
  id: string;
  number: number;
  status: string;
  createdAt: Date;
  finishedAt: Date | null;
}

export interface ProjectSummary {
  id: string;
  name: string;
  websiteUrl: string;
  isDemo: boolean;
  scanDefaults: ScanDefaults;
  createdAt: Date;
  updatedAt: Date;
  lastScan: LastScanSummary | null;
  issueCounts: IssueCounts;
}

export const EMPTY_ISSUE_COUNTS: IssueCounts = {
  total: 0,
  open: 0,
  inProgress: 0,
  resolved: 0,
  reopened: 0,
  ignored: 0,
  inconclusive: 0,
  critical: 0,
  high: 0,
  medium: 0,
  low: 0,
  info: 0,
};

const ownedActive = (ownerId: string) =>
  and(eq(project.ownerId, ownerId), isNull(project.deletedAt));

/** Escapes LIKE wildcards so user search text is matched literally. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

const active = sql`${issueTrack.status} in ('open','in_progress','reopened')`;
const countWhere = (cond: ReturnType<typeof sql>) =>
  sql<number>`count(*) filter (where ${cond})`.mapWith(Number);
const status = (s: string) => sql`${issueTrack.status} = ${s}`;
const activeSeverity = (s: string) => sql`${active} and ${issueTrack.severity} = ${s}`;

/** Aggregate columns over `issue_track` rows; reused by project summaries and the dashboard. */
export const issueCountColumns = {
  total: count(),
  open: countWhere(status("open")),
  inProgress: countWhere(status("in_progress")),
  resolved: countWhere(status("resolved")),
  reopened: countWhere(status("reopened")),
  ignored: countWhere(status("ignored")),
  inconclusive: countWhere(status("inconclusive")),
  critical: countWhere(activeSeverity("critical")),
  high: countWhere(activeSeverity("high")),
  medium: countWhere(activeSeverity("medium")),
  low: countWhere(activeSeverity("low")),
  info: countWhere(activeSeverity("info")),
};

async function loadIssueCounts(db: Database, projectIds: string[]) {
  const result = new Map<string, IssueCounts>();
  if (projectIds.length === 0) return result;
  const rows = await db
    .select({ projectId: issueTrack.projectId, ...issueCountColumns })
    .from(issueTrack)
    .where(inArray(issueTrack.projectId, projectIds))
    .groupBy(issueTrack.projectId);
  for (const { projectId, ...counts } of rows) result.set(projectId, counts);
  return result;
}

async function loadLastScans(db: Database, projectIds: string[]) {
  const result = new Map<string, LastScanSummary>();
  if (projectIds.length === 0) return result;
  const rows = await db
    .selectDistinctOn([scan.projectId], {
      projectId: scan.projectId,
      id: scan.id,
      number: scan.number,
      status: scan.status,
      createdAt: scan.createdAt,
      finishedAt: scan.finishedAt,
    })
    .from(scan)
    .where(inArray(scan.projectId, projectIds))
    .orderBy(scan.projectId, desc(scan.createdAt));
  for (const { projectId, ...last } of rows) result.set(projectId, last);
  return result;
}

type ProjectRow = typeof project.$inferSelect;

async function summarize(db: Database, rows: ProjectRow[]): Promise<ProjectSummary[]> {
  const ids = rows.map((r) => r.id);
  const [counts, lastScans] = await Promise.all([loadIssueCounts(db, ids), loadLastScans(db, ids)]);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    websiteUrl: r.websiteUrl,
    isDemo: r.isDemo,
    scanDefaults: r.scanDefaults,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    lastScan: lastScans.get(r.id) ?? null,
    issueCounts: counts.get(r.id) ?? { ...EMPTY_ISSUE_COUNTS },
  }));
}

export interface ListProjectsOptions {
  q?: string;
  page: number;
  pageSize: number;
  isDemo?: boolean;
}

export async function listProjects(db: Database, ownerId: string, opts: ListProjectsOptions) {
  const filters = [ownedActive(ownerId), eq(project.isDemo, opts.isDemo ?? false)];
  if (opts.q) {
    const pattern = `%${escapeLike(opts.q)}%`;
    filters.push(or(ilike(project.name, pattern), ilike(project.websiteUrl, pattern))!);
  }
  const where = and(...filters);
  const [rows, [totalRow]] = await Promise.all([
    db
      .select()
      .from(project)
      .where(where)
      .orderBy(desc(project.createdAt), desc(project.id))
      .limit(opts.pageSize)
      .offset((opts.page - 1) * opts.pageSize),
    db.select({ total: count() }).from(project).where(where),
  ]);
  return { items: await summarize(db, rows), total: totalRow?.total ?? 0 };
}

export async function getProject(db: Database, ownerId: string, id: string) {
  const [row] = await db
    .select()
    .from(project)
    .where(and(eq(project.id, id), ownedActive(ownerId)));
  if (!row) return undefined;
  const [summary] = await summarize(db, [row]);
  return summary;
}

export interface CreateProjectValues {
  name: string;
  websiteUrl: string;
  scanDefaults: ScanDefaults;
  isDemo?: boolean;
}

/** Creates a project and, optionally, its Figma reference in one transaction. */
export async function createProject(
  db: Database,
  ownerId: string,
  values: CreateProjectValues & { figma?: FigmaReferenceValues },
) {
  const { figma, ...projectValues } = values;
  const row = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(project)
      .values({ ownerId, ...projectValues })
      .returning();
    if (figma)
      await tx
        .insert(referenceSource)
        .values({ projectId: created!.id, kind: "figma", status: "pending", ...figma });
    return created!;
  });
  if (figma) await notifyReferenceQueued(db);
  const [summary] = await summarize(db, [row]);
  return summary!;
}

export async function updateProject(
  db: Database,
  ownerId: string,
  id: string,
  patch: Partial<Pick<CreateProjectValues, "name" | "websiteUrl" | "scanDefaults">>,
) {
  const [row] = await db
    .update(project)
    .set(patch)
    .where(and(eq(project.id, id), ownedActive(ownerId)))
    .returning();
  if (!row) return undefined;
  const [summary] = await summarize(db, [row]);
  return summary;
}

/** Soft delete: the project disappears from all views but scan history stays recoverable. */
export async function softDeleteProject(db: Database, ownerId: string, id: string) {
  const rows = await db
    .update(project)
    .set({ deletedAt: new Date() })
    .where(and(eq(project.id, id), ownedActive(ownerId)))
    .returning({ id: project.id });
  return rows.length > 0;
}

/** Totals across all of a user's (non-demo) projects, for the dashboard. */
export async function countOwnerProjects(db: Database, ownerId: string, isDemo = false) {
  const [row] = await db
    .select({ total: count() })
    .from(project)
    .where(and(ownedActive(ownerId), eq(project.isDemo, isDemo)));
  return row?.total ?? 0;
}
