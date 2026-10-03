#!/usr/bin/env node
// Creates .env from .env.example with freshly generated local secrets.
// Never overwrites an existing .env and never prints secret values.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, ".env");
const example = path.join(root, ".env.example");

if (existsSync(target)) {
  console.error(".env already exists. Not overwriting. Delete it first if you want to regenerate.");
  process.exit(1);
}

const dbPassword = randomBytes(24).toString("hex");
const set = (text, key, value) => text.replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${value}`);

let env = readFileSync(example, "utf8");
env = set(env, "DATABASE_URL", `postgres://qa_copilot:${dbPassword}@localhost:5432/qa_copilot`);
env = set(
  env,
  "TEST_DATABASE_URL",
  `postgres://qa_copilot:${dbPassword}@localhost:5432/qa_copilot_test`,
);
env = set(env, "BETTER_AUTH_SECRET", randomBytes(32).toString("base64url"));
env = set(env, "ENCRYPTION_KEY", randomBytes(32).toString("hex"));

writeFileSync(target, env, { encoding: "utf8", flag: "wx" });
console.log(
  "Created .env with generated DATABASE_URL password, BETTER_AUTH_SECRET and ENCRYPTION_KEY.",
);
console.log("Next: npm run db:bootstrap   (creates the database role and databases)");
