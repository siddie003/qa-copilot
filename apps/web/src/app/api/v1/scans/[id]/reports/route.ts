import { reportCreateSchema } from "@qa/core";
import { getDb, reportsRepo } from "@qa/db";
import { authedHandler } from "@/server/api";
import { json, readJson } from "@/server/http";
import { requestReport, serializeReport } from "@/server/reports";
import { getScan } from "@/server/scans";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** Reports generated for a scan (newest first). */
export const GET = authedHandler<Params>(
  "GET /api/v1/scans/:id/reports",
  async (_req, { user, params }) => {
    const { id } = await params;
    await getScan(user.id, id); // owner check (404 otherwise)
    const { items, total } = await reportsRepo.listReports(getDb(), user.id, {
      scanId: id,
      page: 1,
      pageSize: 100,
    });
    return json({ items: items.map(serializeReport), total });
  },
);

/**
 * Queues a report ({format: pdf|md|json}) of a finished scan; the worker builds it from the
 * stored scan, issue and finding records. Returns 202 with the pending report.
 */
export const POST = authedHandler<Params>(
  "POST /api/v1/scans/:id/reports",
  async (req, { user, params, log }) => {
    const { id } = await params;
    const { format } = await readJson(req, reportCreateSchema);
    const report = await requestReport(user.id, id, format);
    log.info({ scanId: id, reportId: report.id, format, userId: user.id }, "report requested");
    return json(serializeReport(report), { status: 202 });
  },
);
