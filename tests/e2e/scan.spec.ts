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
  const scanPath = new URL(page.url()).pathname;
  await expect(page.getByRole("heading", { name: /Scan #1/ })).toBeVisible();

  // Live status reflects the worker; wait for the final state.
  await expect(page.getByText("Final results.")).toBeVisible({ timeout: 150_000 });
  await expect(page.getByRole("heading", { name: /Scan #1/ })).toContainText("Completed");

  const progress = page
    .getByRole("region", { name: "Progress" })
    .or(page.locator("section", { hasText: "Progress" }).first());
  for (const step of [
    "Preparing website",
    "Crawling pages",
    "Browser capture",
    "Accessibility",
    "Security",
    "SEO",
    "Broken links / mixed content",
    "Performance",
    "Responsive / visual",
  ]) {
    await expect(progress.locator("li", { hasText: step }).first()).toContainText("Completed");
  }
  // No AI provider in the e2e environment: AI is skipped with the reason and issues are still
  // created from the findings by the evidence validation step.
  const aiRow = progress.locator("li", { hasText: "AI analysis" });
  await expect(aiRow).toContainText("Skipped");
  await expect(aiRow).toContainText("No AI provider configured");
  const groundingRow = progress.locator("li", { hasText: "Evidence validation" });
  await expect(groundingRow).toContainText("Completed");
  await expect(groundingRow).toContainText(/\d+ issues from \d+ findings/);
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

  // Findings page: real scanner findings with expandable evidence.
  await page.getByRole("link", { name: /^View \d+ findings?$/ }).click();
  await page.waitForURL(/\/findings$/);
  await expect(page.getByRole("heading", { name: /Findings · Scan #1/ })).toBeVisible();
  const httpFinding = page.locator("details", { hasText: "Site is not served over HTTPS" });
  await httpFinding.locator("summary").first().click();
  // Plain-language guide first; the raw scanner output stays one click away.
  await expect(httpFinding.getByText("What is the problem?")).toBeVisible();
  await expect(httpFinding).toContainText("served without encryption");
  await expect(httpFinding.getByRole("heading", { name: "How to verify the fix" })).toBeVisible();
  await expect(httpFinding.getByRole("heading", { name: "Evidence", exact: true })).toBeHidden();
  await httpFinding.getByText("Technical details and evidence").click();
  await expect(httpFinding.getByRole("heading", { name: "Evidence", exact: true })).toBeVisible();
  await expect(httpFinding.getByText("http://localhost:4100/").first()).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Checks that could not be verified" }),
  ).toBeVisible();
  const findingsA11y = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(findingsA11y.violations.map((v) => `${v.id} (${v.impact})`)).toEqual([]);

  // Filter by scanner.
  await page.getByLabel("Scanner", { exact: true }).selectOption("security");
  await page.getByRole("button", { name: "Apply" }).click();
  await page.waitForURL(/scanner=security/);
  await expect(page.locator("details summary").first()).toContainText("SEC-");

  // Issues of the scan: findings grouped by rule, scanner wording, source findings linked.
  await page.goto(`${scanPath}/issues`);
  await expect(page.getByRole("heading", { name: /Issues · Scan #1/ })).toBeVisible();
  const httpIssue = page.locator("li[id^=issue-]", { hasText: "Site is not served over HTTPS" });
  await httpIssue.locator("summary").click();
  await expect(httpIssue.getByText("Scanner wording")).toBeVisible();
  await expect(httpIssue.getByText("What is the problem?")).toBeVisible();
  await expect(
    httpIssue.getByRole("link", { name: "Step-by-step fix, example code and how to verify it" }),
  ).toHaveAttribute("href", /\/issues\/\d+\?scan=.+#fix$/);
  await expect(httpIssue.getByRole("heading", { name: "How to fix" })).toBeVisible();
  await expect(httpIssue.getByText(/redirect every http:\/\/ request to https:\/\//)).toBeVisible();
  await expect(httpIssue.getByText("No AI text was produced for this issue.")).toBeVisible();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const issuesA11y = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(issuesA11y.violations.map((v) => `${v.id} (${v.impact})`)).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(0);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  // Source finding → findings view (traceability both ways).
  await httpIssue
    .getByRole("link", { name: /^SEC-\d{3}$/ })
    .first()
    .click();
  // The link names the finding, so the findings view opens its page with that finding expanded.
  await page.waitForURL(/\/findings\?scanner=security&finding=(SEC-\d{3})#\1$/);
  const findingId = new URL(page.url()).searchParams.get("finding")!;
  const linked = page.locator(`li[id="${findingId}"]`);
  await expect(linked.locator("details").first()).toHaveAttribute("open", "");
  await expect(linked).toContainText("Site is not served over HTTPS");
  await expect(linked.getByRole("link", { name: /^Open ISSUE-\d+ for its status/ })).toBeVisible();

  // The project's Issues tab lists the tracked issues and links to the issue detail page.
  await page.goto(`/projects/${projectId}/issues`);
  await page.getByRole("link", { name: "Site is not served over HTTPS" }).click();
  await page.waitForURL(new RegExp(`/projects/${projectId}/issues/\\d+$`));

  // Pages tab lists the crawled pages (6 = the configured page limit) with HTTP status.
  await page.goto(`/projects/${projectId}/pages`);
  await expect(page.getByText(/^6 pages from scan #1/)).toBeVisible();
  await expect(page.getByRole("row", { name: /localhost:4100\/about/ })).toContainText("200");
});
