import { sql } from "drizzle-orm";
import { getDb, schema } from "@qa/db";

export const hasTestDb = Boolean(process.env.TEST_DATABASE_URL);

/** Empties all application tables (test database only; guarded in global setup). */
export async function resetDatabase() {
  await getDb().execute(sql`truncate table "user", "verification" restart identity cascade`);
}

let counter = 0;

/** Inserts a user row directly (bypassing auth) for repository-level tests. */
export async function createTestUser(name = "Test User") {
  counter += 1;
  const id = `test-user-${Date.now()}-${counter}`;
  const [row] = await getDb()
    .insert(schema.user)
    .values({ id, name, email: `${id}@example.test`, emailVerified: false })
    .returning();
  return row!;
}
