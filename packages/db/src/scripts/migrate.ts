import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { errorFields, getLogger } from "@qa/core";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { closeDb, getDb } from "../client";

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../migrations",
);

async function main() {
  const log = getLogger().child({ component: "migrate" });
  if (!existsSync(path.join(migrationsFolder, "meta", "_journal.json"))) {
    log.info({ migrationsFolder }, "no migrations generated yet; nothing to apply");
    return;
  }
  try {
    await migrate(getDb(), { migrationsFolder });
    log.info("migrations applied");
  } catch (err) {
    log.error(errorFields(err), "migration failed");
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}

void main();
