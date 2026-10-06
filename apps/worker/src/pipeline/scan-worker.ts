import os from "node:os";
import { errorFields } from "@qa/core";
import { pipelineRepo } from "@qa/db";
import pg from "pg";
import { runScan, type ScanRuntime } from "./run-scan";

export interface ScanWorker {
  readonly workerId: string;
  readonly concurrency: number;
  currentScanIds(): string[];
  /**
   * Stops claiming scans and lets running scans continue for `graceMs`; scans still running after
   * that are stopped and recorded as failed ("the worker was shut down"), keeping what they stored.
   */
  stop(opts?: { graceMs?: number }): Promise<void>;
}

export interface ScanWorkerOptions {
  concurrency?: number;
  /** How often stale scans (no heartbeat for STALE_AFTER_MS) are recovered. Default 60 s. */
  recoveryIntervalMs?: number;
  staleAfterMs?: number;
}

const IDLE_POLL_MS = 5_000;
const STALE_AFTER_MS = 120_000;
const RECOVERY_INTERVAL_MS = 60_000;
/** After the grace period, how long stopped scans may take to record their final state. */
const ABORT_WIND_DOWN_MS = 30_000;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Processes queued scans (`concurrency` at a time). Picks up new work immediately via LISTEN
 * scan_queued, with a polling fallback. Scans left "running" by a crashed or vanished worker are
 * marked failed on start and then periodically, so they never block their project for good.
 */
export async function startScanWorker(
  rt: ScanRuntime,
  databaseUrl: string,
  concurrencyOrOptions: number | ScanWorkerOptions = 1,
): Promise<ScanWorker> {
  const opts: ScanWorkerOptions =
    typeof concurrencyOrOptions === "number"
      ? { concurrency: concurrencyOrOptions }
      : concurrencyOrOptions;
  const concurrency = opts.concurrency ?? 1;
  const staleAfterMs = opts.staleAfterMs ?? STALE_AFTER_MS;
  const workerId = `${os.hostname()}:${process.pid}`;
  const log = rt.log.child({ component: "scan-worker", workerId });
  const current = new Set<string>();
  let stopping = false;
  const shutdown = new AbortController();
  const sleepers = new Set<() => void>();
  const wakeAll = () => {
    for (const w of [...sleepers]) w();
  };

  const recover = async () => {
    const recovered = await pipelineRepo.failStaleScans(rt.db, staleAfterMs);
    if (recovered.length) log.warn({ scanIds: recovered }, "marked interrupted scans as failed");
  };
  await recover();
  const recoveryTimer = setInterval(() => {
    recover().catch((err) => log.error(errorFields(err), "stale scan recovery failed"));
  }, opts.recoveryIntervalMs ?? RECOVERY_INTERVAL_MS);

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
            await runScan({ ...rt, shutdown: shutdown.signal }, scan);
          } finally {
            current.delete(scan.id);
          }
          continue;
        }
      } catch (err) {
        log.error(errorFields(err), "scan loop error");
      }
      if (stopping) break;
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
    async stop({ graceMs = 0 } = {}) {
      stopping = true;
      clearInterval(recoveryTimer);
      wakeAll();
      await listener.end().catch(() => {});
      const finished = await Promise.race([
        running.then(() => true),
        delay(graceMs).then(() => false),
      ]);
      if (finished) return;
      log.warn(
        { scanIds: [...current], graceMs },
        "grace period over: stopping running scans (recorded as interrupted)",
      );
      shutdown.abort();
      await Promise.race([running, delay(ABORT_WIND_DOWN_MS)]);
    },
  };
}
