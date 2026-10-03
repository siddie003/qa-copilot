import { defineConfig, devices } from "@playwright/test";

// End-to-end tests against a production build of the web app on a dedicated port, so they never
// collide with a developer's `npm run dev` on port 3000. Run `npm run build` first.
const PORT = Number(process.env.E2E_PORT ?? 3100);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: [["list"]],
  use: { baseURL: BASE_URL, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npx next start --port ${PORT}`,
    cwd: "apps/web",
    url: `${BASE_URL}/api/v1/health`,
    reuseExistingServer: true,
    timeout: 120_000,
    env: { APP_URL: BASE_URL },
  },
});
