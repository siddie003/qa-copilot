import { authedHandler } from "@/server/api";
import { json } from "@/server/http";
import { listIssues } from "@/server/issues";
import { getProject } from "@/server/projects";
import { parseIssueFilters, searchParamsToRecord } from "@/lib/issue-filters";
import { z } from "zod";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

const pageSize = z.coerce.number().int().min(1).max(100).catch(25);

/** Tracked issues of one project (same filters as GET /api/v1/issues). */
export const GET = authedHandler<Params>(
  "GET /api/v1/projects/:id/issues",
  async (req, { user, params }) => {
    const project = await getProject(user.id, (await params).id);
    const sp = req.nextUrl.searchParams;
    const filters = parseIssueFilters(searchParamsToRecord(sp));
    const size = pageSize.parse(sp.get("pageSize") ?? undefined);
    const result = await listIssues(user.id, filters, { projectId: project.id, pageSize: size });
    return json({ ...result, page: filters.page, pageSize: size });
  },
);
