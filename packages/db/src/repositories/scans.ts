import { and, asc, count, desc, eq, sql } from "drizzle-orm";
import type { Database } from "../client";
import { project, scan, scannerRun } from "../schema";
import { ownedProjects } from "./owned";

export interface ScanListItem {
  id: string;
  number: number;
  status: string;
  projectId: string;
  projectName: string;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  findingCount: number;
  failedSteps: number;
}

const scanColumns = {
  id: scan.id,
  number: scan.number,
  status: scan.status,
  projectId: scan.projectId,
  projectName: project.name,
  createdAt: scan.createdAt,
  startedAt: scan.startedAt,
  finishedAt: scan.finishedAt,
  findingCount:
    sql<number>`coalesce((select sum(${scannerRun.findingCount}) from ${scannerRun} where ${scannerRun.scanId} = ${scan.id}), 0)`.mapWith(
      Number,
    ),
  failedSteps:
    sql<number>`(select count(*) from ${scannerRun} where ${scannerRun.scanId} = ${scan.id} and ${scannerRun.status} = 'failed')`.mapWith(
      Number,
    ),
};

export async function listScans(
  db: Database,
  ownerId: string,
  opts: { projectId?: string; page: number; pageSize: number },
): Promise<{ items: ScanListItem[]; total: number }> {
  const where = and(
    ownedProjects(ownerId),
    opts.projectId ? eq(scan.projectId, opts.projectId) : undefined,
  );
  const [items, [totalRow]] = await Promise.all([
    db
      .select(scanColumns)
      .from(scan)
      .innerJoin(project, eq(project.id, scan.projectId))
      .where(where)
      .orderBy(desc(scan.createdAt), desc(scan.id))
      .limit(opts.pageSize)
      .offset((opts.page - 1) * opts.pageSize),
    db
      .select({ total: count() })
      .from(scan)
      .innerJoin(project, eq(project.id, scan.projectId))
      .where(where),
  ]);
  return { items, total: totalRow?.total ?? 0 };
}

export interface ScannerRunRow {
  id: string;
  stepKey: string;
  position: number;
  status: string;
  statusReason: string | null;
  error: string | null;
  findingCount: number;
  toolName: string | null;
  toolVersion: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  durationMs: number | null;
  checks: Record<string, unknown> | null;
}

export async function listScannerRuns(db: Database, scanId: string): Promise<ScannerRunRow[]> {
  return db
    .select({
      id: scannerRun.id,
      stepKey: scannerRun.stepKey,
      position: scannerRun.position,
      status: scannerRun.status,
      statusReason: scannerRun.statusReason,
      error: scannerRun.error,
      findingCount: scannerRun.findingCount,
      toolName: scannerRun.toolName,
      toolVersion: scannerRun.toolVersion,
      startedAt: scannerRun.startedAt,
      finishedAt: scannerRun.finishedAt,
      durationMs: scannerRun.durationMs,
      checks: scannerRun.checks,
    })
    .from(scannerRun)
    .where(eq(scannerRun.scanId, scanId))
    .orderBy(asc(scannerRun.position));
}

/** Most recent scan of a project (owner-checked) with its pipeline steps, or null. */
export async function getLatestScan(db: Database, ownerId: string, projectId: string) {
  const [latest] = await db
    .select(scanColumns)
    .from(scan)
    .innerJoin(project, eq(project.id, scan.projectId))
    .where(and(ownedProjects(ownerId), eq(scan.projectId, projectId)))
    .orderBy(desc(scan.createdAt))
    .limit(1);
  if (!latest) return null;
  return { ...latest, runs: await listScannerRuns(db, latest.id) };
}
