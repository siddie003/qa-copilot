import { closeDb, getDb, pipelineRepo, scanIssuesRepo, schema } from "@qa/db";
import { and, asc, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hasTestDb, resetDatabase } from "../../../../tests/setup/db";

vi.mock("server-only", () => ({}));

// Phase 8: issue explorer API, issue detail, audited status workflow (single and bulk).
const APP = "http://localhost:3000";
const { createAuth } = await import("./auth");
(globalThis as { __qaAuth?: unknown }).__qaAuth = hasTestDb
  ? createAuth({ withNextCookies: false })
  : undefined;
const { getAuth } = await import("./auth");
const projectsRoute = await import("@/app/api/v1/projects/route");
const scansRoute = await import("@/app/api/v1/projects/[id]/scans/route");
const issuesRoute = await import("@/app/api/v1/issues/route");
const projectIssuesRoute = await import("@/app/api/v1/projects/[id]/issues/route");
const issueRoute = await import("@/app/api/v1/issues/[id]/route");
const statusRoute = await import("@/app/api/v1/issues/[id]/status/route");
const bulkRoute = await import("@/app/api/v1/issues/status/route");

async function signUp(email: string) {
  const res = await getAuth().api.signUpEmail({
    body: { name: email.split("@")[0]!, email, password: "correct-horse-battery" },
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

const finding = (ruleId: string, pageId: string | null, over: Record<string, unknown> = {}) => ({
  ruleId,
  title: `Finding ${ruleId}`,
  message: `${ruleId} (test)`,
  category: "seo",
  subcategory: null,
  pageId,
  locationKey: pageId ?? "site",
  selector: null,
  viewport: null,
  severity: "medium" as const,
  verdict: "confirmed" as const,
  confidence: 0.9,
  expected: null,
  actual: null,
  fingerprintKey: null,
  evidence: [{ kind: "document", data: { observed: ruleId } }],
  ...over,
});

const issue = (fingerprint: string, findingIds: string[], over: Record<string, unknown> = {}) => ({
  fingerprint,
  category: "seo",
  ruleId: fingerprint,
  subcategory: null,
  severity: "medium" as const,
  severityRationale: "Severity assigned by the scanner rule (medium).",
  title: `Issue ${fingerprint}`,
  description: `Description of ${fingerprint}.`,
  affectedUrls: ["https://example.com/"],
  affectedElement: null,
  expected: null,
  actual: null,
  recommendation: "Fix it.",
  confidence: 0.9,
  verdict: "confirmed" as const,
  status: "open" as const,
  origin: "deterministic" as const,
  groundingStatus: "not_applicable" as const,
  aiRunId: null,
  findingIds,
  checks: [],
  ...over,
});

async function finishScan(scanId: string) {
  await getDb()
    .update(schema.scan)
    .set({ status: "completed", startedAt: new Date(), finishedAt: new Date() })
    .where(eq(schema.scan.id, scanId));
}

async function startScan(cookie: string, projectId: string) {
  const res = await scansRoute.POST(
    req(`/api/v1/projects/${projectId}/scans`, cookie, "POST", { authorizationAttested: true }),
    p(projectId),
  );
  return (await res.json()).id as string;
}

async function findingIds(scanId: string) {
  return (
    await getDb()
      .select()
      .from(schema.rawFinding)
      .where(eq(schema.rawFinding.scanId, scanId))
      .orderBy(asc(schema.rawFinding.displayId))
  ).map((r) => r.id);
}

async function eventsOf(trackId: string) {
  return getDb()
    .select()
    .from(schema.issueStatusEvent)
    .where(eq(schema.issueStatusEvent.trackId, trackId))
    .orderBy(asc(schema.issueStatusEvent.createdAt));
}

describe.skipIf(!hasTestDb)("issue workflow API (real database)", () => {
  let alice: string;
  let bob: string;
  let projectId: string;
  let scan1: string;
  let scan2: string;
  const track: Record<string, string> = {};

  beforeAll(async () => {
    await resetDatabase();
    alice = await signUp("alice-workflow@example.test");
    bob = await signUp("bob-workflow@example.test");
    projectId = (
      await (
        await projectsRoute.POST(
          req("/api/v1/projects", alice, "POST", { name: "W", websiteUrl: "example.com" }),
          {},
        )
      ).json()
    ).id;

    // Scan 1: three issues (one inconclusive, one on /pricing with low confidence).
    scan1 = await startScan(alice, projectId);
    await pipelineRepo.insertFindings(getDb(), scan1, "seo", "SEO", [
      finding("title-missing", null),
      finding("h1-missing", null),
      finding("sitemap", null, { verdict: "inconclusive", confidence: 0.4 }),
    ]);
    let ids = await findingIds(scan1);
    await scanIssuesRepo.materializeScanIssues(getDb(), scan1, [
      issue("title-missing", [ids[0]!], { severity: "high" }),
      issue("h1-missing", [ids[1]!], {
        affectedUrls: ["https://example.com/pricing"],
        confidence: 0.6,
      }),
      issue("sitemap", [ids[2]!], {
        verdict: "inconclusive",
        status: "inconclusive",
        confidence: 0.4,
        severity: "low",
      }),
    ]);
    await finishScan(scan1);
    for (const t of await getDb().select().from(schema.issueTrack)) track[t.fingerprint] = t.id;

    // Scan 2: title-missing again; the inconclusive sitemap issue is now confirmed.
    scan2 = await startScan(alice, projectId);
    await pipelineRepo.insertFindings(getDb(), scan2, "seo", "SEO", [
      finding("title-missing", null),
      finding("sitemap", null),
    ]);
    ids = await findingIds(scan2);
    await scanIssuesRepo.materializeScanIssues(getDb(), scan2, [
      issue("title-missing", [ids[0]!], { severity: "high", title: "Title missing (scan 2)" }),
      issue("sitemap", [ids[1]!], { status: "open", severity: "low" }),
    ]);
    await finishScan(scan2);
  });
  afterAll(() => closeDb());

  it("records a system event when a scan first detects an issue", async () => {
    const events = await eventsOf(track["h1-missing"]!);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      fromStatus: null,
      toStatus: "open",
      userId: null,
      scanId: scan1,
      note: scanIssuesRepo.SYSTEM_EVENT_NOTES.detected,
    });
  });

  it("records evidence-based status changes made by a later scan", async () => {
    const events = await eventsOf(track.sitemap!);
    expect(events.map((e) => [e.fromStatus, e.toStatus, e.scanId, e.userId])).toEqual([
      [null, "inconclusive", scan1, null],
      ["inconclusive", "open", scan2, null],
    ]);
    // Re-materializing the same scan is idempotent: no duplicate events.
    const ids = await findingIds(scan2);
    await scanIssuesRepo.materializeScanIssues(getDb(), scan2, [
      issue("title-missing", [ids[0]!], { severity: "high", title: "Title missing (scan 2)" }),
      issue("sitemap", [ids[1]!], { status: "open", severity: "low" }),
    ]);
    expect(await eventsOf(track.sitemap!)).toHaveLength(2);
  });

  it("lists issues with the latest occurrence's verdict, confidence, pages and scan", async () => {
    const res = await issuesRoute.GET(req("/api/v1/issues", alice), {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(3);
    const title = body.items.find((i: { id: string }) => i.id === track["title-missing"]);
    expect(title).toMatchObject({
      title: "Title missing (scan 2)",
      verdict: "confirmed",
      confidence: 0.9,
      pageCount: 1,
      lastSeenScanNumber: 2,
      occurrences: 2,
      status: "open",
    });
    // Severity order first: high, medium, low.
    expect(body.items.map((i: { severity: string }) => i.severity)).toEqual([
      "high",
      "medium",
      "low",
    ]);
  });

  it("filters by verdict, URL, confidence, severity, status, search and date", async () => {
    const list = async (qs: string) =>
      (await (await issuesRoute.GET(req(`/api/v1/issues?${qs}`, alice), {})).json()) as {
        items: Array<{ id: string }>;
        total: number;
      };
    expect((await list("url=/pricing")).items.map((i) => i.id)).toEqual([track["h1-missing"]]);
    expect((await list("minConfidence=70")).total).toBe(2);
    expect((await list("minConfidence=50&severity=medium")).items[0]!.id).toBe(track["h1-missing"]);
    expect((await list("verdict=confirmed")).total).toBe(3);
    expect((await list("verdict=unverified")).total).toBe(0);
    expect((await list("status=open&status=in_progress")).total).toBe(3);
    expect((await list("q=sitemap")).items.map((i) => i.id)).toEqual([track.sitemap]);
    expect((await list("since=1d")).total).toBe(3);
    expect((await list("category=security")).total).toBe(0);
    // Invalid values are ignored instead of failing the request.
    expect((await list("severity=bogus&minConfidence=abc&sort=evil")).total).toBe(3);
    expect((await list("projectId=not-a-uuid")).total).toBe(0);
    expect((await list("pageSize=1&page=2")).items).toHaveLength(1);
  });

  it("scopes project issue lists to the owner", async () => {
    const own = await projectIssuesRoute.GET(
      req(`/api/v1/projects/${projectId}/issues?verdict=confirmed`, alice),
      p(projectId),
    );
    expect((await own.json()).total).toBe(3);
    const foreign = await projectIssuesRoute.GET(
      req(`/api/v1/projects/${projectId}/issues`, bob),
      p(projectId),
    );
    expect(foreign.status).toBe(404);
    expect((await (await issuesRoute.GET(req("/api/v1/issues", bob), {})).json()).total).toBe(0);
  });

  it("returns issue detail with occurrences, findings, evidence and history", async () => {
    const res = await issueRoute.GET(
      req(`/api/v1/issues/${track["title-missing"]}`, alice),
      p(track["title-missing"]!),
    );
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.occurrences.map((o: { scanNumber: number }) => o.scanNumber)).toEqual([2, 1]);
    expect(d.occurrence).toMatchObject({ scanId: scan2, title: "Title missing (scan 2)" });
    expect(d.occurrence.findings).toHaveLength(1);
    expect(d.occurrence.findings[0].evidence[0]).toMatchObject({
      kind: "document",
      data: { observed: "title-missing" },
    });
    expect(d.history).toHaveLength(1);

    const older = await (
      await issueRoute.GET(
        req(`/api/v1/issues/${track["title-missing"]}?scanId=${scan1}`, alice),
        p(track["title-missing"]!),
      )
    ).json();
    expect(older.occurrence).toMatchObject({ scanId: scan1, title: "Issue title-missing" });

    expect(
      (
        await issueRoute.GET(
          req(`/api/v1/issues/${track["title-missing"]}`, bob),
          p(track["title-missing"]!),
        )
      ).status,
    ).toBe(404);
    expect((await issueRoute.GET(req("/api/v1/issues/nope", alice), p("nope"))).status).toBe(404);
  });

  it("changes the status with an audited event (user, note, from → to)", async () => {
    const id = track["h1-missing"]!;
    const res = await statusRoute.PATCH(
      req(`/api/v1/issues/${id}/status`, alice, "PATCH", {
        status: "in_progress",
        note: "  Assigned to the web team  ",
      }),
      p(id),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ changed: true, status: "in_progress" });
    expect(body.history[0]).toMatchObject({
      fromStatus: "open",
      toStatus: "in_progress",
      note: "Assigned to the web team",
      userName: "alice-workflow",
    });

    // Resolving sets resolvedAt; reopening clears it.
    await statusRoute.PATCH(
      req(`/api/v1/issues/${id}/status`, alice, "PATCH", { status: "resolved" }),
      p(id),
    );
    let [t] = await getDb().select().from(schema.issueTrack).where(eq(schema.issueTrack.id, id));
    expect(t!.status).toBe("resolved");
    expect(t!.resolvedAt).toBeInstanceOf(Date);
    await statusRoute.PATCH(
      req(`/api/v1/issues/${id}/status`, alice, "PATCH", { status: "open" }),
      p(id),
    );
    [t] = await getDb().select().from(schema.issueTrack).where(eq(schema.issueTrack.id, id));
    expect(t!.resolvedAt).toBeNull();

    // Same status again: no change, no event.
    const same = await statusRoute.PATCH(
      req(`/api/v1/issues/${id}/status`, alice, "PATCH", { status: "open" }),
      p(id),
    );
    expect((await same.json()).changed).toBe(false);
    const events = await eventsOf(id);
    expect(events.map((e) => [e.fromStatus, e.toStatus])).toEqual([
      [null, "open"],
      ["open", "in_progress"],
      ["in_progress", "resolved"],
      ["resolved", "open"],
    ]);
    expect(events.slice(1).every((e) => e.userId !== null && e.scanId === null)).toBe(true);
  });

  it("rejects system-only statuses, invalid input and foreign issues", async () => {
    const id = track["h1-missing"]!;
    for (const body of [
      { status: "reopened" },
      { status: "inconclusive" },
      { status: "done" },
      { status: "open", note: "x".repeat(2001) },
      {},
    ]) {
      const res = await statusRoute.PATCH(
        req(`/api/v1/issues/${id}/status`, alice, "PATCH", body),
        p(id),
      );
      expect(res.status).toBe(400);
    }
    const foreign = await statusRoute.PATCH(
      req(`/api/v1/issues/${id}/status`, bob, "PATCH", { status: "ignored" }),
      p(id),
    );
    expect(foreign.status).toBe(404);
    // Cross-site writes are refused before anything else.
    const cross = new NextRequest(`${APP}/api/v1/issues/${id}/status`, {
      method: "PATCH",
      headers: { cookie: alice, origin: "https://evil.test", "content-type": "application/json" },
      body: JSON.stringify({ status: "ignored" }),
    });
    expect((await statusRoute.PATCH(cross, p(id))).status).toBe(403);
    const [t] = await getDb().select().from(schema.issueTrack).where(eq(schema.issueTrack.id, id));
    expect(t!.status).toBe("open");
  });

  it("changes many issues at once, all-or-nothing on ownership", async () => {
    const ids = [track["title-missing"]!, track["h1-missing"]!, track.sitemap!];
    // One foreign id → 404 and nothing changes.
    const otherProject = (
      await (
        await projectsRoute.POST(
          req("/api/v1/projects", bob, "POST", { name: "B", websiteUrl: "example.org" }),
          {},
        )
      ).json()
    ).id;
    const bobScan = await startScan(bob, otherProject);
    await pipelineRepo.insertFindings(getDb(), bobScan, "seo", "SEO", [finding("x", null)]);
    await scanIssuesRepo.materializeScanIssues(getDb(), bobScan, [
      issue("x", await findingIds(bobScan)),
    ]);
    const [bobTrack] = await getDb()
      .select()
      .from(schema.issueTrack)
      .where(eq(schema.issueTrack.projectId, otherProject));
    const mixed = await bulkRoute.POST(
      req("/api/v1/issues/status", alice, "POST", {
        ids: [...ids, bobTrack!.id],
        status: "ignored",
      }),
      {},
    );
    expect(mixed.status).toBe(404);
    const statuses = await getDb()
      .select({ status: schema.issueTrack.status })
      .from(schema.issueTrack)
      .where(eq(schema.issueTrack.projectId, projectId));
    expect(statuses.every((s) => s.status === "open")).toBe(true);

    await statusRoute.PATCH(
      req(`/api/v1/issues/${ids[0]}/status`, alice, "PATCH", { status: "ignored" }),
      p(ids[0]!),
    );
    const res = await bulkRoute.POST(
      req("/api/v1/issues/status", alice, "POST", {
        ids: [...ids, ids[1]],
        status: "ignored",
        note: "Out of scope for this release",
      }),
      {},
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(new Set(body.changed)).toEqual(new Set([ids[1], ids[2]]));
    expect(body.unchanged).toEqual([ids[0]]);
    const bulkEvents = await getDb()
      .select()
      .from(schema.issueStatusEvent)
      .where(
        and(
          eq(schema.issueStatusEvent.toStatus, "ignored"),
          eq(schema.issueStatusEvent.note, "Out of scope for this release"),
        ),
      );
    expect(bulkEvents).toHaveLength(2);

    for (const bad of [
      { ids: [], status: "open" },
      { ids: ["not-a-uuid"], status: "open" },
      { ids: Array.from({ length: 101 }, () => crypto.randomUUID()), status: "open" },
      { ids, status: "reopened" },
    ])
      expect(
        (await bulkRoute.POST(req("/api/v1/issues/status", alice, "POST", bad), {})).status,
      ).toBe(400);
  });

  it("keeps user statuses when a later scan finds the issue again", async () => {
    const scan3 = await startScan(alice, projectId);
    await pipelineRepo.insertFindings(getDb(), scan3, "seo", "SEO", [finding("h1-missing", null)]);
    await scanIssuesRepo.materializeScanIssues(getDb(), scan3, [
      issue("h1-missing", await findingIds(scan3)),
    ]);
    const [t] = await getDb()
      .select()
      .from(schema.issueTrack)
      .where(eq(schema.issueTrack.id, track["h1-missing"]!));
    expect(t!.status).toBe("ignored");
    expect((await eventsOf(track["h1-missing"]!)).at(-1)!.toStatus).toBe("ignored");
  });
});
