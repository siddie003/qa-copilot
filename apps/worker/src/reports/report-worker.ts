import { errorFields } from "@qa/core";
import { reportsRepo } from "@qa/db";
import pg from "pg";
import { processNextReport, type ReportRuntime } from "./generate";

export interface ReportWorker {
  /** Stops after the current report, waiting at most `graceMs` (it is then recovered later). */
  stop(opts?: { graceMs?: number }): Promise<void>;
}

const IDLE_POLL_MS = 5_000;
const STALE_AFTER_MS = 5 * 60_000;
const RECOVERY_INTERVAL_MS = 60_000;

/**
 * Generates queued reports one at a time, separate from scans so a long scan does not delay
 * downloads. Wakes on LISTEN report_queued with a polling fallback; reports left running by a
 * stopped worker are failed with a retry hint.
 */
export async function startReportWorker(
  rt: ReportRuntime,
  databaseUrl: string,
): Promise<ReportWorker> {
  const log = rt.log.child({ component: "report-worker" });
  let stopping = false;
  let wake: (() => void) | null = null;

  // On start and then periodically: reports of a crashed or vanished worker are failed.
  const recover = async () => {
    const stale = await reportsRepo.recoverStaleReports(rt.db, STALE_AFTER_MS);
    if (stale.length) log.warn({ reports: stale }, "marked interrupted reports as failed");
  };
  await recover();
  const recoveryTimer = setInterval(() => {
    recover().catch((err) => log.error(errorFields(err), "stale report recovery failed"));
  }, RECOVERY_INTERVAL_MS);

  const listener = new pg.Client({
    connectionString: databaseUrl,
    application_name: "qa-copilot-worker-reports",
  });
  listener.on("error", (err) =>
    log.error(errorFields(err), "LISTEN connection error (polling continues)"),
  );
  try {
    await listener.connect();
    await listener.query(`LISTEN ${reportsRepo.REPORT_QUEUED_CHANNEL}`);
    listener.on("notification", () => wake?.());
  } catch (err) {
    log.warn(errorFields(err), "could not LISTEN for reports; falling back to polling");
  }

  const running = (async () => {
    while (!stopping) {
      try {
        if (await processNextReport({ ...rt, log })) continue;
      } catch (err) {
        log.error(errorFields(err), "report loop error");
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          wake = null;
          resolve();
        }, IDLE_POLL_MS);
        wake = () => {
          clearTimeout(t);
          wake = null;
          resolve();
        };
      });
    }
  })();
  log.info("report worker started");

  return {
    async stop({ graceMs }: { graceMs?: number } = {}) {
      stopping = true;
      clearInterval(recoveryTimer);
      wake?.();
      await listener.end().catch(() => {});
      if (graceMs === undefined) await running;
      else await Promise.race([running, new Promise((resolve) => setTimeout(resolve, graceMs))]);
    },
  };
}
