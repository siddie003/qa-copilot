import { closeDb, getDb, issuesRepo, pipelineRepo, scanIssuesRepo, schema } from "@qa/db";
import { asc, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hasTestDb, resetDatabase } from "../../../../tests/setup/db";

vi.mock("server-only", () => ({}));

const APP = "http://localhost:3000";
const { createAuth } = await import("./auth");
(globalThis as { __qaAuth?: unknown }).__qaAuth = hasTestDb
  ? createAuth({ withNextCookies: false })
  : undefined;
const { getAuth } = await import("./auth");
const projectsRoute = await import("@/app/api/v1/projects/route");
const scansRoute = await import("@/app/api/v1/projects/[id]/scans/route");
const issuesRoute = await import("@/app/api/v1/scans/[id]/issues/route");

async function signUp(email: string) {
  const res = await getAuth().api.signUpEmail({
    body: { name: "Tester", email, password: "correct-horse-battery" },
    asResponse: true,
  });
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}
const req = (path: string, cookie: string, method = "GET", body?: unknown) =>
  new NextRequest(`${APP}${path}`, {
    method,
    headers: {
      cookie,
      origin: APP,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
const p = (id: string) => ({ params: Promise.resolve({ id }) });

const finding = (ruleId: string, title: string) => ({
  ruleId,
  title,
  message: `${title} (test)`,
  category: "seo",
  subcategory: null,
  pageId: null,
  locationKey: "site",
  selector: null,
  viewport: null,
  severity: "medium" as const,
  verdict: "confirmed" as const,
  confidence: 0.9,
  expected: null,
  actual: null,
  fingerprintKey: null,
  evidence: [{ kind: "document", data: { observed: ruleId } }],
});

const issue = (fingerprint: string, findingId: string, over: Record<string, unknown> = {}) => ({
  fingerprint,
  category: "seo",
  ruleId: "title-missing",
  subcategory: null,
  severity: "medium" as const,
  severityRationale: "Severity assigned by the scanner rule (medium).",
  title: "Page has no title",
  description: "The page has no <title>.",
  affectedUrls: ["https://example.com/"],
  affectedElement: null,
  expected: null,
  actual: null,
  recommendation: "Add a unique, descriptive <title> element to the page's <head>.",
  confidence: 0.9,
  verdict: "confirmed" as const,
  status: "open" as const,
  origin: "deterministic" as const,
  groundingStatus: "not_applicable" as const,
  aiRunId: null,
  findingIds: [findingId],
  checks: [],
  ...over,
});

describe.skipIf(!hasTestDb)("scan issues API (real database)", () => {
  let alice: string;
  let bob: string;
  let scanId: string;

  beforeAll(async () => {
    await resetDatabase();
    alice = await signUp("alice-issues@example.test");
    bob = await signUp("bob-issues@example.test");
    const project = await (
      await projectsRoute.POST(
        req("/api/v1/projects", alice, "POST", { name: "I", websiteUrl: "example.com" }),
        {},
      )
    ).json();
    scanId = (
      await (
        await scansRoute.POST(
          req(`/api/v1/projects/${project.id}/scans`, alice, "POST", {
            authorizationAttested: true,
          }),
          p(project.id),
        )
      ).json()
    ).id;
    await pipelineRepo.insertFindings(getDb(), scanId, "seo", "SEO", [
      finding("title-missing", "Page has no title"),
      finding("h1-missing", "Page has no H1 heading"),
    ]);
    const ids = (
      await getDb()
        .select()
        .from(schema.rawFinding)
        .where(eq(schema.rawFinding.scanId, scanId))
        .orderBy(asc(schema.rawFinding.displayId))
    ).map((r) => r.id);
    const runId = await scanIssuesRepo.insertAiRun(getDb(), scanId, {
      provider: "anthropic",
      model: "claude-opus-5-5",
      status: "completed",
      inputTokens: 1000,
      outputTokens: 200,
      latencyMs: 1200,
      error: null,
      detail: { category: "seo", groupIds: ["G1", "G2"] },
    });
    await scanIssuesRepo.materializeScanIssues(getDb(), scanId, [
      issue("fp-title", ids[0]!, {
        origin: "ai",
        groundingStatus: "passed",
        title: "Home page is missing a title",
        aiRunId: runId,
        checks: [
          { checkType: "source_findings", passed: true, detail: { cited: ["SEO-001"] } },
          { checkType: "field:title", passed: true, detail: { checkedFacts: 0 } },
        ],
      }),
      issue("fp-h1", ids[1]!, {
        ruleId: "h1-missing",
        title: "Page has no H1 heading",
        groundingStatus: "rejected",
        aiRunId: runId,
        checks: [{ checkType: "source_findings", passed: false, detail: { unknown: ["SEO-999"] } }],
      }),
    ]);
  });
  afterAll(() => closeDb());

  it("plans the AI and evidence validation steps for new scans", async () => {
    const steps = await getDb()
      .select()
      .from(schema.scannerRun)
      .where(eq(schema.scannerRun.scanId, scanId))
      .orderBy(asc(schema.scannerRun.position));
    // Reports are generated on demand, not as a scan step (Phase 8).
    expect(steps.map((s) => [s.stepKey, s.status]).slice(-2)).toEqual([
      ["ai", "pending"],
      ["grounding", "pending"],
    ]);
    expect(steps.some((s) => s.stepKey === "report")).toBe(false);
  });

  it("returns issues with their findings, grounding checks and AI requests", async () => {
    const res = await issuesRoute.GET(req(`/api/v1/scans/${scanId}/issues`, alice), p(scanId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(2);
    expect(body.aiRuns).toEqual([
      expect.objectContaining({
        provider: "anthropic",
        model: "claude-opus-5-5",
        status: "completed",
      }),
    ]);
    const passed = body.items.find(
      (i: { groundingStatus: string }) => i.groundingStatus === "passed",
    );
    expect(passed).toMatchObject({
      displayNo: 1,
      origin: "ai",
      title: "Home page is missing a title",
      findings: [expect.objectContaining({ displayId: "SEO-001" })],
      checks: [
        { checkType: "source_findings", passed: true, detail: { cited: ["SEO-001"] } },
        { checkType: "field:title", passed: true, detail: { checkedFacts: 0 } },
      ],
    });
    // Prompts and responses are never part of the stored or returned data.
    expect(JSON.stringify(body)).not.toMatch(/prompt"|"system"|"response"/i);
  });

  it("filters by grounding outcome", async () => {
    const body = await (
      await issuesRoute.GET(
        req(`/api/v1/scans/${scanId}/issues?grounding=rejected`, alice),
        p(scanId),
      )
    ).json();
    expect(body.items.map((i: { ruleId: string }) => i.ruleId)).toEqual(["h1-missing"]);
  });

  it("hides issues from other users and rejects malformed ids", async () => {
    expect(
      (await issuesRoute.GET(req(`/api/v1/scans/${scanId}/issues`, bob), p(scanId))).status,
    ).toBe(404);
    expect((await issuesRoute.GET(req("/api/v1/scans/x/issues", alice), p("x"))).status).toBe(404);
  });

  it("lists tracked issues with the scan of their latest occurrence", async () => {
    const owner = (
      await getDb()
        .select()
        .from(schema.user)
        .where(eq(schema.user.email, "alice-issues@example.test"))
    )[0]!;
    const { items, total } = await issuesRepo.listIssues(getDb(), owner.id, {
      page: 1,
      pageSize: 10,
    });
    expect(total).toBe(2);
    expect(items.every((i) => i.lastSeenScanId === scanId)).toBe(true);
  });
});
