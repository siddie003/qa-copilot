import { authedHandler } from "@/server/api";
import { json } from "@/server/http";
import { cancelContentDocument } from "@/server/references";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/**
 * Cancels processing of a document: a queued one at once, one being processed within seconds
 * (what was read so far is kept; Retry continues where it stopped).
 */
export const POST = authedHandler<Params>(
  "POST /api/v1/content-documents/:id/cancel",
  async (_req, { user, params }) =>
    json(await cancelContentDocument(user.id, (await params).id), { status: 202 }),
  { rateLimit: "reference" },
);
