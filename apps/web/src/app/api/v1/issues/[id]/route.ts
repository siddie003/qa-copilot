import { authedHandler } from "@/server/api";
import { json } from "@/server/http";
import { getIssue } from "@/server/issues";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/**
 * One tracked issue: its occurrences (one per scan), the selected occurrence (latest, or
 * ?scanId=) with source findings, evidence and grounding checks, and the status history.
 */
export const GET = authedHandler<Params>(
  "GET /api/v1/issues/:id",
  async (req, { user, params }) => {
    const { id } = await params;
    const detail = await getIssue(user.id, id, req.nextUrl.searchParams.get("scanId") ?? undefined);
    return json(detail);
  },
);
