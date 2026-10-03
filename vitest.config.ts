import { fileURLToPath } from "node:url";
import { config as loadDotEnv } from "dotenv";
import { defineConfig } from "vitest/config";

// Integration tests run against TEST_DATABASE_URL (never the development database).
const rootEnv =
  loadDotEnv({ path: fileURLToPath(new URL("./.env", import.meta.url)), quiet: true }).parsed ?? {};
const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? rootEnv.TEST_DATABASE_URL ?? "";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./apps/web/src", import.meta.url)),
    },
  },
  test: {
    testTimeout: 15_000,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
          exclude: ["**/*.int.test.ts", "**/node_modules/**"],
          env: { LOG_LEVEL: "silent" },
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          environment: "node",
          include: ["packages/*/src/**/*.int.test.ts", "apps/*/src/**/*.int.test.ts"],
          globalSetup: ["./tests/setup/integration-global.ts"],
          fileParallelism: false,
          testTimeout: 30_000,
          env: {
            LOG_LEVEL: "silent",
            NODE_ENV: "test",
            TEST_DATABASE_URL: testDatabaseUrl,
            // Application code under test reads DATABASE_URL; point it at the test database.
            DATABASE_URL: testDatabaseUrl,
            BETTER_AUTH_SECRET:
              rootEnv.BETTER_AUTH_SECRET ?? "integration-test-secret-0123456789abcdef",
            APP_URL: "http://localhost:3000",
            // Fixed test-only key (never used outside the _test database).
            ENCRYPTION_KEY: "0".repeat(63) + "1",
          },
        },
      },
    ],
  },
});
