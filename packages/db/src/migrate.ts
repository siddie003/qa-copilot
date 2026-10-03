import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findRepoRoot } from "@qa/core";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type pg from "pg";

// Resolve from the repository root first: inside a bundled app (Next.js) the module URL points
// into the build output, not into packages/db.
const repoRoot = findRepoRoot();
export const MIGRATIONS_FOLDER =
  repoRoot && existsSync(path.join(repoRoot, "packages", "db", "migrations"))
    ? path.join(repoRoot, "packages", "db", "migrations")
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

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

export interface MigrationStatus {
  expected: number;
  applied: number;
  pending: number;
}

/**
 * Compares the migrations shipped with the code against those recorded in the database
 * (drizzle.__drizzle_migrations). `pending > 0` means `npm run db:migrate` must be run.
 */
export async function getMigrationStatus(pool: pg.Pool): Promise<MigrationStatus> {
  const journalPath = path.join(MIGRATIONS_FOLDER, "meta", "_journal.json");
  if (!existsSync(journalPath)) throw new Error(`Migration journal not found at ${journalPath}`);
  const expected = (JSON.parse(readFileSync(journalPath, "utf8")) as { entries: unknown[] }).entries
    .length;
  const exists = await pool.query<{ ok: boolean }>(
    "select to_regclass('drizzle.__drizzle_migrations') is not null as ok",
  );
  const applied = exists.rows[0]?.ok
    ? Number(
        (await pool.query<{ n: string }>("select count(*) as n from drizzle.__drizzle_migrations"))
          .rows[0]?.n ?? 0,
      )
    : 0;
  return { expected, applied, pending: Math.max(0, expected - applied) };
}
