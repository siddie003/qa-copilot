import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
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

/** Signs in an existing throwaway user (sign-ups are rate limited to 5 per minute). */
export async function signIn(
  request: APIRequestContext,
  baseURL: string,
  user: ReturnType<typeof throwawayUser>,
) {
  const res = await request.post("/api/auth/sign-in/email", {
    data: { email: user.email, password: user.password },
    headers: { origin: baseURL },
  });
  if (!res.ok()) throw new Error(`sign-in failed: ${res.status()}`);
}

/**
 * Deletes throwaway accounts created by the tests (cascades to projects and scans) and the
 * stored artifacts (screenshots, snapshots, uploaded documents) of their projects.
 */
export async function deleteUsers(emails: string[]) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const scans = await client.query<{ id: string }>(
      `select s.id from scan s join project p on p.id = s.project_id
       join "user" u on u.id = p.owner_id where u.email = any($1)`,
      [emails],
    );
    const projects = await client.query<{ id: string }>(
      `select p.id from project p join "user" u on u.id = p.owner_id where u.email = any($1)`,
      [emails],
    );
    await client.query('delete from "user" where email = any($1)', [emails]);
    const storageRoot = path.resolve(
      import.meta.dirname,
      "../..",
      process.env.STORAGE_DIR ?? "./storage",
    );
    for (const { id } of scans.rows)
      await rm(path.join(storageRoot, "scans", id), { recursive: true, force: true });
    // Uploaded content documents and brand guidelines.
    for (const { id } of projects.rows)
      await rm(path.join(storageRoot, "projects", id), { recursive: true, force: true });
  } finally {
    await client.end();
  }
}
