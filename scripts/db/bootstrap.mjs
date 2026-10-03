#!/usr/bin/env node
// Creates the application role + databases described by DATABASE_URL / TEST_DATABASE_URL in .env.
// psql prompts for the PostgreSQL superuser password interactively; this script never sees it.
//
// Usage: npm run db:bootstrap [-- --superuser postgres]
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const envFile = path.join(root, ".env");
if (!existsSync(envFile)) {
  console.error("No .env found. Run `npm run setup:env` first.");
  process.exit(1);
}

const env = Object.fromEntries(
  readFileSync(envFile, "utf8")
    .split(/\r?\n/)
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);

let url;
try {
  url = new URL(env.DATABASE_URL);
} catch {
  console.error("DATABASE_URL in .env is missing or not a valid URL.");
  process.exit(1);
}
const appUser = decodeURIComponent(url.username);
const appPassword = decodeURIComponent(url.password);
const appDb = url.pathname.replace(/^\//, "");
let testDb = `${appDb}_test`;
if (env.TEST_DATABASE_URL) {
  try {
    testDb = new URL(env.TEST_DATABASE_URL).pathname.replace(/^\//, "") || testDb;
  } catch {
    /* keep default */
  }
}
if (!appUser || !appPassword || !appDb || appPassword === "CHANGE_ME") {
  console.error("DATABASE_URL must contain a user, a real password and a database name.");
  process.exit(1);
}

const superIdx = process.argv.indexOf("--superuser");
const superuser =
  superIdx > -1 ? process.argv[superIdx + 1] : process.env.PGSUPERUSER || "postgres";

function findPsql() {
  if (process.env.PSQL_PATH && existsSync(process.env.PSQL_PATH)) return process.env.PSQL_PATH;
  const onPath = spawnSync(process.platform === "win32" ? "where" : "which", ["psql"], {
    encoding: "utf8",
  });
  if (onPath.status === 0) return onPath.stdout.split(/\r?\n/)[0].trim();
  if (process.platform === "win32") {
    const base = "C:\\Program Files\\PostgreSQL";
    if (existsSync(base)) {
      const versions = readdirSync(base)
        .filter((v) => /^\d+$/.test(v))
        .sort((a, b) => Number(b) - Number(a));
      for (const v of versions) {
        const candidate = path.join(base, v, "bin", "psql.exe");
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return undefined;
}

const psql = findPsql();
if (!psql) {
  console.error("psql not found. Install PostgreSQL client tools or set PSQL_PATH.");
  process.exit(1);
}

console.log(
  `Creating role "${appUser}" and databases "${appDb}", "${testDb}" on ${url.hostname}:${url.port || 5432}`,
);
console.log(`Connecting as PostgreSQL superuser "${superuser}" (psql will ask for its password).`);

const result = spawnSync(
  psql,
  [
    "-h",
    url.hostname,
    "-p",
    url.port || "5432",
    "-U",
    superuser,
    "-d",
    "postgres",
    "-q",
    "-f",
    path.join(root, "scripts", "db", "setup-database.sql"),
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      QA_APP_USER: appUser,
      QA_APP_PASSWORD: appPassword,
      QA_APP_DB: appDb,
      QA_TEST_DB: testDb,
    },
  },
);

if (result.status !== 0) {
  console.error("Database bootstrap failed (see psql output above).");
  process.exit(result.status ?? 1);
}
console.log("Done. Verify with: npm run db:check");
