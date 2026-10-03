import type http from "node:http";
import {
  APP_VERSION,
  ConfigError,
  describeConfig,
  errorFields,
  getConfig,
  getLogger,
} from "@qa/core";
import { checkDatabase, closeDb, getPool } from "@qa/db";
import { boundPort, startHealthServer, type WorkerStatus } from "./health-server";

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
  };

  await runDbCheck();
  const dbTimer = setInterval(() => void runDbCheck(), DB_CHECK_INTERVAL_MS);

  const getStatus = (): WorkerStatus => ({
    status: database.status === "ok" ? "ok" : "degraded",
    version: APP_VERSION,
    startedAt: startedAt.toISOString(),
    uptimeSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
    database,
  });

  let server: http.Server | undefined;
  try {
    server = await startHealthServer(config.WORKER_HEALTH_PORT, getStatus);
    log.info({ port: boundPort(server) }, "worker health endpoint listening on /health");
  } catch (err) {
    log.error(errorFields(err), "could not start worker health endpoint; continuing without it");
  }

  // Scan job consumers (pg-boss) are registered here in Phase 4.
  log.info("worker ready (no job consumers registered yet)");

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "worker shutting down");
    clearInterval(dbTimer);
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
