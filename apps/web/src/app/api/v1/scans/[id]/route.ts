import { authedHandler } from "@/server/api";
import { json } from "@/server/http";
import { getScan } from "@/server/scans";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export const GET = authedHandler<Params>("GET /api/v1/scans/:id", async (_req, { user, params }) =>
  json(await getScan(user.id, (await params).id)),
);
