import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { deleteUsers, signIn, signUp, throwawayUser } from "./helpers";

// Phase 6 flow against real services: references page (upload + editor), worker processing,
// a scan with design and content comparison, the comparison report and the evidence.
const user = throwawayUser("e2e-refs");
const approved = readFileSync(
  new URL("../../fixtures/documents/approved-content.md", import.meta.url),
);
const designSpec = readFileSync(
  new URL("../../fixtures/documents/design-spec.json", import.meta.url),
  "utf8",
);

// Both tests use one account (sign-ups are rate limited), so they run in order.
test.describe.configure({ mode: "serial" });

test.afterAll(async () => {
  await deleteUsers([user.email]);
});

const axe = async (page: Page) =>
  (
    await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()
  ).violations.map((v) => `${v.id} (${v.impact}): ${v.nodes[0]?.target.join(" ")}`);

test("references are uploaded, confirmed and compared against the fixture site", async ({
  page,
  baseURL,
}) => {
  await signUp(page.request, baseURL!, user);
  const created = await page.request.post("/api/v1/projects", {
    headers: { origin: baseURL! },
    data: {
      name: "Fixture with references",
      websiteUrl: "http://localhost:4100",
      scanDefaults: {
        scanners: ["seo"],
        viewports: [{ name: "desktop", width: 1440, height: 900 }],
        maxPages: 25,
        maxDepth: 1,
        respectRobots: true,
      },
    },
  });
  expect(created.status()).toBe(201);
  const projectId = (await created.json()).id;

  // Approved content: uploaded through the page, parsed by the worker.
  await page.goto(`/projects/${projectId}/references`);
  await expect(page.getByRole("heading", { name: "Design reference" })).toBeVisible();
  await page
    .getByLabel("Upload documents")
    .setInputFiles({ name: "approved-content.md", mimeType: "text/markdown", buffer: approved });
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  const docRow = page.getByRole("row", { name: /approved-content\.md/ });
  await expect(docRow).toContainText("Parsed", { timeout: 30_000 });
  await expect(docRow).toContainText("13");
  await docRow.getByRole("button", { name: /View text/ }).click();
  await expect(page.getByText("Call to action", { exact: true })).toBeVisible();
  await expect(page.getByText("→ /contact")).toBeVisible();

  // Design values: JSON import into the editor, saved as the confirmed version 1.
  await page.getByText("Import or export JSON").click();
  await page.getByLabel("Design reference JSON").fill(designSpec);
  await page.getByRole("button", { name: "Load JSON into the editor" }).click();
  await expect(page.getByLabel("Heading 1 font size in px")).toHaveValue("48");
  await page.getByRole("button", { name: "Save design reference" }).click();
  await expect(page.getByText(/Active: version 1 \(entered manually\)/)).toBeVisible();
  expect(await axe(page)).toEqual([]);

  // Scan: the comparisons run after the scanners.
  await page.goto(`/projects/${projectId}/scan`);
  await expect(page.getByText(/Version 1 is confirmed/)).toBeVisible();
  await expect(page.getByText(/1 document ready for the content comparison/)).toBeVisible();
  await page.getByLabel(/I am authorized to test/).check();
  await page.getByRole("button", { name: "Start QA Scan" }).click();
  await page.waitForURL(new RegExp(`/projects/${projectId}/scans/[0-9a-f-]{36}$`));
  await expect(page.getByText("Final results.")).toBeVisible({ timeout: 150_000 });
  const progress = page.locator("section", { hasText: "Progress" }).first();
  for (const step of ["Design comparison", "Content comparison"])
    await expect(progress.locator("li", { hasText: step }).first()).toContainText("Completed");
  await expect(progress.locator("li", { hasText: "Design comparison" })).toContainText(
    /\d+ matched, \d+ mismatched/,
  );

  // Comparison report: every compared value with its verdict.
  await page
    .getByRole("link", { name: "View comparison (matches and mismatches)" })
    .first()
    .click();
  await page.waitForURL(/\/comparisons$/);
  const h1Size = page.getByRole("row", { name: /Heading 1 font size/ });
  await expect(h1Size).toContainText("Confirmed mismatch");
  await expect(h1Size).toContainText("48px");
  await expect(h1Size).toContainText("40px");
  await expect(page.getByRole("row", { name: /Heading 1 font family/ })).toContainText("Match");
  await expect(page.getByRole("row", { name: /Secondary button background/ })).toContainText(
    "Unable to verify",
  );
  await expect(page.getByRole("row", { name: /Free shipping on all orders/ })).toContainText(
    "Confirmed mismatch",
  );
  await expect(page.getByRole("row", { name: /Join our team/ }).first()).toContainText(
    "Unable to verify",
  );
  await page.getByRole("link", { name: "Potential mismatch" }).click();
  await page.waitForURL(/verdict=potential_mismatch/);
  await expect(page.getByRole("row", { name: /Header background/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /Heading 1 font size/ })).toHaveCount(0);
  expect(await axe(page)).toEqual([]);

  // Findings: content mismatches carry a word diff against the approved text.
  await page.goto(page.url().replace(/\/comparisons.*$/, "/findings?scanner=content"));
  const changed = page.locator("details", { hasText: "Our team ships quality products" }).first();
  await changed.locator("summary").click();
  await expect(changed.getByText("Text difference")).toBeVisible();
  await expect(changed.locator("ins", { hasText: "single" })).toBeVisible();
  expect(await axe(page)).toEqual([]);
});

test("the setup wizard uploads content and offers Start QA Scan", async ({ page, baseURL }) => {
  // Same account as the first test (sign-ups are rate limited).
  await signIn(page.request, baseURL!, user);
  await page.goto("/projects/new");
  await page.getByLabel("Project name").fill("Wizard with content");
  await page.getByLabel("Website URL").fill("http://localhost:4100");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: /Step 2 of 6/ })).toBeVisible();
  await page.getByRole("button", { name: "Skip for now" }).click();
  await page
    .getByLabel("Add documents")
    .setInputFiles({ name: "approved-content.md", mimeType: "text/markdown", buffer: approved });
  await expect(page.getByText(/approved-content\.md \(/)).toBeVisible();
  await page.getByLabel("Website page for approved-content.md (optional)").fill("/about");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByText("approved-content.md → /about")).toBeVisible();
  expect(await axe(page)).toEqual([]);
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByText(/was created and saved/)).toBeVisible();
  await expect(page.getByText("Parsed")).toBeVisible({ timeout: 30_000 });
  const start = page.getByRole("button", { name: "Start QA Scan" });
  await expect(start).toBeDisabled();
  await page.getByLabel(/I am authorized to test/).check();
  await expect(start).toBeEnabled();
  expect(await axe(page)).toEqual([]);
});
