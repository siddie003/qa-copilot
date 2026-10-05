import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { deleteUsers, signUp, throwawayUser } from "./helpers";

// Automated WCAG 2.2 A/AA audit of the QA Copilot UI itself (axe-core). Serious and critical
// violations fail the test; the full list is printed for review.
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const user = throwawayUser("e2e-a11y");
let projectId = "";

async function audit(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState("networkidle");
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const blocking = result.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  for (const v of result.violations)
    console.log(`[${path}] ${v.impact} ${v.id}: ${v.help} (${v.nodes.length} element(s))`);
  expect(
    blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
  ).toEqual([]);

  // No horizontal page overflow at the current viewport.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `${path} overflows horizontally`).toBeLessThanOrEqual(0);
}

test.afterAll(async () => {
  await deleteUsers([user.email]);
});

test("signed-out pages are accessible", async ({ page }) => {
  for (const path of ["/login", "/signup"]) await audit(page, path);
});

test.describe("signed-in pages", () => {
  test.beforeAll(async ({ browser, baseURL }) => {
    const context = await browser.newContext({ storageState: undefined });
    await signUp(context.request, baseURL!, user);
    const res = await context.request.post("/api/v1/projects", {
      data: {
        name: "A11y project",
        websiteUrl: "example.com",
        figmaUrl: "https://www.figma.com/design/AbCdEfGh1234/Site",
      },
      headers: { origin: baseURL! },
    });
    expect(res.status()).toBe(201);
    projectId = (await res.json()).id;
    await context.storageState({ path: "test-results/a11y-state.json" });
    await context.close();
  });
  test.use({ storageState: "test-results/a11y-state.json" });

  const appPages = () => [
    "/dashboard",
    "/projects",
    "/projects/new",
    "/scans",
    "/issues",
    "/reports",
    "/settings",
    `/projects/${projectId}`,
    `/projects/${projectId}/scan`,
    `/projects/${projectId}/references`,
    `/projects/${projectId}/issues`,
    `/projects/${projectId}/pages`,
    `/projects/${projectId}/scanners`,
    `/projects/${projectId}/reports`,
    `/projects/${projectId}/history`,
    `/projects/${projectId}/settings`,
  ];

  test("desktop", async ({ page }) => {
    for (const path of appPages()) await audit(page, path);
  });

  test("mobile (390px)", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const path of appPages()) await audit(page, path);
  });

  test("wizard steps and dialogs", async ({ page }) => {
    await page.goto("/projects/new");
    await page.getByLabel("Project name").fill("Wizard a11y");
    await page.getByLabel("Website URL").fill("example.com");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { name: /Step 2 of 6/ })).toBeFocused();
    const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    expect(
      result.violations.filter((v) => v.impact === "serious" || v.impact === "critical"),
    ).toEqual([]);

    await page.goto(`/projects/${projectId}/settings`);
    await page.getByRole("button", { name: "Delete project…" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByLabel(/Type .* to confirm/)).toBeFocused();
    const dialog = await new AxeBuilder({ page }).include("dialog").withTags(TAGS).analyze();
    expect(
      dialog.violations.filter((v) => v.impact === "serious" || v.impact === "critical"),
    ).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
  });
});
