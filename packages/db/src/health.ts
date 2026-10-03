import type pg from "pg";

export type DatabaseHealth =
  | { status: "ok"; latencyMs: number; serverVersion: string; database: string }
  | { status: "error"; latencyMs: number; code: DatabaseErrorCode; message: string };

export type DatabaseErrorCode =
  | "DB_UNREACHABLE"
  | "DB_HOST_NOT_FOUND"
  | "DB_AUTH_FAILED"
  | "DB_NOT_FOUND"
  | "DB_TIMEOUT"
  | "DB_ERROR";

class HealthTimeoutError extends Error {}

function codeOf(err: unknown): string | undefined {
  const direct = (err as { code?: unknown })?.code;
  if (typeof direct === "string") return direct;
  // Node reports dual-stack connection failures (::1 and 127.0.0.1) as an AggregateError.
  const nested = (err as { errors?: Array<{ code?: unknown }> })?.errors?.[0]?.code;
  return typeof nested === "string" ? nested : undefined;
}

/** Maps a driver error to a stable code and a message that is safe to show (no credentials). */
export function classifyDatabaseError(err: unknown): { code: DatabaseErrorCode; message: string } {
  if (err instanceof HealthTimeoutError || /timeout/i.test(String((err as Error)?.message)))
    return { code: "DB_TIMEOUT", message: "Database did not respond in time" };
  switch (codeOf(err)) {
    case "ECONNREFUSED":
      return { code: "DB_UNREACHABLE", message: "Connection refused by database server" };
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return { code: "DB_HOST_NOT_FOUND", message: "Database host could not be resolved" };
    case "28P01":
    case "28000":
      return { code: "DB_AUTH_FAILED", message: "Database authentication failed" };
    case "3D000":
      return { code: "DB_NOT_FOUND", message: "Database does not exist" };
    default:
      return { code: "DB_ERROR", message: "Database check failed" };
  }
}

/** Runs a real round-trip query against PostgreSQL. Never throws. */
export async function checkDatabase(pool: pg.Pool, timeoutMs = 3_000): Promise<DatabaseHealth> {
  const started = performance.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const query = pool.query<{ version: string; database: string }>(
      "select current_setting('server_version') as version, current_database() as database",
    );
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new HealthTimeoutError("health check timeout")), timeoutMs);
    });
    const result = await Promise.race([query, timeout]);
    const row = result.rows[0];
    return {
      status: "ok",
      latencyMs: Math.round(performance.now() - started),
      serverVersion: row?.version ?? "unknown",
      database: row?.database ?? "unknown",
    };
  } catch (err) {
    return {
      status: "error",
      latencyMs: Math.round(performance.now() - started),
      ...classifyDatabaseError(err),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
