import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { deleteUsers, signUp, throwawayUser } from "./helpers";

// Full user flow against real services: web app, scan worker and the local fixture website.
const user = throwawayUser("e2e-scan");

test.afterAll(async () => {
  await deleteUsers([user.email]);
});

test("start a QA scan from the UI and watch it complete with live status", async ({
  page,
  baseURL,
}) => {
  await signUp(page.request, baseURL!, user);
  const created = await page.request.post("/api/v1/projects", {
    headers: { origin: baseURL! },
    data: {
      name: "Fixture site",
      websiteUrl: "http://localhost:4100",
      scanDefaults: {
        scanners: ["accessibility", "security", "seo", "links", "performance", "responsive"],
        viewports: [
          { name: "desktop", width: 1440, height: 900 },
          { name: "mobile", width: 390, height: 844 },
        ],
        maxPages: 6,
        maxDepth: 2,
        respectRobots: true,
      },
    },
  });
  expect(created.status()).toBe(201);
  const projectId = (await created.json()).id;

  await page.goto(`/projects/${projectId}/scan`);
  const start = page.getByRole("button", { name: "Start QA Scan" });
  await expect(start).toBeDisabled(); // authorization confirmation required first
  await page.getByLabel(/I am authorized to test/).check();
  await start.click();

  await page.waitForURL(new RegExp(`/projects/${projectId}/scans/[0-9a-f-]{36}$`));
  await expect(page.getByRole("heading", { name: /Scan #1/ })).toBeVisible();

  // Live status reflects the worker; wait for the final state.
  await expect(page.getByText("Final results.")).toBeVisible({ timeout: 150_000 });
  await expect(page.getByRole("heading", { name: /Scan #1/ })).toContainText("Completed");

  const progress = page
    .getByRole("region", { name: "Progress" })
    .or(page.locator("section", { hasText: "Progress" }).first());
  for (const step of ["Preparing website", "Crawling pages", "Browser capture"]) {
    await expect(progress.locator("li", { hasText: step })).toContainText("Completed");
  }
  await expect(progress.locator("li", { hasText: "SEO" })).toContainText("Skipped");
  await expect(progress.locator("li", { hasText: "SEO" })).toContainText("Phase 5");
  await expect(page.getByText("Could not determine", { exact: true })).toBeVisible();

  // Screenshots are served through the authenticated artifact endpoint and actually load.
  const shot = page
    .getByRole("img", { name: /desktop screenshot of http:\/\/localhost:4100\// })
    .first();
  await shot.scrollIntoViewIfNeeded();
  await expect(shot).toBeVisible();
  expect(
    await shot.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth),
  ).toBeGreaterThan(0);

  const a11y = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(a11y.violations.map((v) => `${v.id} (${v.impact})`)).toEqual([]);

  // Pages tab lists the crawled pages (6 = the configured page limit) with HTTP status.
  await page.goto(`/projects/${projectId}/pages`);
  await expect(page.getByText(/^6 pages from scan #1/)).toBeVisible();
  await expect(page.getByRole("row", { name: /localhost:4100\/about/ })).toContainText("200");
});
