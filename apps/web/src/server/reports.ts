import "server-only";
import { AppError, notFound, type ReportFormatKey } from "@qa/core";
import { getDb, reportsRepo, type ReportListItem } from "@qa/db";
import { z } from "zod";
import { assertScanId } from "./scans";

const uuid = z.uuid();

export function assertReportId(id: string) {
  if (!uuid.safeParse(id).success) throw notFound("Report");
}

const SCAN_STATUS_TEXT: Record<string, string> = {
  queued: "has not started yet",
  running: "is still running",
};

/** Queues a report of a finished scan for the worker. */
export async function requestReport(userId: string, scanId: string, format: ReportFormatKey) {
  assertScanId(scanId);
  const result = await reportsRepo.createReport(getDb(), userId, scanId, format, userId);
  switch (result.kind) {
    case "not_found":
      throw notFound("Scan");
    case "not_finished":
      throw new AppError(
        "CONFLICT",
        `The scan ${SCAN_STATUS_TEXT[result.scanStatus] ?? "is not finished"}. Reports are generated from finished scans.`,
      );
    case "in_progress":
      throw new AppError(
        "CONFLICT",
        "A report in this format is already being generated for this scan.",
        { details: { reportId: result.reportId } },
      );
    default:
      return result.report;
  }
}

export async function getReport(userId: string, reportId: string) {
  assertReportId(reportId);
  const row = await reportsRepo.getReport(getDb(), userId, reportId);
  if (!row) throw notFound("Report");
  return row;
}

/** Report fields safe to return to the client (the storage key stays on the server). */
export function serializeReport(r: ReportListItem & { storageKey?: string | null }) {
  const { storageKey: _key, ...rest } = r;
  return {
    ...rest,
    downloadUrl: r.status === "completed" ? `/api/v1/reports/${r.id}/download` : null,
  };
}

const slug = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .toLowerCase()
    .slice(0, 60) || "project";

/** Download file name, e.g. qa-report-acme-site-scan-3.pdf (ASCII only). */
export const reportFileName = (r: { projectName: string; scanNumber: number; format: string }) =>
  `qa-report-${slug(r.projectName)}-scan-${r.scanNumber}.${r.format}`;
