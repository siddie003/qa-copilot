import { authedHandler } from "@/server/api";
import { json } from "@/server/http";
import { listContentBlocks } from "@/server/references";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** Extracted blocks of a document (type, text, link target, page hint, location). */
export const GET = authedHandler<Params>(
  "GET /api/v1/content-documents/:id/blocks",
  async (_req, { user, params }) => json(await listContentBlocks(user.id, (await params).id)),
);
