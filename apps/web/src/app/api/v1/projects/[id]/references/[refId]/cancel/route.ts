import { authedHandler } from "@/server/api";
import { json } from "@/server/http";
import { cancelReference } from "@/server/references";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string; refId: string }> };

/**
 * Cancels a reference: queued ones at once; a running Figma read stops before its next request
 * (pages read so far are kept; Fetch again continues where it stopped).
 */
export const POST = authedHandler<Params>(
  "POST /api/v1/projects/:id/references/:refId/cancel",
  async (_req, { user, params }) => {
    const { id, refId } = await params;
    return json(await cancelReference(user.id, id, refId), { status: 202 });
  },
  { rateLimit: "reference" },
);
