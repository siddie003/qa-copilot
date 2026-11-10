import { resetConfigCache } from "@qa/core";
import {
  closeDb,
  contentRepo,
  getDb,
  pipelineRepo,
  referencesRepo,
  reportsRepo,
  scanIssuesRepo,
  schema,
  secretsRepo,
} from "@qa/db";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildDocx, buildZip } from "../../../../fixtures/documents/build.mjs";
import { hasTestDb, resetDatabase } from "../../../../tests/setup/db";

vi.mock("server-only", () => ({}));

// Phase 10: authorization (IDOR) across every API route, concurrency, rate limits, sign-in
// lockout, hostile uploads and credential values — on the real database.
const APP = "http://localhost:3000";
const { createAuth } = await import("./auth");
(globalThis as { __qaAuth?: unknown }).__qaAuth = hasTestDb
  ? createAuth({ withNextCookies: false })
  : undefined;
const { getAuth } = await import("./auth");

const routes = {
  auth: await import("@/app/api/auth/[...all]/route"),
  projects: await import("@/app/api/v1/projects/route"),
  project: await import("@/app/api/v1/projects/[id]/route"),
  validateUrl: await import("@/app/api/v1/projects/validate-url/route"),
  comparisons: await import("@/app/api/v1/projects/[id]/comparisons/route"),
  projectDocuments: await import("@/app/api/v1/projects/[id]/content-documents/route"),
  designSpec: await import("@/app/api/v1/projects/[id]/design-spec/route"),
  draft: await import("@/app/api/v1/projects/[id]/design-spec/draft/route"),
  draftConfirm: await import("@/app/api/v1/projects/[id]/design-spec/draft/confirm/route"),
  figmaToken: await import("@/app/api/v1/projects/[id]/figma-token/route"),
  guidelines: await import("@/app/api/v1/projects/[id]/guideline-documents/route"),
  history: await import("@/app/api/v1/projects/[id]/history/route"),
  projectIssues: await import("@/app/api/v1/projects/[id]/issues/route"),
  references: await import("@/app/api/v1/projects/[id]/references/route"),
  reference: await import("@/app/api/v1/projects/[id]/references/[refId]/route"),
  referenceRefresh: await import("@/app/api/v1/projects/[id]/references/[refId]/refresh/route"),
  scanAuth: await import("@/app/api/v1/projects/[id]/scan-auth/route"),
  projectScans: await import("@/app/api/v1/projects/[id]/scans/route"),
  scan: await import("@/app/api/v1/scans/[id]/route"),
  scanCancel: await import("@/app/api/v1/scans/[id]/cancel/route"),
  scanCaptures: await import("@/app/api/v1/scans/[id]/captures/route"),
  scanEvents: await import("@/app/api/v1/scans/[id]/events/route"),
  scanFindings: await import("@/app/api/v1/scans/[id]/findings/route"),
  scanIssues: await import("@/app/api/v1/scans/[id]/issues/route"),
  scanReports: await import("@/app/api/v1/scans/[id]/reports/route"),
  report: await import("@/app/api/v1/reports/[id]/route"),
  reportDownload: await import("@/app/api/v1/reports/[id]/download/route"),
  issues: await import("@/app/api/v1/issues/route"),
  issue: await import("@/app/api/v1/issues/[id]/route"),
  issueStatus: await import("@/app/api/v1/issues/[id]/status/route"),
  bulkStatus: await import("@/app/api/v1/issues/status/route"),
  document: await import("@/app/api/v1/content-documents/[id]/route"),
  documentBlocks: await import("@/app/api/v1/content-documents/[id]/blocks/route"),
  documentRetry: await import("@/app/api/v1/content-documents/[id]/retry/route"),
  // Routes added in Phases 13–14.
  documentCancel: await import("@/app/api/v1/content-documents/[id]/cancel/route"),
  contentSearch: await import("@/app/api/v1/projects/[id]/content-search/route"),
  referenceCancel: await import("@/app/api/v1/projects/[id]/references/[refId]/cancel/route"),
  artifacts: await import("@/app/api/v1/artifacts/[...key]/route"),
  dashboard: await import("@/app/api/v1/dashboard/summary/route"),
};

async function signUp(email: string, password = "correct-horse-battery") {
  const res = await getAuth().api.signUpEmail({
    body: { name: email.split("@")[0]!, email, password },
    asResponse: true,
  });
  expect(res.status).toBe(200);
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

const upload = (path: string, cookie: string, file: File, fields: Record<string, string> = {}) => {
  const form = new FormData();
  form.append("file", file);
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return new NextRequest(`${APP}${path}`, {
    method: "POST",
    headers: { cookie, origin: APP },
    body: form,
  });
};

const p = <T extends Record<string, string | string[]>>(params: T) => ({
  params: Promise.resolve(params),
});

describe.skipIf(!hasTestDb)("API security (Phase 10, real database)", () => {
  let alice: string;
  let bob: string;
  let aliceId: string;
  let projectId: string;
  let bobProjectId: string;
  let scanId: string;
  let trackId: string;
  let reportId: string;
  let documentId: string;
  let referenceId: string;

  beforeAll(async () => {
    await resetDatabase();
    alice = await signUp("alice-security@example.test");
    bob = await signUp("bob-security@example.test");
    aliceId = (
      await getDb()
        .select()
        .from(schema.user)
        .where(eq(schema.user.email, "alice-security@example.test"))
    )[0]!.id;
    const create = async (cookie: string, name: string) =>
      (
        await (
          await routes.projects.POST(
            req("/api/v1/projects", cookie, "POST", { name, websiteUrl: "example.com" }),
            {},
          )
        ).json()
      ).id as string;
    projectId = await create(alice, "Alice site");
    bobProjectId = await create(bob, "Bob site");

    // A finished scan with findings, an issue and a pending report.
    scanId = (
      await (
        await routes.projectScans.POST(
          req(`/api/v1/projects/${projectId}/scans`, alice, "POST", {
            authorizationAttested: true,
          }),
          p({ id: projectId }),
        )
      ).json()
    ).id;
    await pipelineRepo.insertFindings(getDb(), scanId, "seo", "SEO", [
      {
        ruleId: "title-missing",
        title: "Title missing",
        message: "No title",
        category: "seo",
        subcategory: null,
        pageId: null,
        locationKey: "site",
        selector: null,
        viewport: null,
        severity: "medium",
        verdict: "confirmed",
        confidence: 0.9,
        expected: null,
        actual: null,
        fingerprintKey: null,
        evidence: [{ kind: "document", data: { observed: "x" } }],
      },
    ]);
    const [finding] = await getDb()
      .select()
      .from(schema.rawFinding)
      .where(eq(schema.rawFinding.scanId, scanId));
    await scanIssuesRepo.materializeScanIssues(getDb(), scanId, [
      {
        fingerprint: "title-missing",
        category: "seo",
        ruleId: "title-missing",
        subcategory: null,
        severity: "medium",
        severityRationale: "rule",
        title: "Title missing",
        description: "d",
        affectedUrls: ["https://example.com/"],
        affectedElement: null,
        expected: null,
        actual: null,
        recommendation: "Fix",
        confidence: 0.9,
        verdict: "confirmed",
        status: "open",
        origin: "deterministic",
        groundingStatus: "not_applicable",
        aiRunId: null,
        findingIds: [finding!.id],
        checks: [],
      },
    ]);
    await getDb()
      .update(schema.scan)
      .set({ status: "completed", startedAt: new Date(), finishedAt: new Date() })
      .where(eq(schema.scan.id, scanId));
    trackId = (await getDb().select().from(schema.issueTrack))[0]!.id;
    const created = await reportsRepo.createReport(getDb(), aliceId, scanId, "json", aliceId);
    reportId = (created as { report: { id: string } }).report.id;
    documentId = (
      await contentRepo.insertDocument(getDb(), projectId, {
        filename: "copy.md",
        mimeType: "text/markdown; charset=utf-8",
        sizeBytes: 3,
        sha256: "0".repeat(64),
        storageKey: `projects/${projectId}/documents/00000000-0000-4000-8000-000000000000.md`,
        targetPath: null,
      })
    ).id;
    referenceId = (
      await referencesRepo.addFigmaReference(getDb(), projectId, {
        figmaUrl: "https://www.figma.com/design/AbCdEfGh1234/x",
        figmaFileKey: "AbCdEfGh1234",
        figmaNodeIds: [],
      })
    ).id;
    await routes.scanAuth.PUT(
      req(`/api/v1/projects/${projectId}/scan-auth`, alice, "PUT", {
        type: "basic",
        username: "qa",
        password: "secret-pw",
      }),
      p({ id: projectId }),
    );
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetConfigCache();
  });
  afterAll(() => closeDb());

  it("refuses every route on another user's resources with 404 and changes nothing (IDOR)", async () => {
    const id = { id: projectId };
    const md = new File(["# Hello"], "copy.md", { type: "text/markdown" });
    const calls: Array<[string, () => Promise<Response>]> = [
      ["GET project", () => routes.project.GET(req(`/api/v1/projects/${projectId}`, bob), p(id))],
      [
        "PATCH project",
        () =>
          routes.project.PATCH(
            req(`/api/v1/projects/${projectId}`, bob, "PATCH", { name: "pwned" }),
            p(id),
          ),
      ],
      [
        "DELETE project",
        () => routes.project.DELETE(req(`/api/v1/projects/${projectId}`, bob, "DELETE"), p(id)),
      ],
      [
        "GET comparisons",
        () => routes.comparisons.GET(req(`/api/v1/projects/${projectId}/comparisons`, bob), p(id)),
      ],
      [
        "GET content documents",
        () =>
          routes.projectDocuments.GET(
            req(`/api/v1/projects/${projectId}/content-documents`, bob),
            p(id),
          ),
      ],
      [
        "POST content document",
        () =>
          routes.projectDocuments.POST(
            upload(`/api/v1/projects/${projectId}/content-documents`, bob, md),
            p(id),
          ),
      ],
      [
        "GET design spec",
        () => routes.designSpec.GET(req(`/api/v1/projects/${projectId}/design-spec`, bob), p(id)),
      ],
      [
        "PUT design spec",
        () =>
          routes.designSpec.PUT(
            req(`/api/v1/projects/${projectId}/design-spec`, bob, "PUT", {}),
            p(id),
          ),
      ],
      [
        "DELETE draft",
        () =>
          routes.draft.DELETE(
            req(`/api/v1/projects/${projectId}/design-spec/draft`, bob, "DELETE"),
            p(id),
          ),
      ],
      [
        "POST confirm draft",
        () =>
          routes.draftConfirm.POST(
            req(`/api/v1/projects/${projectId}/design-spec/draft/confirm`, bob, "POST", {
              version: 1,
            }),
            p(id),
          ),
      ],
      [
        "PUT figma token",
        () =>
          routes.figmaToken.PUT(
            req(`/api/v1/projects/${projectId}/figma-token`, bob, "PUT", {
              token: "figd_attacker_token_1234",
            }),
            p(id),
          ),
      ],
      [
        "DELETE figma token",
        () =>
          routes.figmaToken.DELETE(
            req(`/api/v1/projects/${projectId}/figma-token`, bob, "DELETE"),
            p(id),
          ),
      ],
      [
        "POST guideline",
        () =>
          routes.guidelines.POST(
            upload(`/api/v1/projects/${projectId}/guideline-documents`, bob, md),
            p(id),
          ),
      ],
      [
        "GET history",
        () => routes.history.GET(req(`/api/v1/projects/${projectId}/history`, bob), p(id)),
      ],
      [
        "GET project issues",
        () => routes.projectIssues.GET(req(`/api/v1/projects/${projectId}/issues`, bob), p(id)),
      ],
      [
        "GET references",
        () => routes.references.GET(req(`/api/v1/projects/${projectId}/references`, bob), p(id)),
      ],
      [
        "POST reference",
        () =>
          routes.references.POST(
            req(`/api/v1/projects/${projectId}/references`, bob, "POST", {
              figmaUrl: "https://www.figma.com/design/AbCdEfGh1234/x",
            }),
            p(id),
          ),
      ],
      [
        "DELETE reference",
        () =>
          routes.reference.DELETE(
            req(`/api/v1/projects/${projectId}/references/${referenceId}`, bob, "DELETE"),
            p({ id: projectId, refId: referenceId }),
          ),
      ],
      [
        "DELETE reference via own project",
        () =>
          routes.reference.DELETE(
            req(`/api/v1/projects/${bobProjectId}/references/${referenceId}`, bob, "DELETE"),
            p({ id: bobProjectId, refId: referenceId }),
          ),
      ],
      [
        "POST refresh reference via own project",
        () =>
          routes.referenceRefresh.POST(
            req(`/api/v1/projects/${bobProjectId}/references/${referenceId}/refresh`, bob, "POST"),
            p({ id: bobProjectId, refId: referenceId }),
          ),
      ],
      [
        "POST cancel reference",
        () =>
          routes.referenceCancel.POST(
            req(`/api/v1/projects/${projectId}/references/${referenceId}/cancel`, bob, "POST"),
            p({ id: projectId, refId: referenceId }),
          ),
      ],
      [
        "POST cancel reference via own project",
        () =>
          routes.referenceCancel.POST(
            req(`/api/v1/projects/${bobProjectId}/references/${referenceId}/cancel`, bob, "POST"),
            p({ id: bobProjectId, refId: referenceId }),
          ),
      ],
      [
        "GET content search",
        () =>
          routes.contentSearch.GET(
            req(`/api/v1/projects/${projectId}/content-search?q=hello`, bob),
            p(id),
          ),
      ],
      [
        "GET scan auth",
        () => routes.scanAuth.GET(req(`/api/v1/projects/${projectId}/scan-auth`, bob), p(id)),
      ],
      [
        "PUT scan auth",
        () =>
          routes.scanAuth.PUT(
            req(`/api/v1/projects/${projectId}/scan-auth`, bob, "PUT", {
              type: "header",
              name: "X-Api-Key",
              value: "attacker",
            }),
            p(id),
          ),
      ],
      [
        "DELETE scan auth",
        () =>
          routes.scanAuth.DELETE(
            req(`/api/v1/projects/${projectId}/scan-auth`, bob, "DELETE"),
            p(id),
          ),
      ],
      [
        "GET project scans",
        () => routes.projectScans.GET(req(`/api/v1/projects/${projectId}/scans`, bob), p(id)),
      ],
      [
        "POST start scan",
        () =>
          routes.projectScans.POST(
            req(`/api/v1/projects/${projectId}/scans`, bob, "POST", {
              authorizationAttested: true,
            }),
            p(id),
          ),
      ],
      ["GET scan", () => routes.scan.GET(req(`/api/v1/scans/${scanId}`, bob), p({ id: scanId }))],
      [
        "POST cancel scan",
        () =>
          routes.scanCancel.POST(
            req(`/api/v1/scans/${scanId}/cancel`, bob, "POST"),
            p({ id: scanId }),
          ),
      ],
      [
        "GET captures",
        () =>
          routes.scanCaptures.GET(req(`/api/v1/scans/${scanId}/captures`, bob), p({ id: scanId })),
      ],
      [
        "GET events (SSE)",
        () => routes.scanEvents.GET(req(`/api/v1/scans/${scanId}/events`, bob), p({ id: scanId })),
      ],
      [
        "GET findings",
        () =>
          routes.scanFindings.GET(req(`/api/v1/scans/${scanId}/findings`, bob), p({ id: scanId })),
      ],
      [
        "GET scan issues",
        () => routes.scanIssues.GET(req(`/api/v1/scans/${scanId}/issues`, bob), p({ id: scanId })),
      ],
      [
        "GET scan reports",
        () =>
          routes.scanReports.GET(req(`/api/v1/scans/${scanId}/reports`, bob), p({ id: scanId })),
      ],
      [
        "POST report",
        () =>
          routes.scanReports.POST(
            req(`/api/v1/scans/${scanId}/reports`, bob, "POST", { format: "md" }),
            p({ id: scanId }),
          ),
      ],
      [
        "GET report",
        () => routes.report.GET(req(`/api/v1/reports/${reportId}`, bob), p({ id: reportId })),
      ],
      [
        "DELETE report",
        () =>
          routes.report.DELETE(
            req(`/api/v1/reports/${reportId}`, bob, "DELETE"),
            p({ id: reportId }),
          ),
      ],
      [
        "GET report download",
        () =>
          routes.reportDownload.GET(
            req(`/api/v1/reports/${reportId}/download`, bob),
            p({ id: reportId }),
          ),
      ],
      [
        "GET issue",
        () => routes.issue.GET(req(`/api/v1/issues/${trackId}`, bob), p({ id: trackId })),
      ],
      [
        "PATCH issue status",
        () =>
          routes.issueStatus.PATCH(
            req(`/api/v1/issues/${trackId}/status`, bob, "PATCH", { status: "ignored" }),
            p({ id: trackId }),
          ),
      ],
      [
        "POST bulk status",
        () =>
          routes.bulkStatus.POST(
            req("/api/v1/issues/status", bob, "POST", { ids: [trackId], status: "resolved" }),
            {},
          ),
      ],
      [
        "PATCH document",
        () =>
          routes.document.PATCH(
            req(`/api/v1/content-documents/${documentId}`, bob, "PATCH", { targetPath: "/x" }),
            p({ id: documentId }),
          ),
      ],
      [
        "DELETE document",
        () =>
          routes.document.DELETE(
            req(`/api/v1/content-documents/${documentId}`, bob, "DELETE"),
            p({ id: documentId }),
          ),
      ],
      [
        "GET document blocks",
        () =>
          routes.documentBlocks.GET(
            req(`/api/v1/content-documents/${documentId}/blocks`, bob),
            p({ id: documentId }),
          ),
      ],
      [
        "POST document retry",
        () =>
          routes.documentRetry.POST(
            req(`/api/v1/content-documents/${documentId}/retry`, bob, "POST"),
            p({ id: documentId }),
          ),
      ],
      [
        "POST document cancel",
        () =>
          routes.documentCancel.POST(
            req(`/api/v1/content-documents/${documentId}/cancel`, bob, "POST"),
            p({ id: documentId }),
          ),
      ],
      [
        "GET artifact",
        () =>
          routes.artifacts.GET(
            req(`/api/v1/artifacts/scans/${scanId}/pages/x/desktop.png`, bob),
            p({ key: ["scans", scanId, "pages", "x", "desktop.png"] }),
          ),
      ],
    ];
    for (const [name, call] of calls) {
      const res = await call();
      expect.soft(res.status, name).toBe(404);
      expect.soft(res.headers.get("content-type") ?? "", name).toContain("problem+json");
    }

    // Lists only ever show the caller's own data.
    const issues = await (await routes.issues.GET(req("/api/v1/issues", bob), {})).json();
    expect(issues.items).toEqual([]);
    const filtered = await (
      await routes.issues.GET(req(`/api/v1/issues?projectId=${projectId}`, bob), {})
    ).json();
    expect(filtered.items).toEqual([]);
    // Someone else's scans cannot be compared inside one's own project.
    const foreignPair = await routes.comparisons.GET(
      req(
        `/api/v1/projects/${bobProjectId}/comparisons?base=${scanId}&target=00000000-0000-4000-8000-000000000001`,
        bob,
      ),
      p({ id: bobProjectId }),
    );
    expect(foreignPair.status).toBe(404);
    const projects = await (await routes.projects.GET(req("/api/v1/projects", bob), {})).json();
    expect(projects.items.map((x: { id: string }) => x.id)).toEqual([bobProjectId]);
    const dashboard = await (
      await routes.dashboard.GET(req("/api/v1/dashboard/summary", bob), {})
    ).json();
    expect(JSON.stringify(dashboard)).not.toContain(projectId);

    // Nothing of Alice's changed.
    const [project] = await getDb()
      .select()
      .from(schema.project)
      .where(eq(schema.project.id, projectId));
    expect(project).toMatchObject({ name: "Alice site", deletedAt: null });
    const [scan] = await getDb().select().from(schema.scan).where(eq(schema.scan.id, scanId));
    expect(scan).toMatchObject({ status: "completed", cancelRequestedAt: null });
    const [track] = await getDb()
      .select()
      .from(schema.issueTrack)
      .where(eq(schema.issueTrack.id, trackId));
    expect(track!.status).toBe("open");
    expect(
      await getDb()
        .select()
        .from(schema.issueStatusEvent)
        .where(eq(schema.issueStatusEvent.userId, aliceId)),
    ).toEqual([]);
    expect(
      await getDb().select().from(schema.report).where(eq(schema.report.id, reportId)),
    ).toHaveLength(1);
    const docs = await getDb()
      .select()
      .from(schema.contentDocument)
      .where(eq(schema.contentDocument.projectId, projectId));
    expect(docs.map((d) => [d.id, d.targetPath, d.cancelRequestedAt])).toEqual([
      [documentId, null, null],
    ]);
    const refs = await getDb()
      .select()
      .from(schema.referenceSource)
      .where(eq(schema.referenceSource.id, referenceId));
    expect(refs).toHaveLength(1);
    expect(refs[0]!.cancelRequestedAt).toBeNull();
    expect(
      await getDb()
        .select()
        .from(schema.referenceSource)
        .where(eq(schema.referenceSource.projectId, projectId)),
    ).toHaveLength(1);
    const secret = await secretsRepo.getProjectSecret(
      getDb(),
      projectId,
      secretsRepo.SCAN_AUTH_KIND,
    );
    expect(secret?.summary).toMatchObject({ type: "basic", username: "qa" });
    expect(
      await secretsRepo.getProjectSecret(getDb(), projectId, secretsRepo.FIGMA_TOKEN_KIND),
    ).toBeNull();
  });

  it("starts at most one scan for concurrent Start QA Scan requests", async () => {
    const start = () =>
      routes.projectScans.POST(
        req(`/api/v1/projects/${bobProjectId}/scans`, bob, "POST", { authorizationAttested: true }),
        p({ id: bobProjectId }),
      );
    const statuses = (await Promise.all([start(), start(), start()])).map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409]);
    await getDb()
      .update(schema.scan)
      .set({ status: "cancelled" })
      .where(eq(schema.scan.projectId, bobProjectId));
  });

  it("limits expensive operations per user with 429 and Retry-After", async () => {
    vi.stubEnv("RATE_LIMIT_ENABLED", "true");
    resetConfigCache();
    const carol = await signUp("carol-ratelimit@example.test");
    const create = (cookie: string, i: number) =>
      routes.projects.POST(
        req("/api/v1/projects", cookie, "POST", { name: `P${i}`, websiteUrl: "example.com" }),
        {},
      );
    for (let i = 0; i < 30; i++) expect((await create(carol, i)).status).toBe(201);
    const refused = await create(carol, 31);
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await refused.json()).toMatchObject({ code: "RATE_LIMITED" });
    // Limits are per user; reads are not affected by the project bucket.
    expect((await create(bob, 99)).status).toBe(201);
    expect((await routes.projects.GET(req("/api/v1/projects", carol), {})).status).toBe(200);
  });

  it("locks an account after repeated wrong passwords, whatever IP the requests claim", async () => {
    const email = "victim-lockout@example.test";
    await signUp(email, "the-real-password-123");
    // Through the real HTTP handler (what the login form calls), with a different forged
    // client IP on every attempt.
    const attempt = (password: string, ip: string) =>
      routes.auth.POST(
        new NextRequest(`${APP}/api/auth/sign-in/email`, {
          method: "POST",
          headers: { origin: APP, "content-type": "application/json", "x-forwarded-for": ip },
          body: JSON.stringify({ email, password }),
        }),
      );
    for (let i = 0; i < 10; i++)
      expect((await attempt(`wrong-password-${i}`, `203.0.113.${i + 1}`)).status).toBe(401);
    // Even the right password is refused while the account is locked.
    const locked = await attempt("the-real-password-123", "198.51.100.7");
    expect(locked.status).toBe(429);
    expect(JSON.stringify(await locked.json())).toMatch(/Too many failed sign-in attempts/);
    // Other accounts are unaffected.
    expect(
      (
        await getAuth().api.signInEmail({
          body: { email: "alice-security@example.test", password: "correct-horse-battery" },
          asResponse: true,
        })
      ).status,
    ).toBe(200);
  });

  it("rejects a Word file whose entries expand beyond their declared size, storing nothing", async () => {
    const lying = buildZip(
      {
        "[Content_Types].xml": "<Types/>",
        "word/document.xml": Buffer.alloc(32 * 1024 * 1024, 0x20),
      },
      { declaredSizes: { "word/document.xml": 2048 } },
    );
    const before = await contentRepo.countDocuments(getDb(), projectId);
    const res = await routes.projectDocuments.POST(
      upload(
        `/api/v1/projects/${projectId}/content-documents`,
        alice,
        new File([new Uint8Array(lying)], "bomb.docx", { type: "application/octet-stream" }),
      ),
      p({ id: projectId }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).detail).toMatch(/expands beyond its declared size/);
    expect(await contentRepo.countDocuments(getDb(), projectId)).toBe(before);
    // A real Word document is still accepted.
    const ok = await routes.projectDocuments.POST(
      upload(
        `/api/v1/projects/${projectId}/content-documents`,
        alice,
        new File([new Uint8Array(buildDocx([{ p: "Hello" }]))], "real.docx"),
      ),
      p({ id: projectId }),
    );
    expect(ok.status).toBe(201);
    const doc = await ok.json();
    await routes.document.DELETE(
      req(`/api/v1/content-documents/${doc.id}`, alice, "DELETE"),
      p({ id: doc.id }),
    );
  });

  it("refuses site credentials that would inject HTTP headers", async () => {
    const res = await routes.scanAuth.PUT(
      req(`/api/v1/projects/${projectId}/scan-auth`, alice, "PUT", {
        type: "header",
        name: "X-Api-Key",
        value: `key${String.fromCharCode(13, 10)}X-Admin: true`,
      }),
      p({ id: projectId }),
    );
    expect(res.status).toBe(400);
    const secret = await secretsRepo.getProjectSecret(
      getDb(),
      projectId,
      secretsRepo.SCAN_AUTH_KIND,
    );
    expect(secret?.summary).toMatchObject({ type: "basic" }); // unchanged
  });
});
