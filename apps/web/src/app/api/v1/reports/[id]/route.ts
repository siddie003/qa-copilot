import { AppError, getConfig, notFound } from "@qa/core";
import { getDb, reportsRepo } from "@qa/db";
import { createLocalStorage } from "@qa/storage";
import { authedHandler } from "@/server/api";
import { json } from "@/server/http";
import { assertReportId, getReport, serializeReport } from "@/server/reports";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** Report status (poll while pending/running). */
export const GET = authedHandler<Params>(
  "GET /api/v1/reports/:id",
  async (_req, { user, params }) =>
    json(serializeReport(await getReport(user.id, (await params).id))),
);

/** Deletes a report and its file (not while it is being generated). */
export const DELETE = authedHandler<Params>(
  "DELETE /api/v1/reports/:id",
  async (_req, { user, params, log }) => {
    const { id } = await params;
    assertReportId(id);
    const result = await reportsRepo.deleteReport(getDb(), user.id, id);
    if (result.kind === "not_found") throw notFound("Report");
    if (result.kind === "running")
      throw new AppError(
        "CONFLICT",
        "The report is being generated; delete it when it has finished.",
      );
    if (result.storageKey)
      await createLocalStorage(getConfig().storageDirAbsolute)
        .removePrefix(result.storageKey)
        .catch((err) => log.warn({ err: String(err), reportId: id }, "report file not removed"));
    log.info({ reportId: id, userId: user.id }, "report deleted");
    return new Response(null, { status: 204 });
  },
);
