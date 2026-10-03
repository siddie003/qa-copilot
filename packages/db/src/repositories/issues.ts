import type { IssueStatus, Severity } from "@qa/core";
import { and, asc, count, desc, eq, ilike, inArray, or } from "drizzle-orm";
import type { Database } from "../client";
import { issueTrack, project } from "../schema";
import { ownedProjects } from "./owned";
import { escapeLike } from "./projects";

export type IssueSort = "severity" | "status" | "category" | "date";

export interface IssueListOptions {
  projectId?: string;
  severities?: Severity[];
  statuses?: IssueStatus[];
  category?: string;
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
  updatedAt: Date;
}

// Postgres orders enums by declaration order: critical..info, open..inconclusive.
const ORDER: Record<IssueSort, ReturnType<typeof asc>[]> = {
  severity: [asc(issueTrack.severity), desc(issueTrack.updatedAt)],
  status: [asc(issueTrack.status), asc(issueTrack.severity)],
  category: [asc(issueTrack.category), asc(issueTrack.severity)],
  date: [desc(issueTrack.updatedAt)],
};

/** Tracked issues across the user's projects, filtered and paginated. */
export async function listIssues(db: Database, ownerId: string, opts: IssueListOptions) {
  const filters = [
    ownedProjects(ownerId),
    opts.projectId ? eq(issueTrack.projectId, opts.projectId) : undefined,
    opts.severities?.length ? inArray(issueTrack.severity, opts.severities) : undefined,
    opts.statuses?.length ? inArray(issueTrack.status, opts.statuses) : undefined,
    opts.category ? eq(issueTrack.category, opts.category) : undefined,
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
        updatedAt: issueTrack.updatedAt,
      })
      .from(issueTrack)
      .innerJoin(project, eq(project.id, issueTrack.projectId))
      .where(where)
      .orderBy(...ORDER[opts.sort ?? "severity"], asc(issueTrack.displayNo))
      .limit(opts.pageSize)
      .offset((opts.page - 1) * opts.pageSize),
    db
      .select({ total: count() })
      .from(issueTrack)
      .innerJoin(project, eq(project.id, issueTrack.projectId))
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
