import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type pg from "pg";

export const MIGRATIONS_FOLDER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);

// Arbitrary constant: serializes concurrent migration runs (e.g. two processes starting at once).
const MIGRATION_LOCK_ID = 727_001;

/** Applies pending SQL migrations. Returns false when no migrations have been generated. */
export async function runMigrations(pool: pg.Pool): Promise<boolean> {
  if (!existsSync(path.join(MIGRATIONS_FOLDER, "meta", "_journal.json"))) return false;
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
    return true;
  } finally {
    await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]).catch(() => {});
    client.release();
  }
}
