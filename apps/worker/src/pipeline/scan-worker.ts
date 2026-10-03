import os from "node:os";
import { errorFields } from "@qa/core";
import { pipelineRepo } from "@qa/db";
import pg from "pg";
import { runScan, type ScanRuntime } from "./run-scan";

export interface ScanWorker {
  readonly workerId: string;
  readonly concurrency: number;
  currentScanIds(): string[];
  stop(): Promise<void>;
}

const IDLE_POLL_MS = 5_000;
const STALE_AFTER_MS = 120_000;

/**
 * Processes queued scans one at a time. Picks up new work immediately via LISTEN scan_queued,
 * with a polling fallback. On start, scans left "running" by a crashed worker are marked failed.
 */
export async function startScanWorker(
  rt: ScanRuntime,
  databaseUrl: string,
  concurrency = 1,
): Promise<ScanWorker> {
  const workerId = `${os.hostname()}:${process.pid}`;
  const log = rt.log.child({ component: "scan-worker", workerId });
  const current = new Set<string>();
  let stopping = false;
  const sleepers = new Set<() => void>();
  const wakeAll = () => {
    for (const w of [...sleepers]) w();
  };

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
    listener.on("notification", wakeAll);
  } catch (err) {
    log.warn(errorFields(err), "could not LISTEN for new scans; falling back to polling");
  }

  const loop = async (slot: number) => {
    while (!stopping) {
      try {
        const scan = await pipelineRepo.claimNextScan(rt.db, `${workerId}#${slot}`);
        if (scan) {
          current.add(scan.id);
          try {
            await runScan(rt, scan);
          } finally {
            current.delete(scan.id);
          }
          continue;
        }
      } catch (err) {
        log.error(errorFields(err), "scan loop error");
      }
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(t);
          sleepers.delete(done);
          resolve();
        };
        const t = setTimeout(done, IDLE_POLL_MS);
        sleepers.add(done);
      });
    }
  };
  const running = Promise.all(Array.from({ length: concurrency }, (_, i) => loop(i + 1)));
  log.info({ concurrency }, "scan worker started");

  return {
    workerId,
    concurrency,
    currentScanIds: () => [...current],
    async stop() {
      stopping = true;
      wakeAll();
      await listener.end().catch(() => {});
      await running;
    },
  };
}
