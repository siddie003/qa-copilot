import { authedHandler } from "@/server/api";
import { json } from "@/server/http";
import { retryContentDocument } from "@/server/references";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** Queues a document that failed to process for another attempt. */
export const POST = authedHandler<Params>(
  "POST /api/v1/content-documents/:id/retry",
  async (_req, { user, params }) =>
    json(await retryContentDocument(user.id, (await params).id), { status: 202 }),
  { rateLimit: "reference" },
);
