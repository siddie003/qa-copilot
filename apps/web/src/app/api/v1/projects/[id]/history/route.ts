import { authedHandler } from "@/server/api";
import { projectHistory } from "@/server/comparisons";
import { json } from "@/server/http";
import { z } from "zod";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

const page = z.coerce.number().int().min(1).catch(1);
const pageSize = z.coerce.number().int().min(1).max(100).catch(25);

/**
 * Scan history of a project: every scan (newest first) with issue counts by severity and verdict
 * and its changes compared with the previous comparable scan, plus the trend of the latest
 * comparable scans (oldest first).
 */
export const GET = authedHandler<Params>(
  "GET /api/v1/projects/:id/history",
  async (req, { user, params }) => {
    const sp = req.nextUrl.searchParams;
    const opts = {
      page: page.parse(sp.get("page") ?? undefined),
      pageSize: pageSize.parse(sp.get("pageSize") ?? undefined),
    };
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the full scan list is UI-only
    const { project, scans, ...history } = await projectHistory(user.id, (await params).id, opts);
    return json({ projectId: project.id, ...opts, ...history });
  },
);
