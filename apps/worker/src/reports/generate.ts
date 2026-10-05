import { APP_NAME, APP_VERSION, errorFields, type Logger } from "@qa/core";
import { launchBrowser, renderPdf } from "@qa/browser";
import { reportsRepo, type Database } from "@qa/db";
import {
  buildReportData,
  REPORT_EXTENSIONS,
  renderHtml,
  renderJson,
  renderMarkdown,
  type ReportData,
  type ReportFormat,
} from "@qa/reports";
import type { Storage } from "@qa/storage";

export interface ReportRuntime {
  db: Database;
  storage: Storage;
  log: Logger;
  /** Clock for `generatedAt` (tests pin it). */
  now?: () => Date;
}

const PDF_TIMEOUT_MS = 120_000;

/** Storage key of a report file; never derived from user input. */
export const reportStorageKey = (scanId: string, reportId: string, format: ReportFormat) =>
  `reports/${scanId}/${reportId}.${REPORT_EXTENSIONS[format]}`;

async function render(data: ReportData, format: ReportFormat): Promise<Buffer> {
  if (format === "json") return Buffer.from(renderJson(data), "utf8");
  if (format === "md") return Buffer.from(renderMarkdown(data), "utf8");
  const session = await launchBrowser();
  try {
    return await renderPdf(session.browser, renderHtml(data), {
      footer: `${data.project.name} · Scan #${data.scan.number} · ${APP_NAME} report`,
      timeoutMs: PDF_TIMEOUT_MS,
    });
  } finally {
    await session.close().catch(() => {});
  }
}

/**
 * Claims and generates one pending report. Returns false when there was nothing to do.
 * Failures mark only that report failed (with the reason); nothing else is changed.
 */
export async function processNextReport(rt: ReportRuntime): Promise<boolean> {
  const job = await reportsRepo.claimNextReport(rt.db);
  if (!job) return false;
  const log = rt.log.child({ reportId: job.id, scanId: job.scanId, format: job.format });
  const started = Date.now();
  try {
    const source = await reportsRepo.loadReportSource(rt.db, job.scanId);
    if (!source) throw new Error("The scan no longer exists.");
    const data = buildReportData(source, {
      generatedAt: (rt.now ?? (() => new Date()))(),
      generator: { name: APP_NAME, version: APP_VERSION },
    });
    const body = await render(data, job.format);
    const key = reportStorageKey(job.scanId, job.id, job.format);
    const { sizeBytes } = await rt.storage.put(key, body);
    const stored = await reportsRepo.completeReport(rt.db, job.id, { storageKey: key, sizeBytes });
    // Deleted or recovered while generating: do not leave an orphaned file behind.
    if (!stored) await rt.storage.removePrefix(key).catch(() => {});
    log.info(
      { durationMs: Date.now() - started, sizeBytes, issues: data.issues.length },
      "report generated",
    );
  } catch (err) {
    log.error({ ...errorFields(err), durationMs: Date.now() - started }, "report failed");
    const message = err instanceof Error ? err.message : String(err);
    await reportsRepo.failReport(rt.db, job.id, `Report generation failed: ${message}`);
  }
  return true;
}
