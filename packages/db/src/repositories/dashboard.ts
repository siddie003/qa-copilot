import { count, eq } from "drizzle-orm";
import type { Database } from "../client";
import { issueTrack, project } from "../schema";
import { ownedProjects } from "./owned";
import { EMPTY_ISSUE_COUNTS, issueCountColumns, type IssueCounts } from "./projects";
import { listScannerRuns, listScans, type ScanListItem, type ScannerRunRow } from "./scans";

export interface DashboardSummary {
  projectCount: number;
  issueCounts: IssueCounts;
  recentScans: ScanListItem[];
  /** Pipeline steps of the most recent scan across all projects (null if never scanned). */
  latestScan: (ScanListItem & { runs: ScannerRunRow[] }) | null;
}

/** Everything on the dashboard, computed from stored rows only. */
export async function getDashboardSummary(
  db: Database,
  ownerId: string,
): Promise<DashboardSummary> {
  const [[projects], [counts], scans] = await Promise.all([
    db.select({ n: count() }).from(project).where(ownedProjects(ownerId)),
    db
      .select(issueCountColumns)
      .from(issueTrack)
      .innerJoin(project, eq(project.id, issueTrack.projectId))
      .where(ownedProjects(ownerId)),
    listScans(db, ownerId, { page: 1, pageSize: 8 }),
  ]);
  const newest = scans.items[0];
  return {
    projectCount: projects?.n ?? 0,
    issueCounts: counts ?? { ...EMPTY_ISSUE_COUNTS },
    recentScans: scans.items,
    latestScan: newest ? { ...newest, runs: await listScannerRuns(db, newest.id) } : null,
  };
}
