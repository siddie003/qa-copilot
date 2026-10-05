import { authedHandler } from "@/server/api";
import { json } from "@/server/http";
import { refreshReference } from "@/server/references";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string; refId: string }> };

/** Queues the reference to be fetched/extracted again by the worker. */
export const POST = authedHandler<Params>(
  "POST /api/v1/projects/:id/references/:refId/refresh",
  async (_req, { user, params, log }) => {
    const { id, refId } = await params;
    const ref = await refreshReference(user.id, id, refId);
    log.info({ projectId: id, referenceId: refId }, "reference queued again");
    return json(ref, { status: 202 });
  },
);
