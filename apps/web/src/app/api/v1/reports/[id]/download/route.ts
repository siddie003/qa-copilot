import { Readable } from "node:stream";
import { AppError, getConfig, notFound } from "@qa/core";
import { contentTypeForKey, createLocalStorage } from "@qa/storage";
import { authedHandler } from "@/server/api";
import { getReport, reportFileName } from "@/server/reports";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** Streams a completed report file as a download (owner-checked; never rendered inline). */
export const GET = authedHandler<Params>(
  "GET /api/v1/reports/:id/download",
  async (_req, { user, params }) => {
    const report = await getReport(user.id, (await params).id);
    if (report.status !== "completed" || !report.storageKey)
      throw new AppError("CONFLICT", "The report is not ready yet.");
    const storage = createLocalStorage(getConfig().storageDirAbsolute);
    if (!(await storage.exists(report.storageKey))) throw notFound("Report file");
    const { stream, sizeBytes } = await storage.stream(report.storageKey);
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      headers: {
        "content-type": contentTypeForKey(report.storageKey),
        "content-length": String(sizeBytes),
        "content-disposition": `attachment; filename="${reportFileName(report)}"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
      },
    });
  },
);
