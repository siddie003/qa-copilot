import { errorFields, getLogger, maskUrlCredentials, getConfig } from "@qa/core";
import { closeDb, getPool } from "../client";
import { MIGRATIONS_FOLDER, runMigrations } from "../migrate";

async function main() {
  const log = getLogger().child({ component: "migrate" });
  try {
    log.info({ database: maskUrlCredentials(getConfig().DATABASE_URL) }, "applying migrations");
    const applied = await runMigrations(getPool());
    if (applied) log.info("migrations up to date");
    else log.info({ migrationsFolder: MIGRATIONS_FOLDER }, "no migrations generated yet");
  } catch (err) {
    log.error(errorFields(err), "migration failed");
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}

void main();
