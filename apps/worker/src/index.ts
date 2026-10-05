import type http from "node:http";
import {
  APP_VERSION,
  ConfigError,
  describeConfig,
  errorFields,
  getConfig,
  getLogger,
} from "@qa/core";
import { checkDatabase, closeDb, getDb, getMigrationStatus, getPool } from "@qa/db";
import { createLocalStorage } from "@qa/storage";
import { boundPort, startHealthServer, type WorkerStatus } from "./health-server";
import { startScanWorker, type ScanWorker } from "./pipeline/scan-worker";
import { startReferenceWorker, type ReferenceWorker } from "./references/reference-worker";
import { startReportWorker, type ReportWorker } from "./reports/report-worker";

const DB_CHECK_INTERVAL_MS = 15_000;

async function main() {
  const log = getLogger().child({ component: "worker" });

  let config;
  try {
    config = getConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      log.fatal({ issues: err.issues }, "invalid configuration; fix .env and restart");
      process.exit(1);
    }
    throw err;
  }
  log.info({ version: APP_VERSION, config: describeConfig(config) }, "worker starting");

  const startedAt = new Date();
  let database: WorkerStatus["database"] = { status: "pending" };

  let scanWorker: ScanWorker | undefined;
  let referenceWorker: ReferenceWorker | undefined;
  let reportWorker: ReportWorker | undefined;
  let scanWorkerStarting = false;
  const ensureScanWorker = async () => {
    if (scanWorker || scanWorkerStarting) return;
    scanWorkerStarting = true;
    try {
      // Never process scans against an outdated schema.
      const migrations = await getMigrationStatus(getPool());
      if (migrations.pending > 0) {
        log.error(
          { pending: migrations.pending },
          "database migrations pending; run `npm run db:migrate`. Scan processing is paused.",
        );
        return;
      }
      const storage = createLocalStorage(config.storageDirAbsolute);
      scanWorker = await startScanWorker(
        { db: getDb(), storage, config, log },
        config.DATABASE_URL,
        config.WORKER_CONCURRENCY,
      );
      referenceWorker = await startReferenceWorker(
        { db: getDb(), storage, config, log },
        config.DATABASE_URL,
      );
      reportWorker = await startReportWorker({ db: getDb(), storage, log }, config.DATABASE_URL);
    } catch (err) {
      log.error(errorFields(err), "could not start scan worker; retrying on next database check");
    } finally {
      scanWorkerStarting = false;
    }
  };

  const runDbCheck = async () => {
    const previous = database.status;
    const result = await checkDatabase(getPool());
    database = { ...result, checkedAt: new Date().toISOString() };
    if (result.status !== previous) {
      if (result.status === "ok")
        log.info(
          { serverVersion: result.serverVersion, latencyMs: result.latencyMs },
          "database connected",
        );
      else log.error({ code: result.code, reason: result.message }, "database unavailable");
    }
    // The scan worker needs the database; start it as soon as the database is reachable.
    if (result.status === "ok") await ensureScanWorker();
  };

  await runDbCheck();
  const dbTimer = setInterval(() => void runDbCheck(), DB_CHECK_INTERVAL_MS);

  const getStatus = (): WorkerStatus => ({
    status: database.status === "ok" ? "ok" : "degraded",
    version: APP_VERSION,
    startedAt: startedAt.toISOString(),
    uptimeSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
    database,
    scanWorker: scanWorker
      ? {
          status: "running",
          workerId: scanWorker.workerId,
          concurrency: scanWorker.concurrency,
          currentScanIds: scanWorker.currentScanIds(),
        }
      : { status: "not_started" },
    referenceWorker: { status: referenceWorker ? "running" : "not_started" },
    reportWorker: { status: reportWorker ? "running" : "not_started" },
  });

  let server: http.Server | undefined;
  try {
    server = await startHealthServer(config.WORKER_HEALTH_PORT, getStatus);
    log.info({ port: boundPort(server) }, "worker health endpoint listening on /health");
  } catch (err) {
    log.error(errorFields(err), "could not start worker health endpoint; continuing without it");
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "worker shutting down");
    clearInterval(dbTimer);
    // Lets the current page finish; an interrupted scan is marked failed on the next start.
    await Promise.all([
      scanWorker?.stop().catch((err) => log.error(errorFields(err), "error stopping scan worker")),
      referenceWorker
        ?.stop()
        .catch((err) => log.error(errorFields(err), "error stopping reference worker")),
      reportWorker
        ?.stop()
        .catch((err) => log.error(errorFields(err), "error stopping report worker")),
    ]);
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    await closeDb().catch((err) => log.error(errorFields(err), "error closing database pool"));
    log.info("worker stopped");
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

process.on("unhandledRejection", (reason) => {
  getLogger().error(errorFields(reason), "unhandled promise rejection");
});

main().catch((err) => {
  getLogger().fatal(errorFields(err), "worker crashed during startup");
  process.exit(1);
});
