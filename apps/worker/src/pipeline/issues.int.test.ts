import {
  AIProviderError,
  NoAIProvider,
  type AIProvider,
  type AiIssue,
  type StructuredRequest,
} from "@qa/ai";
import { createLogger, defaultScanDefaults, parseConfig, planScanSteps } from "@qa/core";
import { closeDb, getDb, pipelineRepo, projectsRepo, scanIssuesRepo, schema } from "@qa/db";
import { asc, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestUser, hasTestDb, resetDatabase } from "../../../../tests/setup/db";
import { aiStep, groundingStep, type IssueStepEnv } from "./issue-steps";

type NewFinding = pipelineRepo.NewFinding;

const SITE = "http://localhost:4100";
const config = parseConfig({
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  BETTER_AUTH_SECRET: "integration-test-secret-0123456789abcdef",
  SCAN_SCANNER_TIMEOUT_MS: "60000",
});

const f = (p: Partial<NewFinding> & Pick<NewFinding, "ruleId" | "title">): NewFinding => ({
  message: `${p.title}.`,
  category: "seo",
  subcategory: null,
  pageId: null,
  locationKey: "site",
  selector: null,
  viewport: null,
  severity: "medium",
  verdict: "confirmed",
  confidence: 0.95,
  expected: null,
  actual: null,
  fingerprintKey: null,
  evidence: [{ kind: "document", data: { note: "observed" } }],
  ...p,
});

/** Answers per group from the batch input; scripted per rule. */
function scriptedProvider(
  answer: (group: { groupId: string; ruleId: string; ids: string[] }) => AiIssue | null | Error,
): AIProvider & { requests: number } {
  const provider = {
    id: "anthropic" as const,
    model: "claude-test",
    label: "Scripted test provider",
    requests: 0,
    async generateStructured<T>(req: StructuredRequest<T>) {
      provider.requests += 1;
      const data = JSON.parse(
        req.input.split("<scan_findings>\n")[1]!.split("\n</scan_findings>")[0]!,
      ) as {
        groups: Array<{ groupId: string; ruleId: string; findings: Array<{ id: string }> }>;
      };
      const issues: AiIssue[] = [];
      for (const g of data.groups) {
        const a = answer({
          groupId: g.groupId,
          ruleId: g.ruleId,
          ids: g.findings.map((x) => x.id),
        });
        if (a instanceof Error) throw a;
        if (a) issues.push(a);
      }
      return {
        data: req.schema.parse({ issues }),
        usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0 },
        model: "claude-test",
        latencyMs: 12,
        stopReason: "end_turn",
        fallbackUsed: false,
      };
    },
  };
  return provider;
}

const aiText = (groupId: string, ids: string[], over: Partial<AiIssue> = {}): AiIssue => ({
  groupId,
  sourceFindingIds: ids,
  title: "Text on the products page is hard to read",
  description:
    "Two elements on http://localhost:4100/products use #c4c4c4 on #ffffff, below the expected contrast ratio of 4.5:1.",
  severity: "high",
  severityRationale: "Unreadable text blocks users with low vision.",
  affectedElement: null,
  expected: null,
  actual: null,
  recommendation: "Darken the text of p.muted and span.note.",
  claims: [
    { text: "Expected contrast ratio of 4.5:1", findingId: ids[0]!, evidenceField: "actual" },
  ],
  ...over,
});

describe.skipIf(!hasTestDb)(
  "issue steps: AI interpretation, grounding and issues (real PostgreSQL)",
  () => {
    const db = () => getDb();
    let ownerId: string;
    let strangerId: string;
    let projectId: string;

    async function newScan(findings: Record<string, NewFinding[]>) {
      const scan = (await pipelineRepo.createScan(db(), ownerId, projectId, {
        configSnapshot: {},
        steps: planScanSteps(["accessibility", "seo", "performance", "responsive"]),
        triggeredByUserId: ownerId,
      }))!;
      const pageIds: Record<string, string> = {};
      for (const path of ["/about", "/contact", "/products"])
        pageIds[path] = (await pipelineRepo.insertPage(db(), scan.id, {
          url: `${SITE}${path}`,
          normalizedUrl: `${SITE}${path}`,
          finalUrl: null,
          httpStatus: 200,
          redirectChain: null,
          depth: 1,
          discoveredFrom: null,
          title: null,
          contentType: "text/html",
          responseHeaders: null,
          rawHtmlKey: null,
          crawlError: null,
        }))!;
      const prefix: Record<string, string> = {
        accessibility: "A11Y",
        seo: "SEO",
        performance: "PERF",
        responsive: "RSP",
      };
      for (const [scanner, list] of Object.entries(findings))
        await pipelineRepo.insertFindings(
          db(),
          scan.id,
          scanner,
          prefix[scanner]!,
          list.map((x) => ({
            ...x,
            category: scanner,
            pageId: x.locationKey.startsWith("/") ? pageIds[x.locationKey]! : null,
          })),
        );
      return scan.id;
    }

    const fixtureFindings = (): Record<string, NewFinding[]> => ({
      accessibility: ["p.muted", "span.note"].map((selector, i) =>
        f({
          ruleId: "color-contrast",
          title: "Elements must meet minimum color contrast ratio thresholds",
          severity: "high",
          locationKey: "/products",
          selector,
          actual: `Element has insufficient color contrast of ${i ? "2.1" : "1.66"} (foreground color: #c4c4c4, background color: #ffffff). Expected contrast ratio of 4.5:1`,
          evidence: [
            {
              kind: "axe_node",
              data: {
                ruleId: "color-contrast",
                wcag: ["wcag2aa", "wcag143"],
                helpUrl: "https://dequeuniversity.com/rules/axe/4.13/color-contrast",
                target: selector,
              },
            },
          ],
        }),
      ),
      performance: [
        f({
          ruleId: "lcp-slow",
          title: "Largest Contentful Paint is poor",
          severity: "high",
          locationKey: "/products",
          expected: "≤ 2500 ms",
          actual: "4232 ms",
          evidence: [{ kind: "measurement", data: { metric: "lcp", values: { desktop: 4231.6 } } }],
        }),
      ],
      seo: [
        f({ ruleId: "h1-missing", title: "Page has no H1 heading", locationKey: "/products" }),
        ...["/about", "/contact"].map((path) =>
          f({
            ruleId: "meta-description-missing",
            title: "Meta description is missing",
            locationKey: path,
            actual: "No meta description",
          }),
        ),
      ],
      responsive: [
        f({
          ruleId: "tap-target-small",
          title: "Touch target is smaller than 24×24 px",
          locationKey: "/contact",
          selector: "a.tiny",
          verdict: "potential",
          confidence: 0.7,
        }),
      ],
    });

    const env = (scanId: string, provider: AIProvider): IssueStepEnv => ({
      db: db(),
      log: createLogger(),
      config,
      scanId,
      provider,
      signal: new AbortController().signal,
      designSpec: null,
      state: { runIds: new Map() },
    });

    const snapshotFindings = async (scanId: string) => {
      const rows = await db()
        .select()
        .from(schema.rawFinding)
        .where(eq(schema.rawFinding.scanId, scanId))
        .orderBy(asc(schema.rawFinding.displayId));
      const ev = await db()
        .select()
        .from(schema.evidence)
        .where(
          inArray(
            schema.evidence.rawFindingId,
            rows.map((r) => r.id),
          ),
        )
        .orderBy(asc(schema.evidence.id));
      return JSON.stringify({ rows, ev });
    };

    beforeAll(async () => {
      await resetDatabase();
      ownerId = (await createTestUser("Owner")).id;
      strangerId = (await createTestUser("Stranger")).id;
      projectId = (
        await projectsRepo.createProject(db(), ownerId, {
          name: "Issues",
          websiteUrl: `${SITE}/`,
          scanDefaults: defaultScanDefaults(),
        })
      ).id;
    });
    afterAll(async () => {
      await closeDb();
    });

    it("without AI: every finding ends up in exactly one issue in the scanners' wording", async () => {
      const scanId = await newScan(fixtureFindings());
      const e = env(scanId, new NoAIProvider());
      expect(await aiStep(e)).toMatchObject({
        status: "skipped",
        statusReason: expect.stringMatching(/AI_PROVIDER=none/),
      });
      const outcome = await groundingStep(e);
      expect(outcome).toMatchObject({
        status: "completed",
        statusReason: expect.stringMatching(
          /^5 issues from 7 findings \(5 new, 0 seen in earlier scans\), in the scanners' wording/,
        ),
        checks: { issues: 5, findings: 7, ai: 0, deterministic: 5 },
      });

      const result = (await scanIssuesRepo.listScanIssues(db(), ownerId, scanId))!;
      expect(result.aiRuns).toEqual([]);
      expect(
        result.issues.map((i) => [i.displayNo, i.ruleId, i.severity, i.origin, i.groundingStatus]),
      ).toEqual([
        [1, "color-contrast", "high", "deterministic", "not_applicable"],
        [2, "lcp-slow", "high", "deterministic", "not_applicable"],
        [3, "h1-missing", "medium", "deterministic", "not_applicable"],
        [4, "meta-description-missing", "medium", "deterministic", "not_applicable"],
        [5, "tap-target-small", "medium", "deterministic", "not_applicable"],
      ]);
      const linked = result.issues.flatMap((i) => i.findings.map((x) => x.displayId)).sort();
      expect(linked).toEqual([
        "A11Y-001",
        "A11Y-002",
        "PERF-001",
        "RSP-001",
        "SEO-001",
        "SEO-002",
        "SEO-003",
      ]);
      expect(result.issues.every((i) => i.checks.length === 0)).toBe(true);
      const meta = result.issues.find((i) => i.ruleId === "meta-description-missing")!;
      expect(meta).toMatchObject({
        title: "Meta description is missing (2 pages)",
        affectedUrls: [`${SITE}/about`, `${SITE}/contact`],
        actual: "No meta description",
        verdict: "confirmed",
        trackStatus: "open",
      });
      expect(meta.recommendation).toMatch(/Add <meta name="description"/);
      expect(result.issues.find((i) => i.ruleId === "tap-target-small")).toMatchObject({
        verdict: "potential",
        description: expect.stringMatching(/Needs review/),
      });

      // Project issue counter and track list (Issues page) reflect the new tracks.
      const [p] = await db().select().from(schema.project).where(eq(schema.project.id, projectId));
      expect(p!.issueCounter).toBe(5);
      expect(await scanIssuesRepo.scanIssueSummary(db(), scanId)).toEqual({
        total: 5,
        ai: 0,
        partial: 0,
        rejected: 0,
      });
      // Other users cannot read the scan's issues.
      expect(await scanIssuesRepo.listScanIssues(db(), strangerId, scanId)).toBeNull();
    });

    it("with AI: grounded text is used, fabricated ids/URLs are rejected or replaced, failures fall back", async () => {
      const scanId = await newScan(fixtureFindings());
      const before = await snapshotFindings(scanId);
      const provider = scriptedProvider(({ groupId, ruleId, ids }) => {
        if (ruleId === "color-contrast") return aiText(groupId, ids);
        if (ruleId === "lcp-slow")
          return new AIProviderError("timeout", "The AI request timed out");
        if (ruleId === "h1-missing") return aiText(groupId, ["SEO-999"], { title: "Invented" });
        if (ruleId === "meta-description-missing")
          return aiText(groupId, ids, {
            title: "Two pages have no meta description",
            description:
              "The pages lack a description; see https://seo-tips.example/meta for help.",
            recommendation: "Add a meta description to each listed page.",
            severity: "medium",
            claims: [{ text: "No meta description", findingId: ids[0]!, evidenceField: "actual" }],
          });
        return null; // tap-target-small: omitted by the AI
      });
      const e = env(scanId, provider);
      const ai = await aiStep(e);
      expect(ai).toMatchObject({
        status: "completed",
        toolName: "Scripted test provider",
        toolVersion: "claude-test",
        statusReason: expect.stringMatching(
          /^3 of 4 requests answered; 4 of 5 issues interpreted; 1 request\(s\) without an answer \(The AI request timed out\)/,
        ),
      });
      const grounding = await groundingStep(e);
      expect(grounding.checks).toMatchObject({
        issues: 5,
        ai: 2,
        passed: 1,
        partial: 1,
        rejected: 1,
        deterministic: 3,
        missing: 1,
      });

      const { issues, aiRuns } = (await scanIssuesRepo.listScanIssues(db(), ownerId, scanId))!;
      expect(aiRuns.map((r) => r.status).sort()).toEqual([
        "completed",
        "completed",
        "completed",
        "failed",
      ]);
      expect(aiRuns.find((r) => r.status === "failed")).toMatchObject({
        provider: "anthropic",
        model: "claude-test",
        error: "timeout: The AI request timed out",
        detail: expect.objectContaining({
          category: "performance",
          promptVersion: expect.any(String),
        }),
      });
      const by = Object.fromEntries(issues.map((i) => [i.ruleId ?? "", i] as const));

      // Fully supported AI text.
      expect(by["color-contrast"]).toMatchObject({
        origin: "ai",
        groundingStatus: "passed",
        title: "Text on the products page is hard to read",
        aiRunId: expect.any(String),
      });
      expect(by["color-contrast"]!.checks.every((c) => c.passed)).toBe(true);
      // Fabricated finding id: AI text rejected, the scanner's wording is stored, checks explain why.
      expect(by["h1-missing"]).toMatchObject({
        origin: "deterministic",
        groundingStatus: "rejected",
        title: "Page has no H1 heading",
      });
      expect(by["h1-missing"]!.checks[0]).toMatchObject({
        checkType: "source_findings",
        passed: false,
        detail: { unknown: ["SEO-999"] },
      });
      // Fabricated URL: description replaced, the supported title kept.
      expect(by["meta-description-missing"]).toMatchObject({
        origin: "ai",
        groundingStatus: "partial",
        title: "Two pages have no meta description",
      });
      expect(by["meta-description-missing"]!.description).not.toContain("seo-tips.example");
      expect(
        by["meta-description-missing"]!.checks.find((c) => c.checkType === "field:description"),
      ).toMatchObject({
        passed: false,
        detail: { unsupported: ["https://seo-tips.example/meta"] },
      });
      // Failed request and omitted issue: scanner wording, with the reason recorded.
      expect(by["lcp-slow"]).toMatchObject({
        origin: "deterministic",
        groundingStatus: "not_applicable",
        aiRunId: expect.any(String),
      });
      expect(by["lcp-slow"]!.checks).toEqual([
        {
          checkType: "ai_output",
          passed: false,
          detail: { reason: "The AI request timed out", code: "timeout" },
        },
      ]);
      expect(by["tap-target-small"]!.checks[0]!.detail).toEqual({
        reason: "The AI response did not include this issue",
      });

      // Raw findings and evidence are untouched, and still linked once each.
      expect(await snapshotFindings(scanId)).toBe(before);
      expect(issues.flatMap((i) => i.findings).length).toBe(7);
      // Tracks are shared with the first scan (same fingerprints): no new ISSUE numbers.
      expect(issues.map((i) => i.displayNo).sort()).toEqual([1, 2, 3, 4, 5]);
    });

    it("is idempotent, keeps user statuses and numbers only new problems", async () => {
      const findings = fixtureFindings();
      const scanId = await newScan(findings);
      const e = env(scanId, new NoAIProvider());
      await groundingStep(e);
      await groundingStep(e); // re-run: occurrences replaced, nothing duplicated
      expect((await scanIssuesRepo.listScanIssues(db(), ownerId, scanId))!.issues).toHaveLength(5);

      // A user resolved ISSUE-1; a later scan must not overwrite that (reopen logic is Phase 9).
      await db()
        .update(schema.issueTrack)
        .set({ status: "resolved" })
        .where(eq(schema.issueTrack.displayNo, 1));
      const next = await newScan({
        ...findings,
        seo: [
          ...findings.seo!,
          f({
            ruleId: "title-missing",
            title: "Page has no title",
            locationKey: "/about",
            severity: "high",
          }),
        ],
      });
      const out = await groundingStep(env(next, new NoAIProvider()));
      expect(out.statusReason).toMatch(
        /6 issues from 8 findings \(1 new, 5 seen in earlier scans\)/,
      );
      const tracks = await db()
        .select()
        .from(schema.issueTrack)
        .where(eq(schema.issueTrack.projectId, projectId))
        .orderBy(asc(schema.issueTrack.displayNo));
      expect(tracks.map((t) => [t.displayNo, t.status, t.lastSeenScanId === next])).toEqual([
        [1, "resolved", true],
        [2, "open", true],
        [3, "open", true],
        [4, "open", true],
        [5, "open", true],
        [6, "open", true],
      ]);
      expect(tracks[5]!.title).toBe("Page has no title");
    });

    it("stops after a configuration error and still creates every issue", async () => {
      const scanId = await newScan(fixtureFindings());
      const provider = scriptedProvider(
        () =>
          new AIProviderError(
            "auth",
            "The Anthropic API rejected the credentials (HTTP 401); check ANTHROPIC_API_KEY",
          ),
      );
      const e = env(scanId, provider);
      const ai = await aiStep({ ...e, config: { ...config, AI_CONCURRENCY: 1 } });
      expect(ai).toMatchObject({
        status: "failed",
        error: expect.stringMatching(
          /^AI analysis failed for all 4 requests: The Anthropic API rejected the credentials.*Not sent after an earlier request failed.*All 5 issues use the scanners' wording\.$/,
        ),
      });
      expect(provider.requests).toBe(1);
      expect((await groundingStep(e)).checks).toMatchObject({ issues: 5, deterministic: 5 });
      const { aiRuns } = (await scanIssuesRepo.listScanIssues(db(), ownerId, scanId))!;
      expect(aiRuns).toHaveLength(1); // requests that were never sent are not recorded as runs
    });

    it("creates no issues for a scan without findings", async () => {
      const scanId = await newScan({});
      const e = env(
        scanId,
        scriptedProvider(() => null),
      );
      expect(await aiStep(e)).toMatchObject({
        status: "skipped",
        statusReason: "No findings: nothing to interpret",
      });
      expect(await groundingStep(e)).toMatchObject({
        status: "completed",
        statusReason: "No findings: no issues created",
      });
    });

    it("refuses to store an issue that references another scan's finding", async () => {
      const a = await newScan(fixtureFindings());
      const b = await newScan(fixtureFindings());
      const [foreign] = await db()
        .select()
        .from(schema.rawFinding)
        .where(eq(schema.rawFinding.scanId, a))
        .limit(1);
      await expect(
        scanIssuesRepo.materializeScanIssues(db(), b, [
          {
            fingerprint: "x",
            category: "seo",
            ruleId: "r",
            subcategory: null,
            severity: "low",
            severityRationale: "r",
            title: "t",
            description: "d",
            affectedUrls: [],
            affectedElement: null,
            expected: null,
            actual: null,
            recommendation: "r",
            confidence: 1,
            verdict: "confirmed",
            status: "open",
            origin: "deterministic",
            groundingStatus: "not_applicable",
            aiRunId: null,
            findingIds: [foreign!.id],
            checks: [],
          },
        ]),
      ).rejects.toThrow(/findings of another scan/);
    });
  },
);
