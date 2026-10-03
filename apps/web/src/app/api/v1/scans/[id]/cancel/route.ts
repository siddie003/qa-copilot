import { authedHandler } from "@/server/api";
import { json } from "@/server/http";
import { cancelScan } from "@/server/scans";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export const POST = authedHandler<Params>(
  "POST /api/v1/scans/:id/cancel",
  async (_req, { user, params, log }) => {
    const { id } = await params;
    const result = await cancelScan(user.id, id);
    log.info({ scanId: id, userId: user.id, ...result }, "scan cancellation requested");
    return json(result);
  },
);
