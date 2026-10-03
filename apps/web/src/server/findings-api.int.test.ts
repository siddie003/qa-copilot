import { closeDb, getDb, pipelineRepo, schema } from "@qa/db";
import { eq } from "drizzle-orm";
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
const findingsRoute = await import("@/app/api/v1/scans/[id]/findings/route");

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

const finding = (ruleId: string, severity: "high" | "low", title: string) => ({
  ruleId,
  title,
  message: `${title} (test)`,
  category: "seo",
  subcategory: null,
  pageId: null,
  locationKey: "site",
  selector: null,
  viewport: null,
  severity,
  verdict: "confirmed" as const,
  confidence: 0.9,
  expected: "x",
  actual: "y",
  fingerprintKey: null,
  evidence: [{ kind: "document", data: { observed: ruleId } }],
});

describe.skipIf(!hasTestDb)("findings API (real database)", () => {
  let alice: string;
  let bob: string;
  let scanId: string;

  beforeAll(async () => {
    await resetDatabase();
    alice = await signUp("alice-findings@example.test");
    bob = await signUp("bob-findings@example.test");
    const project = await (
      await projectsRoute.POST(
        req("/api/v1/projects", alice, "POST", { name: "F", websiteUrl: "example.com" }),
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
    // Findings as a scanner would store them (test data in the _test database).
    await pipelineRepo.insertFindings(getDb(), scanId, "seo", "SEO", [
      finding("title-missing", "high", "Page has no title"),
      finding("open-graph-missing", "low", "Open Graph tags are missing"),
    ]);
  });
  afterAll(() => closeDb());

  it("returns findings with evidence, display ids and fingerprints", async () => {
    const res = await findingsRoute.GET(req(`/api/v1/scans/${scanId}/findings`, alice), p(scanId));
    const body = await res.json();
    expect(body.total).toBe(2);
    expect(body.items.map((f: { displayId: string }) => f.displayId).sort()).toEqual([
      "SEO-001",
      "SEO-002",
    ]);
    expect(body.items[0].evidence[0]).toMatchObject({ kind: "document" });
    const rows = await getDb()
      .select()
      .from(schema.rawFinding)
      .where(eq(schema.rawFinding.scanId, scanId));
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.fingerprint))).toBe(true);
    expect(new Set(rows.map((r) => r.fingerprint)).size).toBe(2);
  });

  it("filters by scanner and severity and ignores invalid filter values", async () => {
    const high = await (
      await findingsRoute.GET(
        req(`/api/v1/scans/${scanId}/findings?severity=high`, alice),
        p(scanId),
      )
    ).json();
    expect(high.items.map((f: { ruleId: string }) => f.ruleId)).toEqual(["title-missing"]);
    const other = await (
      await findingsRoute.GET(
        req(`/api/v1/scans/${scanId}/findings?scanner=links`, alice),
        p(scanId),
      )
    ).json();
    expect(other.total).toBe(0);
    const junk = await (
      await findingsRoute.GET(
        req(`/api/v1/scans/${scanId}/findings?scanner=drop%20table&severity=bogus`, alice),
        p(scanId),
      )
    ).json();
    expect(junk.total).toBe(2);
  });

  it("hides findings from other users and rejects malformed ids", async () => {
    expect(
      (await findingsRoute.GET(req(`/api/v1/scans/${scanId}/findings`, bob), p(scanId))).status,
    ).toBe(404);
    expect((await findingsRoute.GET(req("/api/v1/scans/x/findings", alice), p("x"))).status).toBe(
      404,
    );
  });
});
