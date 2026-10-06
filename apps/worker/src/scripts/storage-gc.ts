/**
 * Storage garbage collection (see ../maintenance/storage-gc.ts).
 *
 *   npm run storage:gc                                   dry run: lists what would be removed
 *   npm run storage:gc -- --apply                        removes it
 *   npm run storage:gc -- --min-age-hours=48             only entries older than 48 h (default 24)
 *   npm run storage:gc -- --include-deleted-projects     also files of soft-deleted projects
 *
 * Run it against the database that owns STORAGE_DIR (never point two databases at one folder).
 */
import { ConfigError, getConfig } from "@qa/core";
import { closeDb, getDb, getMigrationStatus, getPool } from "@qa/db";
import { createLocalStorage } from "@qa/storage";
import { collectStorageGarbage } from "../maintenance/storage-gc";

const args = process.argv.slice(2);
const known = /^--(apply|include-deleted-projects|min-age-hours=\d+(\.\d+)?)$/;
const unknownArgs = args.filter((a) => !known.test(a));
if (unknownArgs.length) {
  console.error(`Unknown option(s): ${unknownArgs.join(" ")}`);
  console.error(
    "Usage: npm run storage:gc -- [--apply] [--min-age-hours=24] [--include-deleted-projects]",
  );
  process.exit(2);
}
const apply = args.includes("--apply");
const includeDeletedProjects = args.includes("--include-deleted-projects");
const minAgeHours = Number(
  args.find((a) => a.startsWith("--min-age-hours="))?.split("=")[1] ?? "24",
);
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function main() {
  let config;
  try {
    config = getConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
  const migrations = await getMigrationStatus(getPool());
  if (migrations.pending > 0) {
    console.error("Database migrations are pending; run `npm run db:migrate` first.");
    process.exit(1);
  }
  const root = config.storageDirAbsolute;
  const result = await collectStorageGarbage({
    db: getDb(),
    storage: createLocalStorage(root),
    root,
    apply,
    minAgeMs: minAgeHours * 3_600_000,
    includeDeletedProjects,
  });
  const total = result.remove.reduce((s, c) => s + c.sizeBytes, 0);
  console.log(`Storage: ${root}`);
  console.log(
    `${apply ? "Removed" : "Would remove"} ${result.remove.length} entr${result.remove.length === 1 ? "y" : "ies"} (${mb(total)}), older than ${minAgeHours} h${includeDeletedProjects ? ", including soft-deleted projects" : ""}:`,
  );
  for (const c of result.remove.slice(0, 50))
    console.log(`  ${c.key}  ${mb(c.sizeBytes)}  — ${c.reason}`);
  if (result.remove.length > 50) console.log(`  … and ${result.remove.length - 50} more`);
  if (result.tooRecent.length)
    console.log(
      `Kept ${result.tooRecent.length} unreferenced entr${result.tooRecent.length === 1 ? "y" : "ies"} newer than ${minAgeHours} h.`,
    );
  if (result.unknown.length)
    console.log(
      `Not recognized (never removed): ${result.unknown.slice(0, 20).join(", ")}${result.unknown.length > 20 ? " …" : ""}`,
    );
  for (const f of result.failed) console.error(`  could not remove ${f.key}: ${f.error}`);
  if (!apply && result.remove.length)
    console.log("Dry run: nothing was changed. Add --apply to remove.");
  await closeDb();
  if (result.failed.length) process.exit(1);
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await closeDb().catch(() => {});
  process.exit(1);
});
