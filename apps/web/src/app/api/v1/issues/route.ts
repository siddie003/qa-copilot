import { z } from "zod";
import { parseIssueFilters, searchParamsToRecord } from "@/lib/issue-filters";
import { authedHandler } from "@/server/api";
import { json } from "@/server/http";
import { listIssues } from "@/server/issues";

export const runtime = "nodejs";

const pageSize = z.coerce.number().int().min(1).max(100).catch(25);

/**
 * Tracked issues across the user's projects. Filters: severity, status, verdict
 * (confirmed|potential|unverified), category, url, minConfidence (0–100), since (1d|7d|30d|90d),
 * q (title or ISSUE-number), sort, page, pageSize; projectId narrows to one project.
 */
export const GET = authedHandler("GET /api/v1/issues", async (req, { user }) => {
  const sp = req.nextUrl.searchParams;
  const filters = parseIssueFilters(searchParamsToRecord(sp));
  const size = pageSize.parse(sp.get("pageSize") ?? undefined);
  const projectId = sp.get("projectId");
  // A malformed project id matches nothing rather than everything.
  if (projectId !== null && !z.uuid().safeParse(projectId).success)
    return json({ items: [], total: 0, page: filters.page, pageSize: size });
  const result = await listIssues(user.id, filters, {
    projectId: projectId ?? undefined,
    pageSize: size,
  });
  return json({ ...result, page: filters.page, pageSize: size });
});
