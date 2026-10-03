import { getConfig, getLogger, errorFields } from "@qa/core";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema>;

export interface PoolOptions {
  max?: number;
  connectionTimeoutMs?: number;
}

export function createPool(connectionString: string, opts: PoolOptions = {}): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max: opts.max ?? 10,
    connectionTimeoutMillis: opts.connectionTimeoutMs ?? 5_000,
    idleTimeoutMillis: 30_000,
    application_name: "qa-copilot",
  });
  // An idle client can error (e.g. server restart). Without a listener this crashes the process.
  pool.on("error", (err) =>
    getLogger().error({ ...errorFields(err) }, "postgres idle client error"),
  );
  return pool;
}

// Cached on globalThis so Next.js dev hot reloads don't open a new pool per reload.
const globalCache = globalThis as unknown as { __qaPool?: pg.Pool; __qaDb?: Database };

export function getPool(): pg.Pool {
  if (!globalCache.__qaPool) {
    const cfg = getConfig();
    globalCache.__qaPool = createPool(cfg.DATABASE_URL, { max: cfg.DATABASE_POOL_MAX });
  }
  return globalCache.__qaPool;
}

export function getDb(): Database {
  globalCache.__qaDb ??= drizzle(getPool(), { schema });
  return globalCache.__qaDb;
}

export async function closeDb(): Promise<void> {
  const pool = globalCache.__qaPool;
  globalCache.__qaPool = undefined;
  globalCache.__qaDb = undefined;
  if (pool) await pool.end();
}
