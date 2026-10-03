import { and, count, desc, eq } from "drizzle-orm";
import type { Database } from "../client";
import { project, report, scan } from "../schema";
import { ownedProjects } from "./owned";

export async function listReports(
  db: Database,
  ownerId: string,
  opts: { projectId?: string; page: number; pageSize: number },
) {
  const where = and(
    ownedProjects(ownerId),
    opts.projectId ? eq(scan.projectId, opts.projectId) : undefined,
  );
  const base = () =>
    db
      .select({
        id: report.id,
        format: report.format,
        status: report.status,
        sizeBytes: report.sizeBytes,
        error: report.error,
        createdAt: report.createdAt,
        completedAt: report.completedAt,
        scanId: scan.id,
        scanNumber: scan.number,
        projectId: project.id,
        projectName: project.name,
      })
      .from(report)
      .innerJoin(scan, eq(scan.id, report.scanId))
      .innerJoin(project, eq(project.id, scan.projectId));
  const [items, [totalRow]] = await Promise.all([
    base()
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
