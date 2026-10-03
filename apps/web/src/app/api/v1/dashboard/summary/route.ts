import { dashboardRepo, getDb } from "@qa/db";
import { authedHandler } from "@/server/api";
import { json } from "@/server/http";

export const runtime = "nodejs";

/** Dashboard figures for the signed-in user, computed from stored records only. */
export const GET = authedHandler("GET /api/v1/dashboard/summary", async (_req, { user }) =>
  json(await dashboardRepo.getDashboardSummary(getDb(), user.id)),
);
