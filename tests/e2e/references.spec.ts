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
// Openly licensed font (Geist, SIL OFL) shipped with Next.js: test data for the font upload.
const geist = readFileSync(
  new URL("../../node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf", import.meta.url),
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
  await expect(docRow).toContainText("Completed", { timeout: 30_000 });
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
  await changed.locator("summary").first().click();
  await expect(changed.getByText("What is the problem?")).toBeVisible();
  await changed.getByText("Technical details and evidence").click();
  await expect(changed.getByText("Text difference")).toBeVisible();
  await expect(changed.locator("ins", { hasText: "single" })).toBeVisible();
  expect(await axe(page)).toEqual([]);
});

test("the setup wizard uploads brand files and content, keeps page links, and offers Start QA Scan", async ({
  page,
  baseURL,
}) => {
  // Same account as the first test (sign-ups are rate limited).
  await signIn(page.request, baseURL!, user);
  await page.goto("/projects/new");
  // Five steps: the separate Content step is gone (content documents are in Figma / brand).
  await expect(page.getByRole("list", { name: "Setup steps" }).getByRole("listitem")).toHaveText([
    /Project/,
    /Figma \/ brand/,
    /Configure scan/,
    /Review/,
    /Start scan/,
  ]);
  await page.getByLabel("Project name").fill("Wizard with content");
  await page.getByLabel("Website URL").fill("http://localhost:4100");
  // Step 1: brand guidelines and font files (validated in the browser, uploaded after creation).
  await page.getByLabel("Brand guidelines (optional)").setInputFiles({
    name: "brand-guide.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# Brand guide\n\nPrimary — #1A56DB\n"),
  });
  await page
    .getByLabel("Font files (optional)")
    .setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("x") });
  await expect(page.getByText("notes.txt: only font files")).toBeVisible();
  await page
    .getByLabel("Font files (optional)")
    .setInputFiles({ name: "Geist-Regular.ttf", mimeType: "font/ttf", buffer: geist });
  await expect(page.getByRole("list", { name: "Selected font files" })).toContainText(
    "Geist-Regular.ttf",
  );
  await page.getByRole("button", { name: "Continue" }).click();

  // Step 2: Figma link, content document, page links.
  await expect(page.getByRole("heading", { name: /Step 2 of 5/ })).toBeVisible();
  await page
    .getByLabel("Add documents")
    .setInputFiles({ name: "approved-content.md", mimeType: "text/markdown", buffer: approved });
  await expect(page.getByText(/approved-content\.md \(/)).toBeVisible();
  await page.getByLabel("Website page for approved-content.md (optional)").fill("/about");
  const pageUrl = page.getByLabel("Page URL");
  const addPage = page.getByRole("button", { name: "Add page" });
  await pageUrl.fill("https://other.example/x");
  await addPage.click();
  await expect(page.getByRole("alert").filter({ hasText: "different website" })).toBeVisible();
  for (const path of ["/design-quality", "http://localhost:4100/contact"]) {
    await pageUrl.fill(path);
    await addPage.click();
  }
  await pageUrl.fill("/design-quality/");
  await addPage.click();
  await expect(page.getByText("/design-quality is already in the list.")).toBeVisible();
  await page.getByRole("button", { name: "Remove /contact" }).click();
  await expect(page.getByText("Added pages (1)")).toBeVisible();
  expect(await axe(page)).toEqual([]);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();

  // Review.
  await expect(page.getByText("approved-content.md → /about")).toBeVisible();
  await expect(page.getByText("brand-guide.md")).toBeVisible();
  await expect(page.getByText("Geist-Regular.ttf")).toBeVisible();
  await expect(page.locator("dd", { hasText: /^\/design-quality$/ })).toBeVisible();
  expect(await axe(page)).toEqual([]);
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByText(/was created and saved/)).toBeVisible();
  const uploads = page.getByRole("list", { name: "File uploads" });
  await expect(uploads.getByText("Uploaded", { exact: true })).toHaveCount(3, { timeout: 30_000 });
  await expect(uploads).toContainText("Font file read: “Geist” Regular");
  await expect(page.getByText("Completed", { exact: true })).toBeVisible({ timeout: 30_000 });
  // The brand guideline produced a draft that is not confirmed yet: the scan is held back until
  // the user confirms it or explicitly starts without the design comparison.
  await expect(page.getByText("References are not ready for this scan")).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    page.getByText(/design reference is a draft that has not been confirmed/),
  ).toBeVisible();
  const start = page.getByRole("button", { name: "Start QA Scan" });
  await expect(start).toBeDisabled();
  await page.getByLabel(/I am authorized to test/).check();
  await expect(start).toBeDisabled();
  await page.getByLabel(/Start anyway/).check();
  await expect(start).toBeEnabled();
  expect(await axe(page)).toEqual([]);

  // Everything is stored with the project and survives a reload of the References page.
  const refs = await page.getByRole("link", { name: "Open References" }).getAttribute("href");
  await page.goto(refs!);
  await page.reload();
  await expect(page.getByRole("list", { name: "Brand font files" })).toContainText("Geist");
  await expect(page.locator("#page-links-heading")).toBeVisible();
  await expect(page.getByText("http://localhost:4100/design-quality")).toBeVisible();
  await expect(page.getByRole("link", { name: "Content", exact: true })).toHaveCount(0);
  expect(await axe(page)).toEqual([]);
});
