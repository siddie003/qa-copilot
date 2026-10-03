import { randomBytes } from "node:crypto";
import path from "node:path";
import type { APIRequestContext } from "@playwright/test";
import { config } from "dotenv";
import pg from "pg";

config({ path: path.resolve(import.meta.dirname, "../../.env"), quiet: true });

/** Random throwaway credentials for one test run (never logged). */
export function throwawayUser(prefix: string) {
  return {
    name: "E2E User",
    email: `${prefix}-${randomBytes(4).toString("hex")}@example.test`,
    password: randomBytes(18).toString("base64url"),
  };
}

/** Signs up through the real auth endpoint; the session cookie lands in the request context. */
export async function signUp(
  request: APIRequestContext,
  baseURL: string,
  user: ReturnType<typeof throwawayUser>,
) {
  const res = await request.post("/api/auth/sign-up/email", {
    data: user,
    headers: { origin: baseURL },
  });
  if (!res.ok()) throw new Error(`sign-up failed: ${res.status()}`);
}

/** Deletes throwaway accounts created by the tests (cascades to their projects). */
export async function deleteUsers(emails: string[]) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('delete from "user" where email = any($1)', [emails]);
  } finally {
    await client.end();
  }
}
