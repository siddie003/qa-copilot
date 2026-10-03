import { defineConfig, devices } from "@playwright/test";

// End-to-end tests against a production build of the web app on a dedicated port, so they never
// collide with a developer's `npm run dev` on port 3000. Run `npm run build` first.
const PORT = Number(process.env.E2E_PORT ?? 3100);
const BASE_URL = `http://localhost:${PORT}`;
const WORKER_HEALTH_PORT = 3191;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  reporter: [["list"]],
  use: { baseURL: BASE_URL, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: `npx next start --port ${PORT}`,
      cwd: "apps/web",
      url: `${BASE_URL}/api/v1/health`,
      reuseExistingServer: true,
      timeout: 120_000,
      env: { APP_URL: BASE_URL },
    },
    {
      // The scan worker (separate health port so it never clashes with a dev worker on 3001).
      command: "npx tsx src/index.ts",
      cwd: "apps/worker",
      url: `http://127.0.0.1:${WORKER_HEALTH_PORT}/health`,
      reuseExistingServer: true,
      timeout: 120_000,
      env: { WORKER_HEALTH_PORT: String(WORKER_HEALTH_PORT), APP_URL: BASE_URL },
    },
    {
      // Controlled fixture website (allowlisted as localhost:4100 in .env.example).
      command: "node fixtures/demo-site/server.mjs 4100",
      url: "http://localhost:4100/",
      reuseExistingServer: true,
      timeout: 30_000,
    },
  ],
});
