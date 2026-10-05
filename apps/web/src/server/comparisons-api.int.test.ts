import type { ScanComparisonResult } from "@qa/core";
import { closeDb, getDb, pipelineRepo, scanIssuesRepo, schema } from "@qa/db";
import { and, asc, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hasTestDb, resetDatabase } from "../../../../tests/setup/db";

vi.mock("server-only", () => ({}));

// Phase 9: scan comparison and history API, reopen logic, comparison cache.
const APP = "http://localhost:3000";
const SITE = "https://example.com";
const { createAuth } = await import("./auth");
(globalThis as { __qaAuth?: unknown }).__qaAuth = hasTestDb
  ? createAuth({ withNextCookies: false })
  : undefined;
const { getAuth } = await import("./auth");
const projectsRoute = await import("@/app/api/v1/projects/route");
const scansRoute = await import("@/app/api/v1/projects/[id]/scans/route");
const comparisonsRoute = await import("@/app/api/v1/projects/[id]/comparisons/route");
const historyRoute = await import("@/app/api/v1/projects/[id]/history/route");
const statusRoute = await import("@/app/api/v1/issues/[id]/status/route");
const issueRoute = await import("@/app/api/v1/issues/[id]/route");

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

type Spec = { rule: string; path: string | null; severity?: string; verdict?: string };

/**
 * Creates a scan through the API and stores what the pipeline would: pages, completed steps,
 * findings and one issue per rule (status from the evidence, like the grounding step).
 */
async function createScan(cookie: string, projectId: string) {
  const res = await scansRoute.POST(
    req(`/api/v1/projects/${projectId}/scans`, cookie, "POST", { authorizationAttested: true }),
    p(projectId),
  );
  return (await res.json()).id as string;
}

async function runScan(cookie: string, projectId: string, specs: Spec[]) {
  const scanId = await createScan(cookie, projectId);
  await populate(scanId, specs);
  return scanId;
}

async function populate(scanId: string, specs: Spec[], pages = ["/", "/about", "/pricing"]) {
  const pageIds: Record<string, string> = {};
  for (const path of pages)
    pageIds[path] = (await pipelineRepo.insertPage(getDb(), scanId, {
      url: `${SITE}${path}`,
      normalizedUrl: `${SITE}${path}`,
      finalUrl: null,
      httpStatus: 200,
      redirectChain: null,
      depth: path === "/" ? 0 : 1,
      discoveredFrom: null,
      title: null,
      contentType: "text/html",
      responseHeaders: null,
      rawHtmlKey: null,
      crawlError: null,
    }))!;
  for (const run of await getDb()
    .select()
    .from(schema.scannerRun)
    .where(eq(schema.scannerRun.scanId, scanId)))
    await getDb()
      .update(schema.scannerRun)
      .set({
        status: run.status === "skipped" || run.stepKey === "ai" ? "skipped" : "completed",
        checks: { evaluated: 1, inconclusive: [], inconclusiveTotal: 0 },
      })
      .where(eq(schema.scannerRun.id, run.id));
  await pipelineRepo.insertFindings(
    getDb(),
    scanId,
    "seo",
    "SEO",
    specs.map((s) => ({
      ruleId: s.rule,
      title: `Finding ${s.rule}`,
      message: `${s.rule} (test)`,
      category: "seo",
      subcategory: null,
      pageId: s.path ? pageIds[s.path]! : null,
      locationKey: s.path ?? "site",
      selector: null,
      viewport: null,
      severity: (s.severity ?? "medium") as "medium",
      verdict: (s.verdict ?? "confirmed") as "confirmed",
      confidence: 0.9,
      expected: null,
      actual: null,
      fingerprintKey: null,
      evidence: [{ kind: "document", data: { observed: s.rule } }],
    })),
  );
  const findings = await getDb()
    .select()
    .from(schema.rawFinding)
    .where(eq(schema.rawFinding.scanId, scanId))
    .orderBy(asc(schema.rawFinding.displayId));
  return materialize(
    scanId,
    specs,
    findings.map((f) => f.id),
  );
}

async function materialize(scanId: string, specs: Spec[], ids: string[]) {
  return scanIssuesRepo.materializeScanIssues(
    getDb(),
    scanId,
    specs.map((s, k) => {
      const inconclusive = s.verdict === "inconclusive";
      return {
        fingerprint: s.rule,
        category: "seo",
        ruleId: s.rule,
        subcategory: null,
        severity: (s.severity ?? "medium") as "medium",
        severityRationale: "Scanner rule.",
        title: `Issue ${s.rule}`,
        description: `Description of ${s.rule}.`,
        affectedUrls: s.path ? [`${SITE}${s.path}`] : [],
        affectedElement: null,
        expected: null,
        actual: null,
        recommendation: "Fix it.",
        confidence: 0.9,
        verdict: (s.verdict ?? "confirmed") as "confirmed",
        status: inconclusive ? "inconclusive" : "open",
        origin: "deterministic" as const,
        groundingStatus: "not_applicable" as const,
        aiRunId: null,
        findingIds: [ids[k]!],
        checks: [],
      };
    }),
  );
}

async function finish(scanId: string, status: "completed" | "failed" = "completed") {
  await getDb()
    .update(schema.scan)
    .set({ status, startedAt: new Date(), finishedAt: new Date() })
    .where(eq(schema.scan.id, scanId));
}

async function compare(cookie: string, projectId: string, query = "") {
  return comparisonsRoute.GET(
    req(`/api/v1/projects/${projectId}/comparisons${query}`, cookie),
    p(projectId),
  );
}

const trackOf = async (projectId: string, rule: string) =>
  (
    await getDb()
      .select()
      .from(schema.issueTrack)
      .where(
        and(eq(schema.issueTrack.projectId, projectId), eq(schema.issueTrack.fingerprint, rule)),
      )
  )[0]!;

const setStatus = (cookie: string, trackId: string, status: string, note?: string) =>
  statusRoute.PATCH(
    req(`/api/v1/issues/${trackId}/status`, cookie, "PATCH", { status, note }),
    p(trackId),
  );

describe.skipIf(!hasTestDb)("scan comparison and history API (real database)", () => {
  let alice: string;
  let bob: string;
  let projectId: string;
  let scan1: string;
  let scan2: string;
  let scan3: string;

  beforeAll(async () => {
    await resetDatabase();
    alice = await signUp("alice-history@example.test");
    bob = await signUp("bob-history@example.test");
    projectId = (
      await (
        await projectsRoute.POST(
          req("/api/v1/projects", alice, "POST", { name: "H", websiteUrl: "example.com" }),
          {},
        )
      ).json()
    ).id;
    scan1 = await runScan(alice, projectId, [
      { rule: "title-missing", path: "/about" },
      { rule: "h1-missing", path: "/pricing" },
      { rule: "meta-description-missing", path: "/" },
      { rule: "sitemap-not-found", path: null, verdict: "inconclusive" },
    ]);
    await finish(scan1);
  });
  afterAll(() => closeDb());

  it("has nothing to compare with a single scan (409 with the reason)", async () => {
    const res = await compare(alice, projectId);
    expect(res.status).toBe(409);
    expect((await res.json()).detail).toContain("Only one finished scan");
  });

  it("refuses to compare while a scan is still running (409)", async () => {
    scan2 = await createScan(alice, projectId);
    const res = await compare(alice, projectId, `?base=${scan1}&target=${scan2}`);
    expect(res.status).toBe(409);
    expect((await res.json()).detail).toContain("has not finished yet");
    // Clean up: this scan never ran (it stays without issue records).
    await finish(scan2, "failed");
  });

  it("compares two finished scans from their records and caches the summary", async () => {
    scan2 = await runScan(alice, projectId, [
      { rule: "title-missing", path: "/about", severity: "high" },
      { rule: "meta-description-missing", path: "/" },
      { rule: "canonical-missing", path: "/" },
      { rule: "sitemap-not-found", path: null, verdict: "confirmed" },
    ]);
    await finish(scan2);
    const res = await compare(alice, projectId);
    expect(res.status).toBe(200);
    const r = (await res.json()) as ScanComparisonResult;
    expect([r.base.id, r.target.id]).toEqual([scan1, scan2]);
    expect(r.comparable).toBe(true);
    const cat = Object.fromEntries(r.issues.map((i) => [i.ruleId, i.category]));
    expect(cat).toEqual({
      "title-missing": "changed",
      "h1-missing": "resolved",
      "meta-description-missing": "persistent",
      "canonical-missing": "new",
      "sitemap-not-found": "changed",
    });
    const sitemap = r.issues.find((i) => i.ruleId === "sitemap-not-found")!;
    expect(sitemap.reason).toContain("verdict unable to verify → confirmed");
    expect(r.summary.counts).toMatchObject({ new: 1, resolved: 1, changed: 2, persistent: 1 });
    const [cached] = await getDb()
      .select()
      .from(schema.scanComparison)
      .where(eq(schema.scanComparison.targetScanId, scan2));
    expect(cached!.baseScanId).toBe(scan1);
    expect(cached!.summary).toMatchObject({ version: 1, counts: r.summary.counts });
    // The failed scan in between (no issue records) is skipped by the default pair…
    const failed = await getDb()
      .select()
      .from(schema.scan)
      .where(and(eq(schema.scan.projectId, projectId), eq(schema.scan.number, 2)));
    expect(failed[0]!.status).toBe("failed");
    // …and comparing with it explicitly says why issues cannot be compared.
    const withFailed = (await (
      await compare(alice, projectId, `?base=${scan1}&target=${failed[0]!.id}`)
    ).json()) as ScanComparisonResult;
    expect(withFailed.comparable).toBe(false);
    expect(withFailed.notComparable[0]).toMatch(
      /Scan #2 has no issue records: evidence validation/,
    );
    expect(withFailed.issues).toEqual([]);
  });

  it("validates the pair: order, same scan, foreign and malformed ids, other users", async () => {
    const bad = async (query: string, cookie = alice) =>
      (await compare(cookie, projectId, query)).status;
    expect(await bad(`?base=${scan2}&target=${scan1}`)).toBe(400);
    expect(await bad(`?base=${scan1}&target=${scan1}`)).toBe(400);
    expect(await bad(`?base=not-a-uuid&target=${scan2}`)).toBe(404);
    expect(await bad(`?base=${crypto.randomUUID()}&target=${scan2}`)).toBe(404);
    expect(await bad(`?base=${scan1}&target=${scan2}`, bob)).toBe(404);
    // Bob's own project cannot reference Alice's scans.
    const bobProject = (
      await (
        await projectsRoute.POST(
          req("/api/v1/projects", bob, "POST", { name: "B", websiteUrl: "example.org" }),
          {},
        )
      ).json()
    ).id;
    expect(
      (
        await comparisonsRoute.GET(
          req(`/api/v1/projects/${bobProject}/comparisons?base=${scan1}&target=${scan2}`, bob),
          p(bobProject),
        )
      ).status,
    ).toBe(404);
  });

  it("reopens resolved issues found again with evidence; inconclusive evidence keeps them resolved", async () => {
    const title = await trackOf(projectId, "title-missing");
    const canonical = await trackOf(projectId, "canonical-missing");
    const meta = await trackOf(projectId, "meta-description-missing");
    expect((await setStatus(alice, title.id, "resolved", "Fixed in release 2.1")).status).toBe(200);
    expect((await setStatus(alice, canonical.id, "resolved")).status).toBe(200);
    expect((await setStatus(alice, meta.id, "resolved")).status).toBe(200);

    const specs: Spec[] = [
      { rule: "title-missing", path: "/about", severity: "high" },
      { rule: "meta-description-missing", path: "/" },
      { rule: "canonical-missing", path: "/", verdict: "inconclusive" },
    ];
    scan3 = await runScan(alice, projectId, specs);
    let t = await trackOf(projectId, "title-missing");
    expect(t.status).toBe("reopened");
    expect(t.resolvedAt).toBeNull();
    expect((await trackOf(projectId, "meta-description-missing")).status).toBe("reopened");
    // An inconclusive occurrence cannot show that the fix failed.
    expect((await trackOf(projectId, "canonical-missing")).status).toBe("resolved");

    const events = await getDb()
      .select()
      .from(schema.issueStatusEvent)
      .where(eq(schema.issueStatusEvent.trackId, title.id))
      .orderBy(asc(schema.issueStatusEvent.createdAt));
    expect(events.at(-1)).toMatchObject({
      fromStatus: "resolved",
      toStatus: "reopened",
      userId: null,
      scanId: scan3,
      note: scanIssuesRepo.SYSTEM_EVENT_NOTES.reopened,
    });
    // Idempotent: re-running the materialization adds no second reopen event.
    const ids = (
      await getDb()
        .select()
        .from(schema.rawFinding)
        .where(eq(schema.rawFinding.scanId, scan3))
        .orderBy(asc(schema.rawFinding.displayId))
    ).map((f) => f.id);
    await materialize(scan3, specs, ids);
    const again = await getDb()
      .select()
      .from(schema.issueStatusEvent)
      .where(
        and(
          eq(schema.issueStatusEvent.trackId, title.id),
          eq(schema.issueStatusEvent.toStatus, "reopened"),
        ),
      );
    expect(again).toHaveLength(1);
    await finish(scan3);

    // The issue detail shows the system event in the status history.
    const detail = await (
      await issueRoute.GET(req(`/api/v1/issues/${title.id}`, alice), p(title.id))
    ).json();
    expect(JSON.stringify(detail)).toContain(scanIssuesRepo.SYSTEM_EVENT_NOTES.reopened);

    const r = (await (
      await compare(alice, projectId, `?base=${scan2}&target=${scan3}`)
    ).json()) as ScanComparisonResult;
    const cat = Object.fromEntries(r.issues.map((i) => [i.ruleId, i.category]));
    expect(cat).toMatchObject({
      "title-missing": "reopened",
      "meta-description-missing": "reopened",
      "canonical-missing": "changed",
      "sitemap-not-found": "resolved",
    });
    expect(r.issues.find((i) => i.ruleId === "title-missing")!.trackStatus).toBe("reopened");
    expect(r.issues.find((i) => i.ruleId === "canonical-missing")!.trackStatus).toBe("resolved");
    t = await trackOf(projectId, "title-missing");
    expect(t.lastSeenScanId).toBe(scan3);
  });

  it("does not reopen an issue whose fix was claimed after the scan started", async () => {
    const h1 = await trackOf(projectId, "h1-missing");
    const scan4 = await createScan(alice, projectId);
    await getDb()
      .update(schema.scan)
      .set({ status: "running", startedAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.scan.id, scan4));
    // The scan has been running for a minute when the fix is claimed: its evidence may predate it.
    expect((await setStatus(alice, h1.id, "resolved")).status).toBe(200);
    const stored = await populate(scan4, [{ rule: "h1-missing", path: "/pricing" }]);
    expect(stored.reopened).toBe(0);
    expect((await trackOf(projectId, "h1-missing")).status).toBe("resolved");
    await finish(scan4);
    // The comparison still reports what the records show: it came back after scan #4.
    const r = (await (await compare(alice, projectId)).json()) as ScanComparisonResult;
    expect([r.base.id, r.target.id]).toEqual([scan3, scan4]);
    expect(r.issues.find((i) => i.ruleId === "h1-missing")).toMatchObject({
      category: "reopened",
      trackStatus: "resolved",
      reason: "Found in scan #1, not found by scan #4, and found again by scan #5.",
    });
  });

  it("lists the history with issue counts, changes and a chronological trend", async () => {
    const res = await historyRoute.GET(
      req(`/api/v1/projects/${projectId}/history`, alice),
      p(projectId),
    );
    expect(res.status).toBe(200);
    const h = await res.json();
    expect(h.items.map((i: { number: number }) => i.number)).toEqual([5, 4, 3, 2, 1]);
    const byNo = (n: number) => h.items.find((i: { number: number }) => i.number === n);
    expect(byNo(2)).toMatchObject({ comparable: false, changes: null, breakdown: null });
    expect(byNo(3)).toMatchObject({
      comparable: true,
      previous: { number: 1 },
      changes: { counts: { new: 1, resolved: 1, changed: 2, persistent: 1 } },
      breakdown: { confirmed: 4, unableToVerify: 0 },
    });
    expect(byNo(4).previous.number).toBe(3);
    expect(byNo(4).changes.counts).toMatchObject({ reopened: 2, changed: 1, resolved: 1 });
    expect(byNo(1)).toMatchObject({
      previous: null,
      changes: null,
      breakdown: { confirmed: 3, unableToVerify: 1 },
    });
    expect(h.trend.map((i: { number: number }) => i.number)).toEqual([1, 3, 4, 5]);
    expect(h.comparableCount).toBe(4);
    // Summaries are cached once per pair.
    const rows = await getDb()
      .select()
      .from(schema.scanComparison)
      .where(eq(schema.scanComparison.projectId, projectId));
    const pairs = rows.map((r) => `${r.baseScanId}:${r.targetScanId}`);
    expect(new Set(pairs).size).toBe(pairs.length);
    expect(
      (await historyRoute.GET(req(`/api/v1/projects/${projectId}/history`, bob), p(projectId)))
        .status,
    ).toBe(404);
  });
});
