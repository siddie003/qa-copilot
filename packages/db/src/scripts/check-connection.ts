import { ConfigError, getConfig, maskUrlCredentials } from "@qa/core";
import { checkDatabase } from "../health";
import { closeDb, getPool } from "../client";

async function main() {
  let url: string;
  try {
    url = getConfig().DATABASE_URL;
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
  console.log(`Checking ${maskUrlCredentials(url)} ...`);
  const health = await checkDatabase(getPool(), 5_000);
  await closeDb();
  if (health.status === "ok") {
    console.log(
      `OK: PostgreSQL ${health.serverVersion}, database "${health.database}" (${health.latencyMs} ms)`,
    );
    return;
  }
  console.error(`FAILED [${health.code}]: ${health.message}`);
  process.exit(1);
}

void main();
