import { readFileSync } from "node:fs";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import pg from "pg";
import { deleteUsers, throwawayUser } from "./helpers";

// Phase 10 acceptance workflow: one user journey through the production build with the real
// worker and fixture site — sign up, project, approved content (parsed by the isolated document
// parser), scan, issue workflow, report download, rescan of a changed site, comparison, project
// deletion — with the nonce-based CSP active on every page and no CSP violation anywhere.
const user = throwawayUser("e2e-acceptance");
const TAGS = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];

// Another client address (TEST-NET-2) so this spec's sign-up does not use up the per-IP sign-up
// limit (5 per minute) shared by the other specs, which all come from localhost.
test.use({ extraHTTPHeaders: { "x-forwarded-for": "198.51.100.10" } });

test.afterAll(async () => {
  await deleteUsers([user.email]);
});

/** Collects CSP violations reported by the browser (console) and by the page itself. */
async function watchCsp(page: Page) {
  const violations: string[] = [];
  page.on("console", (msg) => {
    if (/Content Security Policy|Refused to (execute|load|apply|connect|frame)/i.test(msg.text()))
      violations.push(msg.text());
  });
  page.on("pageerror", (err) => {
    if (/Content Security Policy/i.test(err.message)) violations.push(err.message);
  });
  return violations;
}

async function audit(page: Page) {
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(
    result.violations.map(
      (v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
    ),
  ).toEqual([]);
}

async function waitForScan(request: APIRequestContext, scanId: string) {
  await expect
    .poll(async () => (await (await request.get(`/api/v1/scans/${scanId}`)).json()).status, {
      timeout: 180_000,
      intervals: [2000],
    })
    .toMatch(/^completed/);
}

test("acceptance: from sign-up to comparison and project deletion", async ({ page, baseURL }) => {
  test.setTimeout(540_000);
  const violations = await watchCsp(page);
  const origin = { origin: baseURL! };

  // 1. Signed-out visitors land on the sign-in page; pages carry the security headers.
  const first = await page.goto("/dashboard");
  expect(new URL(page.url()).pathname).toBe("/login");
  const headers = first!.headers();
  expect(headers["content-security-policy"]).toMatch(
    /script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/,
  );
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  // Every script on the page carries this response's nonce.
  const nonce = /'nonce-([^']+)'/.exec(headers["content-security-policy"]!)![1];
  const scripts = await page.evaluate(() =>
    [...document.scripts].map((s) => s.nonce || s.getAttribute("nonce") || ""),
  );
  expect(scripts.length).toBeGreaterThan(0);
  expect(scripts.every((n) => n === nonce)).toBe(true);
  const api = await page.request.get("/api/v1/health");
  expect(api.headers()["x-content-type-options"]).toBe("nosniff");
  expect(api.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");

  // 2. Sign up through the form.
  await page.getByRole("link", { name: "Create one" }).click();
  await page.waitForURL(/\/signup$/);
  await page.getByLabel("Name").fill(user.name);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill(user.password);
  await page.getByLabel("Confirm password").fill(user.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/dashboard$/);
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();

  // 3. A project for the fixture site; its custom-header site credential selects version v1.
  const created = await page.request.post("/api/v1/projects", {
    headers: origin,
    data: {
      name: "Acceptance site",
      websiteUrl: "http://localhost:4100",
      scanDefaults: {
        scanners: ["security", "seo"],
        viewports: [{ name: "desktop", width: 1440, height: 900 }],
        maxPages: 6,
        maxDepth: 2,
        respectRobots: true,
      },
    },
  });
  expect(created.status()).toBe(201);
  const projectId = (await created.json()).id as string;
  const variant = (value: "v1" | "v2") =>
    page.request.put(`/api/v1/projects/${projectId}/scan-auth`, {
      headers: origin,
      data: { type: "header", name: "X-Fixture-Variant", value },
    });
  expect((await variant("v1")).ok()).toBe(true);

  // 4. Approved content: the worker parses it in its isolated parser thread.
  const upload = await page.request.post(`/api/v1/projects/${projectId}/content-documents`, {
    headers: origin,
    multipart: {
      file: {
        name: "approved-content.md",
        mimeType: "text/markdown",
        buffer: readFileSync(
          path.resolve(import.meta.dirname, "../../fixtures/documents/approved-content.md"),
        ),
      },
    },
  });
  expect(upload.status()).toBe(201);
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/v1/projects/${projectId}/content-documents`)).json())
          .items[0].parseStatus,
      { timeout: 60_000, intervals: [1000] },
    )
    .toBe("parsed");

  // 5. Start the scan from the UI and watch it to the end.
  await page.goto(`/projects/${projectId}/scan`);
  await page.getByLabel(/I am authorized to test/).check();
  await page.getByRole("button", { name: "Start QA Scan" }).click();
  await page.waitForURL(new RegExp(`/projects/${projectId}/scans/[0-9a-f-]{36}$`));
  const scan1 = new URL(page.url()).pathname.split("/").at(-1)!;
  await expect(page.getByText("Final results.")).toBeVisible({ timeout: 180_000 });
  await expect(page.getByRole("heading", { name: /Scan #1/ })).toContainText("Completed");
  const progress = page.locator("section", { hasText: "Progress" }).first();
  await expect(progress.locator("li", { hasText: "Content" }).first()).toContainText("Completed");
  await audit(page);

  // 6. Issue workflow: explorer → detail → audited status change.
  await page.goto(`/projects/${projectId}/issues`);
  await page.getByRole("link", { name: "Site is not served over HTTPS" }).click();
  await page.waitForURL(new RegExp(`/projects/${projectId}/issues/\\d+$`));
  await page.getByRole("combobox", { name: "Status", exact: true }).selectOption("in_progress");
  await page.getByLabel("Note (optional)").fill("Acceptance: HTTPS planned");
  await page.getByRole("button", { name: "Save status" }).click();
  const history = page.getByRole("region", { name: "History" });
  await expect(history).toContainText("Open → In progress");
  await expect(history).toContainText("Acceptance: HTTPS planned");

  // 7. Markdown report generated by the worker and downloaded through the browser.
  await page.goto(`/projects/${projectId}/scans/${scan1}`);
  await page.getByRole("link", { name: "Generate report" }).click();
  await page.getByRole("radio", { name: /^Markdown/ }).check();
  await page.getByRole("button", { name: "Generate report" }).click();
  const link = page.getByRole("link", { name: "Download Markdown report of scan #1" });
  await expect(link).toBeVisible({ timeout: 60_000 });
  const [file] = await Promise.all([page.waitForEvent("download"), link.click()]);
  expect(file.suggestedFilename()).toBe("qa-report-acceptance-site-scan-1.md");
  const markdown = readFileSync((await file.path())!, "utf8");
  expect(markdown).toContain("Site is not served over HTTPS");
  expect(markdown).toContain("In progress");

  // 8. The site changes (v2) and is scanned again.
  expect((await variant("v2")).ok()).toBe(true);
  const rescan = await page.request.post(`/api/v1/projects/${projectId}/scans`, {
    headers: origin,
    data: { authorizationAttested: true },
  });
  expect(rescan.status()).toBe(201);
  const scan2 = (await rescan.json()).id as string;
  // A second scan cannot start while this one runs.
  const concurrent = await page.request.post(`/api/v1/projects/${projectId}/scans`, {
    headers: origin,
    data: { authorizationAttested: true },
  });
  expect(concurrent.status()).toBe(409);
  await waitForScan(page.request, scan2);

  // 9. Comparison from the finished scan.
  await page.goto(`/projects/${projectId}/scans/${scan2}`);
  await page.getByRole("link", { name: "Compare with scan #1" }).click();
  await page.waitForURL(
    new RegExp(`/projects/${projectId}/history/compare\\?base=${scan1}&target=${scan2}$`),
  );
  await expect(page.getByRole("heading", { name: /Scan #1.*Scan #2/ })).toBeVisible();
  const comparison = await (
    await page.request.get(
      `/api/v1/projects/${projectId}/comparisons?base=${scan1}&target=${scan2}`,
    )
  ).json();
  expect(comparison.summary.counts.resolved + comparison.summary.counts.new).toBeGreaterThan(0);
  await page.waitForLoadState("networkidle");

  // 10. Settings shows the production configuration checks of this (non-HTTPS) test server.
  await page.goto("/settings");
  await expect(
    page.getByRole("heading", { name: "Production configuration checks" }),
  ).toBeVisible();
  await expect(page.getByText(/APP_URL is not HTTPS/)).toBeVisible();
  await audit(page);

  // 11. Delete the project: it disappears, its credentials are deleted.
  await page.goto(`/projects/${projectId}/settings`);
  await page.getByRole("button", { name: "Delete project…" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("stored site credentials are deleted");
  await dialog.getByLabel(/Type .* to confirm/).fill("Acceptance site");
  await dialog.getByRole("button", { name: "Delete project" }).click();
  await page.waitForURL(/\/projects$/);
  expect((await page.request.get(`/api/v1/projects/${projectId}`)).status()).toBe(404);
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    const secrets = await db.query("select 1 from project_secret where project_id = $1", [
      projectId,
    ]);
    expect(secrets.rowCount).toBe(0);
  } finally {
    await db.end();
  }

  // No page in this journey reported a Content-Security-Policy violation.
  expect(violations).toEqual([]);
});
