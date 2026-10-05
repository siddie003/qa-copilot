import "server-only";
import { notFound, type IssueStatusChange } from "@qa/core";
import { getDb, issuesRepo } from "@qa/db";
import { z } from "zod";
import { toListOptions, type IssueFilters } from "@/lib/issue-filters";

const uuid = z.uuid();

/** Malformed ids are indistinguishable from missing ones. */
export function assertIssueId(id: string) {
  if (!uuid.safeParse(id).success) throw notFound("Issue");
}

export const ISSUE_PAGE_SIZE = 25;

export function listIssues(
  userId: string,
  filters: IssueFilters,
  opts: { projectId?: string; pageSize?: number } = {},
) {
  return issuesRepo.listIssues(getDb(), userId, {
    ...toListOptions(filters),
    projectId: opts.projectId,
    pageSize: opts.pageSize ?? ISSUE_PAGE_SIZE,
  });
}

export async function getIssue(userId: string, issueId: string, scanId?: string) {
  assertIssueId(issueId);
  const detail = await issuesRepo.getIssueDetail(getDb(), userId, issueId, {
    scanId: scanId && uuid.safeParse(scanId).success ? scanId : undefined,
  });
  if (!detail) throw notFound("Issue");
  return detail;
}

/** Changes the status of one or more issues; unknown or foreign ids → 404 and nothing changes. */
export async function changeStatus(userId: string, ids: string[], change: IssueStatusChange) {
  ids.forEach(assertIssueId);
  const result = await issuesRepo.changeIssueStatus(getDb(), userId, ids, {
    status: change.status,
    note: change.note,
    userId,
  });
  if (!result.ok) throw notFound(ids.length === 1 ? "Issue" : "One or more issues");
  return result;
}
