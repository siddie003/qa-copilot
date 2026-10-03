import { createPool, runMigrations } from "@qa/db";

/**
 * Applies migrations to the test database once before integration tests run.
 * Refuses to run against a database whose name does not end in "_test" to protect real data,
 * because integration tests truncate tables.
 */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    console.warn("[integration] TEST_DATABASE_URL not set: integration tests will be skipped.");
    return;
  }
  const dbName = new URL(url).pathname.replace(/^\//, "");
  if (!dbName.endsWith("_test")) {
    throw new Error(
      `Refusing to run integration tests against "${dbName}" (name must end in _test).`,
    );
  }
  const pool = createPool(url, { max: 2 });
  try {
    await runMigrations(pool);
  } finally {
    await pool.end();
  }
}
