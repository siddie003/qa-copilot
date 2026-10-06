import { errorFields } from "@qa/core";
import { contentRepo, referencesRepo } from "@qa/db";
import pg from "pg";
import { processNextReferenceJob, type ReferenceRuntime } from "./process";

export interface ReferenceWorker {
  /** Stops after the current job, waiting at most `graceMs` (the job is then recovered later). */
  stop(opts?: { graceMs?: number }): Promise<void>;
}

const IDLE_POLL_MS = 5_000;
const STALE_AFTER_MS = 5 * 60_000;
const RECOVERY_INTERVAL_MS = 60_000;

/**
 * Processes content documents, Figma references and guideline documents one at a time, separate
 * from scans so uploads are not delayed by long scans. Wakes on LISTEN reference_queued with a
 * polling fallback; work left half-done by a stopped worker is failed with a retry hint.
 */
export async function startReferenceWorker(
  rt: ReferenceRuntime,
  databaseUrl: string,
): Promise<ReferenceWorker> {
  const log = rt.log.child({ component: "reference-worker" });
  let stopping = false;
  let wake: (() => void) | null = null;

  // On start and then periodically: jobs of a crashed or vanished worker are failed with a hint.
  const recover = async () => {
    const docs = await contentRepo.recoverStaleDocuments(rt.db, STALE_AFTER_MS);
    const refs = await referencesRepo.recoverStaleReferences(rt.db, STALE_AFTER_MS);
    if (docs.length || refs.length)
      log.warn(
        { documents: docs, references: refs },
        "marked interrupted reference jobs as failed",
      );
  };
  await recover();
  const recoveryTimer = setInterval(() => {
    recover().catch((err) => log.error(errorFields(err), "stale reference job recovery failed"));
  }, RECOVERY_INTERVAL_MS);

  const listener = new pg.Client({
    connectionString: databaseUrl,
    application_name: "qa-copilot-worker-references",
  });
  listener.on("error", (err) =>
    log.error(errorFields(err), "LISTEN connection error (polling continues)"),
  );
  try {
    await listener.connect();
    await listener.query(`LISTEN ${contentRepo.REFERENCE_QUEUED_CHANNEL}`);
    listener.on("notification", () => wake?.());
  } catch (err) {
    log.warn(errorFields(err), "could not LISTEN for reference jobs; falling back to polling");
  }

  const running = (async () => {
    while (!stopping) {
      try {
        if (await processNextReferenceJob(rt)) continue;
      } catch (err) {
        log.error(errorFields(err), "reference loop error");
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
  log.info("reference worker started");

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
