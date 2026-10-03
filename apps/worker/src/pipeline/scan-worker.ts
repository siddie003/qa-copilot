import os from "node:os";
import { errorFields } from "@qa/core";
import { pipelineRepo } from "@qa/db";
import pg from "pg";
import { runScan, type ScanRuntime } from "./run-scan";

export interface ScanWorker {
  readonly workerId: string;
  currentScanId(): string | null;
  stop(): Promise<void>;
}

const IDLE_POLL_MS = 5_000;
const STALE_AFTER_MS = 120_000;

/**
 * Processes queued scans one at a time. Picks up new work immediately via LISTEN scan_queued,
 * with a polling fallback. On start, scans left "running" by a crashed worker are marked failed.
 */
export async function startScanWorker(rt: ScanRuntime, databaseUrl: string): Promise<ScanWorker> {
  const workerId = `${os.hostname()}:${process.pid}`;
  const log = rt.log.child({ component: "scan-worker", workerId });
  let current: string | null = null;
  let stopping = false;
  let wake: (() => void) | null = null;

  const recovered = await pipelineRepo.failStaleScans(rt.db, STALE_AFTER_MS);
  if (recovered.length) log.warn({ scanIds: recovered }, "marked interrupted scans as failed");

  const listener = new pg.Client({
    connectionString: databaseUrl,
    application_name: "qa-copilot-worker-listen",
  });
  listener.on("error", (err) =>
    log.error(errorFields(err), "LISTEN connection error (polling continues)"),
  );
  try {
    await listener.connect();
    await listener.query("LISTEN scan_queued");
    listener.on("notification", () => wake?.());
  } catch (err) {
    log.warn(errorFields(err), "could not LISTEN for new scans; falling back to polling");
  }

  const loop = async () => {
    while (!stopping) {
      try {
        const scan = await pipelineRepo.claimNextScan(rt.db, workerId);
        if (scan) {
          current = scan.id;
          await runScan(rt, scan);
          current = null;
          continue;
        }
      } catch (err) {
        log.error(errorFields(err), "scan loop error");
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, IDLE_POLL_MS);
        wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
      wake = null;
    }
  };
  const running = loop();
  log.info("scan worker started");

  return {
    workerId,
    currentScanId: () => current,
    async stop() {
      stopping = true;
      wake?.();
      await listener.end().catch(() => {});
      await running;
    },
  };
}
