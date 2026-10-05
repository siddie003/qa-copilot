import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { deleteUsers, signUp, throwawayUser } from "./helpers";

// Phase 9: scan history and comparison of two real scans of the fixture site. The project sends
// `X-Fixture-Variant` as its custom-header site credential, so the fixture serves v1 to the first
// scan and v2 (fixes, one new defect, /wide failing) to the second without affecting other specs.
const user = throwawayUser("e2e-history");
const TAGS = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];

test.afterAll(async () => {
  await deleteUsers([user.email]);
});

async function audit(page: Page) {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    expect(
      result.violations.map(
        (v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
      ),
      `width ${width}`,
    ).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(0);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function scanVariant(
  request: APIRequestContext,
  origin: { origin: string },
  projectId: string,
  variant: "v1" | "v2",
) {
  const auth = await request.put(`/api/v1/projects/${projectId}/scan-auth`, {
    headers: origin,
    data: { type: "header", name: "X-Fixture-Variant", value: variant },
  });
  expect(auth.ok()).toBe(true);
  const scan = await request.post(`/api/v1/projects/${projectId}/scans`, {
    headers: origin,
    data: { authorizationAttested: true },
  });
  expect(scan.status()).toBe(201);
  const scanId = (await scan.json()).id as string;
  await expect
    .poll(async () => (await (await request.get(`/api/v1/scans/${scanId}`)).json()).status, {
      timeout: 150_000,
      intervals: [2000],
    })
    .toBe("completed");
  return scanId;
}

test("compare two scans of a changed site and browse the scan history", async ({
  page,
  baseURL,
}) => {
  await signUp(page.request, baseURL!, user);
  const origin = { origin: baseURL! };
  const created = await page.request.post("/api/v1/projects", {
    headers: origin,
    data: {
      name: "History",
      websiteUrl: "http://localhost:4100",
      scanDefaults: {
        scanners: ["seo"],
        viewports: [{ name: "desktop", width: 1440, height: 900 }],
        maxPages: 25,
        maxDepth: 2,
        respectRobots: true,
      },
    },
  });
  expect(created.status()).toBe(201);
  const projectId = (await created.json()).id as string;

  // Before any finished scan: nothing to compare.
  await page.goto(`/projects/${projectId}/history/compare`);
  await expect(page.getByRole("heading", { name: "Nothing to compare yet" })).toBeVisible();

  const scan1 = await scanVariant(page.request, origin, projectId, "v1");
  const scan2 = await scanVariant(page.request, origin, projectId, "v2");

  const api = await (await page.request.get(`/api/v1/projects/${projectId}/comparisons`)).json();
  expect([api.base.id, api.target.id]).toEqual([scan1, scan2]);
  const byRule = (rule: string) =>
    api.issues.find((i: { ruleId: string }) => i.ruleId === rule) as {
      category: string;
      title: string;
      displayNo: number;
    };
  expect(byRule("meta-description-missing").category).toBe("resolved");
  expect(byRule("structured-data-invalid").category).toBe("resolved");
  expect(byRule("h1-missing").category).toBe("new");
  // /wide failed in scan 2: its findings are listed as not rechecked, never as fixed.
  const wide = JSON.stringify(api.issues);
  expect(wide).toContain("/wide could not be analyzed in scan #2 (HTTP 500)");

  // History: latest changes, trend chart, table.
  await page.goto(`/projects/${projectId}/history`);
  const latest = page.getByRole("region", {
    name: "Latest changes: scan #2 compared with scan #1",
  });
  await expect(latest).toBeVisible();
  await expect(latest.getByRole("link", { name: /^Resolved/ })).toContainText(
    String(api.summary.counts.resolved),
  );
  await expect(latest.getByRole("link", { name: /^New/ })).toContainText(
    String(api.summary.counts.new),
  );
  await expect(
    page.getByRole("group", { name: /Issues per scan for the last 2 comparable scans/ }),
  ).toBeVisible();
  const table = page.getByRole("region", { name: "Scan history table" });
  await expect(table.locator("tbody tr")).toHaveCount(2);
  await expect(table).toContainText(`${api.summary.counts.resolved} resolved`);
  await audit(page);

  // Comparison page: categories, reasons, links to issues and scans.
  await latest.getByRole("link", { name: "View comparison" }).click();
  await page.waitForURL(new RegExp(`/projects/${projectId}/history/compare\\?base=${scan1}`));
  await expect(page.getByRole("heading", { name: /Scan #1.*Scan #2/ })).toBeVisible();
  const resolved = page.getByRole("region", { name: /^Resolved/ });
  await expect(resolved).toContainText(byRule("meta-description-missing").title);
  await expect(resolved).toContainText("re-checked");
  const fresh = page.getByRole("region", { name: /^New \(/ });
  await expect(
    fresh.getByRole("link", { name: `ISSUE-${byRule("h1-missing").displayNo}` }),
  ).toHaveAttribute(
    "href",
    `/projects/${projectId}/issues/${byRule("h1-missing").displayNo}?scan=${scan2}`,
  );
  // Expand one issue's findings to show the per-finding detail.
  await page
    .locator("details summary", { hasText: /^Findings:/ })
    .first()
    .click();
  await audit(page);

  // Filter by category.
  await page
    .getByRole("link", { name: /^Resolved/ })
    .first()
    .click();
  await expect(page.getByRole("heading", { name: "Resolved issues" })).toBeVisible();
  await expect(page.getByRole("region", { name: /^New \(/ })).toHaveCount(0);

  // Reversed order is refused with an explanation (no comparison is invented).
  await page.goto(`/projects/${projectId}/history/compare?base=${scan2}&target=${scan1}`);
  await expect(
    page.getByRole("alert").filter({ hasText: "The base scan must be older" }),
  ).toBeVisible();

  // The finished scan links to its comparison.
  await page.goto(`/projects/${projectId}/scans/${scan2}`);
  await page.getByRole("link", { name: "Compare with scan #1" }).click();
  await page.waitForURL(
    new RegExp(`/projects/${projectId}/history/compare\\?base=${scan1}&target=${scan2}$`),
  );
  await expect(page.getByRole("heading", { name: /Scan #1.*Scan #2/ })).toBeVisible();
  // Let the page finish loading before the browser closes (an aborted response would be logged
  // by the server as "The destination stream closed early").
  await page.waitForLoadState("networkidle");
});
