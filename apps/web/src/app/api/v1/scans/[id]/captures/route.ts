import { getDb, pipelineRepo } from "@qa/db";
import { authedHandler } from "@/server/api";
import { json } from "@/server/http";
import { getScan } from "@/server/scans";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export const GET = authedHandler<Params>(
  "GET /api/v1/scans/:id/captures",
  async (_req, { user, params }) => {
    const { id } = await params;
    await getScan(user.id, id); // validates the id and ownership (404 otherwise)
    return json({ items: await pipelineRepo.listCapturesForScan(getDb(), user.id, id) });
  },
);
