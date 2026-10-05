import { authedHandler } from "@/server/api";
import { deleteReference } from "@/server/references";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string; refId: string }> };

/** Removes a Figma link or guideline document (confirmed design values are kept). */
export const DELETE = authedHandler<Params>(
  "DELETE /api/v1/projects/:id/references/:refId",
  async (_req, { user, params, log }) => {
    const { id, refId } = await params;
    await deleteReference(user.id, id, refId);
    log.info({ projectId: id, referenceId: refId }, "reference removed");
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  },
);
