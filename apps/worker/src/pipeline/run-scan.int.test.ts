import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createLogger,
  defaultScanDefaults,
  designSpecSchema,
  parseConfig,
  planScanSteps,
  type ScanAuth,
  type ScanConfigSnapshot,
} from "@qa/core";
import {
  closeDb,
  contentRepo,
  designSpecsRepo,
  getDb,
  pipelineRepo,
  projectsRepo,
  reportsRepo,
  scanIssuesRepo,
  schema,
  secretsRepo,
} from "@qa/db";
import { encryptSecret, type Resolver } from "@qa/security";
import { createLocalStorage } from "@qa/storage";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  HERO_PNG_BYTES,
  MEMBERS_PASSWORD,
  MEMBERS_USER,
  startDemoSite,
} from "../../../../fixtures/demo-site/server.mjs";
import { createTestUser, hasTestDb, resetDatabase } from "../../../../tests/setup/db";
import { processNextReferenceJob } from "../references/process";
import { processNextReport } from "../reports/generate";
import { runScan, type ScanRuntime } from "./run-scan";

// Deterministic DNS: only localhost exists, so external links never touch the internet.
const offlineDns: Resolver = async (host) => {
  if (host === "localhost") return [{ address: "127.0.0.1", family: 4 }];
  throw Object.assign(new Error(`${host} not found`), { code: "ENOTFOUND" });
};
const ENCRYPTION_KEY = "ab".repeat(32);

// Full pipeline: real test database, local fixture website, real Chromium and all six scanners.
describe.skipIf(!hasTestDb)("scan pipeline (preflight → crawl → capture → scanners)", () => {
  let site: Awaited<ReturnType<typeof startDemoSite>>;
  let storageDir: string;
  let rt: ScanRuntime;
  let ownerId: string;

  beforeAll(async () => {
    await resetDatabase();
    site = await startDemoSite(0);
    storageDir = await mkdtemp(path.join(os.tmpdir(), "qa-scan-"));
    const config = parseConfig({
      DATABASE_URL: process.env.TEST_DATABASE_URL,
      BETTER_AUTH_SECRET: "integration-test-secret-0123456789abcdef",
      ENCRYPTION_KEY,
      SCAN_ALLOWED_PRIVATE_HOSTS: `localhost:${site.port}`,
      LINK_CHECK_RETRIES: "1",
      SCAN_SCANNER_TIMEOUT_MS: "240000",
    });
    rt = {
      db: getDb(),
      storage: createLocalStorage(storageDir),
      config,
      log: createLogger(),
      heartbeatMs: 200,
      resolve: offlineDns,
    };
    ownerId = (await createTestUser()).id;
  }, 60_000);
  afterAll(async () => {
    await site?.close();
    await rm(storageDir, { recursive: true, force: true });
    await closeDb();
  });

  async function queueScan(
    websiteUrl: string,
    overrides: Partial<ScanConfigSnapshot> = {},
    credentials?: ScanAuth,
  ) {
    const defaults = defaultScanDefaults();
    const project = await projectsRepo.createProject(getDb(), ownerId, {
      name: `Fixture ${Date.now()}`,
      websiteUrl,
      scanDefaults: defaults,
    });
    if (credentials)
      await secretsRepo.setProjectSecret(
        getDb(),
        project.id,
        secretsRepo.SCAN_AUTH_KIND,
        encryptSecret(JSON.stringify(credentials), ENCRYPTION_KEY, project.id),
        { type: credentials.type },
      );
    const snapshot: ScanConfigSnapshot = {
      websiteUrl,
      scanners: defaults.scanners,
      viewports: defaults.viewports,
      maxPages: 25,
      maxDepth: 3,
      respectRobots: true,
      pageTimeoutMs: 15_000,
      concurrency: 3,
      userAgent: "QACopilotTest/1.0",
      authorizationAttestedAt: new Date().toISOString(),
      authType: credentials?.type ?? null,
      ...overrides,
    };
    const scan = await pipelineRepo.createScan(getDb(), ownerId, project.id, {
      configSnapshot: snapshot as unknown as Record<string, unknown>,
      steps: planScanSteps(snapshot.scanners),
      triggeredByUserId: ownerId,
    });
    return scan!;
  }

  const stepsOf = async (scanId: string) =>
    Object.fromEntries(
      (
        await getDb().select().from(schema.scannerRun).where(eq(schema.scannerRun.scanId, scanId))
      ).map((r) => [r.stepKey, r]),
    );
  const pagesOf = async (scanId: string) =>
    new Map(
      (await getDb().select().from(schema.page).where(eq(schema.page.scanId, scanId))).map((p) => [
        new URL(p.url).pathname,
        p,
      ]),
    );

  it("crawls, captures and runs all six scanners on the fixture site", async () => {
    const queued = await queueScan(site.url);
    const claimed = await pipelineRepo.claimNextScan(getDb(), "test-worker");
    expect(claimed?.id).toBe(queued.id);
    expect(await pipelineRepo.claimNextScan(getDb(), "other-worker")).toBeNull();

    await runScan(rt, claimed!);

    const detail = await pipelineRepo.getScanDetail(getDb(), ownerId, queued.id);
    expect(detail!.status).toBe("completed");
    const steps = await stepsOf(queued.id);
    expect(steps.preflight!.statusReason).toMatch(
      /Reachable: HTTP 200.*technology: could not determine.*robots.txt: found/,
    );
    expect(steps.crawl!.statusReason).toMatch(
      /18 pages fetched; 3 returned an error.*; 1 skipped \(robots.txt\)/,
    );
    expect(steps.capture!.statusReason).toMatch(
      /39 of 39 page captures succeeded \(2 redirecting URLs not captured twice\)/,
    );
    for (const key of ["accessibility", "security", "seo", "links", "performance", "responsive"]) {
      expect(steps[key], key).toMatchObject({ status: "completed" });
      expect(steps[key]!.findingCount, key).toBeGreaterThan(0);
      expect(steps[key]!.toolName, key).toBeTruthy();
      expect(steps[key]!.checks, key).toMatchObject({ evaluated: expect.any(Number) });
    }
    // Without references the comparisons are skipped with the reason (never "completed").
    expect(steps.design).toMatchObject({
      status: "skipped",
      statusReason: expect.stringMatching(/No confirmed design reference/),
    });
    // No AI provider in this runtime: the AI step is skipped with the reason, and the grounding
    // step still turns every finding into an issue (scanner wording).
    expect(steps.ai).toMatchObject({
      status: "skipped",
      statusReason: expect.stringMatching(/No AI provider configured \(AI_PROVIDER=none\)/),
    });
    expect(steps.grounding).toMatchObject({
      status: "completed",
      toolName: "QA Copilot grounding validator",
      statusReason: expect.stringMatching(/^\d+ issues from \d+ findings .*no AI text to validate/),
    });
    // Reports are generated on demand for finished scans, not during the scan (Phase 8).
    expect(steps.report).toBeUndefined();

    const pages = await pagesOf(queued.id);
    expect(pages.size).toBe(19);
    expect(pages.get("/members")!.httpStatus).toBe(401);
    expect(pages.get("/private/secret")!.crawlError).toBe("Not crawled: disallowed by robots.txt");
    expect(pages.get("/chain-start")!.redirectChain).toHaveLength(2);

    // Every intentional fixture defect is detected by the responsible scanner.
    const findings = (await pipelineRepo.listFindingsForScan(getDb(), ownerId, queued.id))!;
    const has = (scanner: string, ruleId: string, pathname?: string) =>
      findings.some(
        (f) =>
          f.scanner === scanner &&
          f.ruleId === ruleId &&
          (pathname === undefined || (f.pageUrl && new URL(f.pageUrl).pathname === pathname)),
      );
    const expected: Array<[string, string, string?]> = [
      ["accessibility", "image-alt", "/about"],
      ["accessibility", "label", "/contact"],
      ["accessibility", "button-name", "/contact"],
      ["accessibility", "color-contrast", "/products"],
      ["accessibility", "heading-order", "/blog/post-2"],
      ["security", "https-not-used"],
      ["security", "csp-missing"],
      ["security", "frame-protection-missing"],
      ["security", "server-version-disclosure"],
      ["security", "cookie-flags"],
      ["security", "exposed-secret-aws-access-key", "/"],
      ["seo", "meta-description-missing", "/about"],
      ["seo", "title-duplicate"],
      ["seo", "h1-multiple", "/blog/post-2"],
      ["seo", "structured-data-invalid", "/"],
      ["seo", "sitemap-not-found"],
      ["links", "broken-internal-link"],
      ["links", "broken-external-link"],
      ["links", "redirect-chain"],
      ["links", "failed-resource", "/products/gadget"],
      ["performance", "ttfb-slow", "/slow"],
      ["performance", "image-large"],
      ["performance", "render-blocking-resource"],
      ["responsive", "horizontal-overflow", "/wide"],
      ["responsive", "text-clipped", "/wide"],
      ["responsive", "tap-target-small", "/contact"],
      ["responsive", "interactive-overlap", "/contact"],
    ];
    for (const [scanner, ruleId, pathname] of expected)
      expect(has(scanner, ruleId, pathname), `${scanner}/${ruleId} ${pathname ?? ""}`).toBe(true);

    // Redirecting URLs are not analyzed twice.
    expect(findings.some((f) => f.pageUrl && /old-page|chain-start/.test(f.pageUrl))).toBe(false);
    expect(findings.filter((f) => f.ruleId === "title-duplicate")).toHaveLength(1);
    // Every finding has evidence, a display id and a stored fingerprint.
    expect(
      findings.every((f) => f.evidence.length > 0 && /^[A-Z0-9]+-\d{3}$/.test(f.displayId)),
    ).toBe(true);
    // The members area (401 without credentials) is inconclusive, not "broken".
    expect(
      findings.some(
        (f) => f.ruleId.startsWith("broken") && /members/.test(JSON.stringify(f.evidence)),
      ),
    ).toBe(false);
    expect(JSON.stringify(steps.links!.checks)).toMatch(/members.*HTTP 401/);

    // Issues: one per rule (deterministic grouping), every finding in exactly one issue.
    const scanIssues = (await scanIssuesRepo.listScanIssues(getDb(), ownerId, queued.id))!;
    const linked = scanIssues.issues.flatMap((i) => i.findings.map((x) => x.id));
    expect(new Set(linked).size).toBe(findings.length);
    expect(linked).toHaveLength(findings.length);
    expect(scanIssues.issues).toHaveLength(
      new Set(findings.map((x) => `${x.scanner}/${x.ruleId}`)).size,
    );
    expect(
      scanIssues.issues.every(
        (i) =>
          i.origin === "deterministic" &&
          i.groundingStatus === "not_applicable" &&
          i.recommendation,
      ),
    ).toBe(true);
    const contrast = scanIssues.issues.find((i) => i.ruleId === "color-contrast")!;
    expect(contrast.affectedUrls.some((u) => u.endsWith("/products"))).toBe(true);
    expect(contrast.recommendation).toMatch(/dequeuniversity\.com\/rules\/axe/);
    expect(steps.grounding!.statusReason).toContain(
      `${scanIssues.issues.length} issues from ${findings.length} findings`,
    );

    // Report (Phase 8): built from this scan's stored rows, nothing added or lost.
    expect(
      (await reportsRepo.createReport(getDb(), ownerId, queued.id, "json", ownerId)).kind,
    ).toBe("created");
    expect(await processNextReport(rt)).toBe(true);
    const [reportRow] = await getDb()
      .select()
      .from(schema.report)
      .where(eq(schema.report.scanId, queued.id));
    expect(reportRow!.status).toBe("completed");
    const report = JSON.parse((await rt.storage.read(reportRow!.storageKey!)).toString("utf8"));
    expect(report.issues).toHaveLength(scanIssues.issues.length);
    expect(report.summary.findings.total).toBe(findings.length);
    expect(
      report.issues
        .flatMap((i: { findings: Array<{ id: string }> }) => i.findings.map((x) => x.id))
        .sort(),
    ).toEqual(findings.map((x) => x.displayId).sort());
    expect(report.issues.map((i: { id: string }) => i.id).sort()).toEqual(
      scanIssues.issues.map((i) => `ISSUE-${i.displayNo}`).sort(),
    );
    expect(report.steps.map((x: { key: string }) => x.key).sort()).toEqual(
      Object.keys(steps).sort(),
    );

    // Capture measurements are stored.
    const homeCapture = (
      await getDb()
        .select()
        .from(schema.pageCapture)
        .where(eq(schema.pageCapture.pageId, pages.get("/")!.id))
    ).find((c) => c.viewport === "desktop")!;
    expect(homeCapture.metrics).toMatchObject({
      vitals: expect.any(Object),
      images: expect.any(Array),
    });
    const requests = await getDb()
      .select()
      .from(schema.networkRequest)
      .where(eq(schema.networkRequest.pageCaptureId, homeCapture.id));
    expect(requests.find((r) => r.url.endsWith("/images/hero.png"))).toMatchObject({
      status: 200,
      decodedSize: HERO_PNG_BYTES,
      resourceType: "image",
      fromCache: null,
    });
  }, 300_000);

  it("scans the login-protected area with site credentials (and reports rejected ones)", async () => {
    const ok = await queueScan(
      `${site.url}members`,
      {
        maxPages: 10,
        maxDepth: 1,
        viewports: [{ name: "desktop", width: 1280, height: 800 }],
        scanners: ["links"],
      },
      { type: "basic", username: MEMBERS_USER, password: MEMBERS_PASSWORD },
    );
    await runScan(rt, (await pipelineRepo.claimNextScan(getDb(), "w"))!);
    const okSteps = await stepsOf(ok.id);
    expect(okSteps.preflight!.statusReason).toMatch(/site credentials: basic/);
    const okPages = await pagesOf(ok.id);
    expect(okPages.get("/members")!.httpStatus).toBe(200);
    expect(okPages.get("/members/profile")!.httpStatus).toBe(200);
    expect(okSteps.capture!.status).toBe("completed");

    const bad = await queueScan(
      `${site.url}members`,
      {
        maxPages: 10,
        maxDepth: 1,
        viewports: [{ name: "desktop", width: 1280, height: 800 }],
        scanners: ["links"],
      },
      { type: "basic", username: MEMBERS_USER, password: "wrong" },
    );
    await runScan(rt, (await pipelineRepo.claimNextScan(getDb(), "w"))!);
    const badSteps = await stepsOf(bad.id);
    expect(badSteps.preflight).toMatchObject({
      status: "inconclusive",
      statusReason: expect.stringMatching(/even with the configured basic credentials/),
    });
    expect((await pipelineRepo.getScanDetail(getDb(), ownerId, bad.id))!.status).toBe("failed");
  }, 180_000);

  it("fails clearly when credentials were removed after queueing", async () => {
    const queued = await queueScan(
      site.url,
      { scanners: ["seo"] },
      { type: "header", name: "X-Key", value: "k" },
    );
    await secretsRepo.deleteProjectSecret(
      getDb(),
      (await pipelineRepo.getScanDetail(getDb(), ownerId, queued.id))!.projectId,
      secretsRepo.SCAN_AUTH_KIND,
    );
    await runScan(rt, (await pipelineRepo.claimNextScan(getDb(), "w"))!);
    const steps = await stepsOf(queued.id);
    expect(steps.preflight).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/removed after this scan was queued/),
    });
    expect(steps.seo!.status).toBe("skipped");
  }, 60_000);

  it("compares the fixture site against a design spec and approved content", async () => {
    const project = await projectsRepo.createProject(getDb(), ownerId, {
      name: "Fixture with references",
      websiteUrl: site.url,
      scanDefaults: defaultScanDefaults(),
    });
    const fixture = (name: string) =>
      readFileSync(new URL(`../../../../fixtures/documents/${name}`, import.meta.url));
    const spec = await designSpecsRepo.saveConfirmedSpec(
      getDb(),
      project.id,
      designSpecSchema.parse(JSON.parse(fixture("design-spec.json").toString("utf8"))),
      { userId: ownerId },
    );
    const md = fixture("approved-content.md");
    const key = `projects/${project.id}/documents/approved.md`;
    await rt.storage.put(key, md);
    const doc = await contentRepo.insertDocument(getDb(), project.id, {
      filename: "approved-content.md",
      mimeType: "text/markdown",
      sizeBytes: md.length,
      sha256: createHash("sha256").update(md).digest("hex"),
      storageKey: key,
      targetPath: null,
    });
    while (await processNextReferenceJob({ ...rt })) {
      // drain the reference queue
    }
    const parsed = (await contentRepo.listParsedDocuments(getDb(), project.id))[0]!;
    expect(parsed.blockCount).toBe(13);

    const snapshot: ScanConfigSnapshot = {
      websiteUrl: site.url,
      scanners: ["seo"],
      viewports: [
        { name: "desktop", width: 1440, height: 900 },
        { name: "mobile", width: 390, height: 844 },
      ],
      maxPages: 25,
      maxDepth: 3,
      respectRobots: true,
      pageTimeoutMs: 15_000,
      concurrency: 3,
      userAgent: "QACopilotTest/1.0",
      authorizationAttestedAt: new Date().toISOString(),
      authType: null,
      designSpecVersion: spec.version,
      contentDocuments: [
        {
          id: doc.id,
          filename: doc.filename,
          sha256: doc.sha256,
          targetPath: null,
          blockCount: 13,
        },
      ],
    };
    const queued = (await pipelineRepo.createScan(getDb(), ownerId, project.id, {
      configSnapshot: snapshot as unknown as Record<string, unknown>,
      steps: planScanSteps(["seo"], { designSpec: true, content: true }),
      triggeredByUserId: ownerId,
      designSpecId: spec.id,
    }))!;
    await runScan(rt, (await pipelineRepo.claimNextScan(getDb(), "w"))!);
    const steps = await stepsOf(queued.id);
    expect(steps.design).toMatchObject({
      status: "completed",
      toolName: expect.stringMatching(/CIEDE2000/),
    });
    expect(steps.content).toMatchObject({ status: "completed" });

    type Cmp = { items: Array<{ key: string; verdict: string; actual?: string | null }> };
    const design = (steps.design!.checks as { comparison: Cmp }).comparison;
    const verdicts = Object.fromEntries(design.items.map((i) => [i.key, i.verdict]));
    expect(verdicts).toMatchObject({
      "typography.h1.fontFamily": "match",
      "typography.h1.fontSize": "confirmed_mismatch", // 40px on the site, 48px in the spec
      "typography.h1.fontWeight": "match",
      "typography.h1.color": "match",
      "typography.h3.fontSize": "unable_to_verify", // no h3 on the site
      "typography.body.fontFamily": "confirmed_mismatch", // system-ui instead of Inter
      "typography.body.fontSize": "match",
      "colors.Text": "confirmed_mismatch", // the low-contrast #c4c4c4 paragraph on /products
      "colors.Link": "confirmed_mismatch", // #0645ad vs #1a56db (ΔE 7.86)
      "colors.Header": "potential_mismatch", // #f1f5f9 vs #e2e8f0 (ΔE 3.36)
      "colors.Page": "match",
      "components.buttonPrimary.background": "potential_mismatch", // ΔE 2.61, class heuristic
      "components.buttonPrimary.color": "match",
      "components.buttonPrimary.borderRadius": "potential_mismatch", // 6px vs 8px, heuristic
      "components.buttonPrimary.paddingX": "match",
      "components.buttonPrimary.paddingY": "match",
      "components.buttonSecondary.background": "unable_to_verify",
      "layout.containerMaxWidth": "unable_to_verify",
    });
    expect(design.items.find((i) => i.key === "colors.Text")!.actual).toBe("#c4c4c4");

    const content = (steps.content!.checks as { comparison: Cmp }).comparison;
    expect(content.items.map((i) => i.verdict)).toEqual([
      "match", // Contact (heading similarity → /contact)
      "potential_mismatch", // "We reply within one business day." missing (mapping not explicit)
      "match", // About us (page marker /about)
      "match",
      "confirmed_mismatch", // "every single week" → changed wording
      "potential_mismatch", // "Our Mission" vs "Our mission"
      "confirmed_mismatch", // "Free shipping…" missing
      "confirmed_mismatch", // CTA links to /blog/ instead of /contact
      "match", // Products (page name)
      "match", // "Prices include VAT." contained in the page text
      "potential_mismatch", // "… gadgets today." changed wording on a name-mapped page
      "unable_to_verify", // Careers: no such page
      "unable_to_verify",
    ]);

    const findings = (await pipelineRepo.listFindingsForScan(getDb(), ownerId, queued.id))!;
    const byRule = (scanner: string, rule: string) =>
      findings.filter((f) => f.scanner === scanner && f.ruleId === rule);
    expect(byRule("design", "design-font-size-mismatch")[0]).toMatchObject({
      verdict: "confirmed",
      expected: "48px",
      actual: "40px",
      displayId: expect.stringMatching(/^DSN-\d{3}$/),
    });
    expect(byRule("content", "content-link-target-mismatch")[0]).toMatchObject({
      verdict: "confirmed",
      severity: "high",
      pageUrl: expect.stringMatching(/\/about$/),
    });
    // Browser-default form control colors (e.g. the /contact button) are not palette near-misses.
    expect(byRule("design", "design-color-near-palette")).toHaveLength(0);
    // Each design/content mismatch is its own issue, citing the reference value.
    const refIssues = (await scanIssuesRepo.listScanIssues(getDb(), ownerId, queued.id))!.issues;
    const designFindings = findings.filter((x) => x.scanner === "design");
    expect(refIssues.filter((i) => i.category === "design")).toHaveLength(designFindings.length);
    expect(refIssues.filter((i) => i.category === "content")).toHaveLength(
      findings.filter((x) => x.scanner === "content").length,
    );
    expect(refIssues.find((i) => i.title.startsWith("Heading 1 font size"))).toMatchObject({
      ruleId: "design-font-size-mismatch",
      expected: "48px",
      actual: "40px",
      recommendation: expect.stringMatching(
        /typography\.h1\.fontSize is 48px as defined in the design reference/,
      ),
    });
    const changed = byRule("content", "content-changed-wording").find(
      (f) => f.verdict === "confirmed",
    )!;
    expect(changed.evidence.map((e) => e.kind)).toEqual(["document", "text_diff", "screenshot"]);

    // Computed styles are stored for every capture; text only at the widest viewport.
    const captures = await getDb()
      .select()
      .from(schema.pageCapture)
      .innerJoin(schema.page, eq(schema.page.id, schema.pageCapture.pageId))
      .where(eq(schema.page.scanId, queued.id));
    expect(captures.every((c) => c.page_capture.computedStylesKey)).toBe(true);
    expect(
      captures
        .filter((c) => c.page_capture.textContentKey)
        .every((c) => c.page_capture.viewport === "desktop"),
    ).toBe(true);
    expect(captures.some((c) => c.page_capture.textContentKey)).toBe(true);
  }, 240_000);

  it("respects page limits and ignores robots.txt when configured", async () => {
    const queued = await queueScan(site.url, {
      maxPages: 3,
      respectRobots: false,
      viewports: [{ name: "desktop", width: 1280, height: 800 }],
      scanners: ["seo"],
    });
    await runScan(rt, (await pipelineRepo.claimNextScan(getDb(), "test-worker"))!);
    const steps = await stepsOf(queued.id);
    expect(steps.crawl!.statusReason).toMatch(/3 pages fetched.*page limit of 3 reached/);
    expect(steps.preflight!.statusReason).toMatch(/robots.txt: ignored/);
    expect(steps.links).toBeUndefined(); // scanners not selected get no pipeline step at all
  }, 120_000);

  it("scans user-selected page links and runs Design Quality & Typography on them", async () => {
    // /design-quality is not linked from any page of the fixture site (test data with known,
    // intentional defects; see fixtures/demo-site/README.md).
    const queued = await queueScan(site.url, {
      scanners: ["design_quality"],
      viewports: [
        { name: "desktop", width: 1440, height: 900 },
        { name: "mobile", width: 390, height: 844 },
      ],
      maxPages: 1,
      maxDepth: 0,
      pageLinks: [`${site.url}design-quality`, `${site.url}no-such-page`],
      approvedFonts: [
        {
          id: "f1",
          filename: "brand.woff2",
          families: ["Brand Missing"],
          weight: 400,
          italic: false,
        },
      ],
    });
    await runScan(rt, (await pipelineRepo.claimNextScan(getDb(), "test-worker"))!);
    const detail = await pipelineRepo.getScanDetail(getDb(), ownerId, queued.id);
    expect(detail!.status).toBe("completed");
    const steps = await stepsOf(queued.id);
    // The page links were visited although the page limit is 1 and the depth 0; the missing one
    // is reported with its real status, not dropped.
    expect(steps.crawl!.statusReason).toMatch(
      /page links: 1 of 2 added by you loaded \(failed: .*no-such-page – HTTP 404\)/,
    );
    const pages = await pagesOf(queued.id);
    expect(pages.get("/")!.origin).toBe("crawl");
    expect(pages.get("/design-quality")).toMatchObject({ origin: "user", httpStatus: 200 });
    expect(pages.get("/no-such-page")).toMatchObject({ origin: "user", httpStatus: 404 });

    const order = Object.values(steps)
      .sort((a, b) => a.position - b.position)
      .map((s) => s.stepKey);
    expect(order).toEqual([
      "preflight",
      "crawl",
      "capture",
      "design",
      "content",
      "design_quality",
      "ai",
      "grounding",
    ]);
    const dq = steps.design_quality!;
    expect(dq).toMatchObject({ status: "completed", toolVersion: "1.0.0" });
    const parts = (dq.checks as { parts: Array<{ key: string; status: string }> }).parts;
    expect(Object.fromEntries(parts.map((x) => [x.key, x.status]))).toEqual({
      headings: "completed",
      reference: "not_configured",
      fonts: "completed",
      images: "completed",
      layout: "completed",
      content: "not_configured",
    });

    const findings = await getDb()
      .select()
      .from(schema.rawFinding)
      .where(eq(schema.rawFinding.scanId, queued.id));
    const dqFindings = findings.filter((f) => f.scanner === "design_quality");
    const byRule = (rule: string) => dqFindings.filter((f) => f.ruleId === rule);
    expect(byRule("dq-heading-inconsistent")).toHaveLength(1);
    expect(byRule("dq-heading-inconsistent")[0]!.actual).toMatch(
      /28px, weight 700.*22px, weight 400/,
    );
    expect(byRule("dq-heading-hierarchy-inverted")[0]!.title).toBe(
      "H3 headings are larger than H2 headings",
    );
    // Measured with Chromium's font engine: the missing web font fell back to Georgia.
    const webfont = byRule("dq-webfont-not-rendered")[0]!;
    expect(webfont).toMatchObject({
      verdict: "confirmed",
      expected: "Text rendered with “Brand Missing”",
    });
    expect(webfont.actual).toMatch(/Georgia/);
    const upscaled = byRule("dq-image-upscaled");
    expect(upscaled.map((f) => f.actual).sort()).toEqual([
      "40×40px source, enlarged 4×",
      "600×200px source, enlarged 2×",
    ]);
    expect(byRule("dq-image-distorted")[0]!.title).toBe(
      "Image is stretched: aspect ratio changed by 33%",
    );
    expect(byRule("dq-alignment-near-miss")[0]!.actual).toBe("3px offset");
    expect(byRule("dq-spacing-inconsistent")[0]!.actual).toBe("16px, 28px, 16px");
    // The uploaded "brand font" is the one that failed: reported as declared but not rendered.
    const cmp = (dq.checks as { comparison: { items: Array<{ key: string; verdict: string }> } })
      .comparison;
    expect(cmp.items.find((i) => i.key === "font.f1")!.verdict).toBe("confirmed_mismatch");
    // Every finding has evidence and became part of an issue.
    expect(dqFindings.every((f) => f.fingerprint.length === 64)).toBe(true);
    const issues = await scanIssuesRepo.listScanIssues(getDb(), ownerId, queued.id);
    expect(issues!.issues.filter((i) => i.category === "design_quality").length).toBeGreaterThan(5);
  }, 180_000);

  it("fails clearly when the website is unreachable and skips the rest", async () => {
    const queued = await queueScan(`http://localhost:${site.port}/`);
    await site.close();
    try {
      await runScan(rt, (await pipelineRepo.claimNextScan(getDb(), "test-worker"))!);
      const detail = await pipelineRepo.getScanDetail(getDb(), ownerId, queued.id);
      expect(detail).toMatchObject({ status: "failed", error: "Website unreachable" });
      const steps = await stepsOf(queued.id);
      expect(steps.preflight).toMatchObject({
        status: "failed",
        error: expect.stringMatching(/Website unreachable: ECONNREFUSED/),
      });
      expect(steps.crawl).toMatchObject({
        status: "skipped",
        statusReason: "Not run: Website unreachable",
      });
      expect(steps.accessibility!.status).toBe("skipped");
    } finally {
      site = await startDemoSite(site.port);
    }
  }, 60_000);

  it("refuses public hostnames that resolve to internal addresses", async () => {
    const queued = await queueScan("https://internal-alias.example/");
    await runScan(
      { ...rt, resolve: async () => [{ address: "10.1.2.3", family: 4 }] },
      (await pipelineRepo.claimNextScan(getDb(), "test-worker"))!,
    );
    const steps = await stepsOf(queued.id);
    expect(steps.preflight).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/Blocked for safety: .*10\.1\.2\.3/),
    });
  }, 60_000);

  it("cancels a running scan", async () => {
    const queued = await queueScan(site.url);
    const claimed = await pipelineRepo.claimNextScan(getDb(), "test-worker");
    expect(await pipelineRepo.requestCancel(getDb(), ownerId, queued.id)).toMatchObject({
      previousStatus: "running",
    });
    await runScan(rt, claimed!);
    const detail = await pipelineRepo.getScanDetail(getDb(), ownerId, queued.id);
    expect(detail!.status).toBe("cancelled");
    expect(detail!.runs.filter((r) => r.status === "pending" || r.status === "running")).toEqual(
      [],
    );
  }, 60_000);

  it("cancels queued scans immediately and recovers scans whose worker died", async () => {
    const queued = await queueScan(site.url);
    expect(await pipelineRepo.requestCancel(getDb(), ownerId, queued.id)).toMatchObject({
      status: "cancelled",
    });
    expect(await pipelineRepo.claimNextScan(getDb(), "w")).toBeNull();

    const orphan = await queueScan(site.url);
    await pipelineRepo.claimNextScan(getDb(), "crashed-worker");
    await getDb()
      .update(schema.scan)
      .set({ heartbeatAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(schema.scan.id, orphan.id));
    expect(await pipelineRepo.failStaleScans(getDb(), 120_000)).toEqual([orphan.id]);
    expect(await pipelineRepo.getScanDetail(getDb(), ownerId, orphan.id)).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/worker stopped/),
    });
  }, 60_000);
});
