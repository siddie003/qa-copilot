import "server-only";
import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { APP_VERSION, ConfigError, errorFields, getConfig, getLogger } from "@qa/core";
import { checkDatabase, getPool, type DatabaseHealth } from "@qa/db";

export type ComponentCheck<T extends object = object> =
  | ({ status: "ok" } & T)
  | { status: "error"; code: string; message: string; invalidVariables?: string[] }
  | { status: "skipped"; reason: string };

export interface ReadinessReport {
  status: "ready" | "not_ready";
  version: string;
  checkedAt: string;
  checks: {
    config: ComponentCheck;
    database: DatabaseHealth | { status: "skipped"; reason: string };
    storage: ComponentCheck<{ path: string }>;
  };
}

/** Verifies the storage directory exists (creating it if needed) and is writable. */
export async function checkStorage(dir: string): Promise<ComponentCheck<{ path: string }>> {
  const probe = path.join(dir, `.healthcheck-${randomUUID()}`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(probe, "ok");
    await unlink(probe);
    return { status: "ok", path: dir };
  } catch (err) {
    getLogger().error({ ...errorFields(err), dir }, "storage check failed");
    return {
      status: "error",
      code: "STORAGE_NOT_WRITABLE",
      message: "Storage directory is not writable",
    };
  }
}

/**
 * Runs real dependency checks. Used by /api/v1/health/ready and the Settings page.
 * `includeDetails` adds invalid variable names and filesystem paths (never secret values).
 */
export async function runReadinessChecks(
  opts: { includeDetails?: boolean } = {},
): Promise<ReadinessReport> {
  const checkedAt = new Date().toISOString();
  let config;
  try {
    config = getConfig();
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    const skipped = { status: "skipped" as const, reason: "Configuration is invalid" };
    return {
      status: "not_ready",
      version: APP_VERSION,
      checkedAt,
      checks: {
        config: {
          status: "error",
          code: "CONFIG_INVALID",
          message: "Environment configuration is invalid",
          ...(opts.includeDetails ? { invalidVariables: err.issues.map((i) => i.variable) } : {}),
        },
        database: skipped,
        storage: skipped,
      },
    };
  }

  const [database, storage] = await Promise.all([
    checkDatabase(getPool()),
    checkStorage(config.storageDirAbsolute),
  ]);
  const ready = database.status === "ok" && storage.status === "ok";
  return {
    status: ready ? "ready" : "not_ready",
    version: APP_VERSION,
    checkedAt,
    checks: {
      config: { status: "ok" },
      database,
      // The filesystem path is server detail; only include it for trusted views.
      storage:
        storage.status === "ok" && !opts.includeDetails
          ? { status: "ok", path: "[hidden]" }
          : storage,
    },
  };
}
