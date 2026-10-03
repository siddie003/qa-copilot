import { closeDb } from "@qa/db";
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
const validateRoute = await import("@/app/api/v1/projects/validate-url/route");
const referencesRoute = await import("@/app/api/v1/projects/[id]/references/route");
const dashboardRoute = await import("@/app/api/v1/dashboard/summary/route");

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
const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe.skipIf(!hasTestDb)("Phase 3 API (route handlers, real database)", () => {
  let alice: string;
  let bob: string;

  beforeAll(async () => {
    await resetDatabase();
    alice = await signUp("alice-p3@example.test");
    bob = await signUp("bob-p3@example.test");
  });
  afterAll(() => closeDb());

  it("validate-url normalizes good URLs and rejects internal ones", async () => {
    const ok = await validateRoute.POST(
      req("/api/v1/projects/validate-url", alice, "POST", { websiteUrl: "Example.com/shop" }),
      {},
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, url: "https://example.com/shop" });

    const bad = await validateRoute.POST(
      req("/api/v1/projects/validate-url", alice, "POST", { websiteUrl: "http://10.0.0.5" }),
      {},
    );
    expect(bad.status).toBe(400);
    expect((await bad.json()).errors[0].path).toBe("websiteUrl");
  });

  it("creates a project with a Figma reference stored as pending, in one transaction", async () => {
    const res = await projectsRoute.POST(
      req("/api/v1/projects", alice, "POST", {
        name: "Wizard project",
        websiteUrl: "example.com",
        figmaUrl: "https://www.figma.com/design/AbCdEfGh1234/Site?node-id=3-7",
        scanDefaults: {
          scanners: ["seo", "accessibility"],
          viewports: [{ name: "mobile", width: 390, height: 844 }],
          maxPages: 5,
          maxDepth: 1,
          respectRobots: true,
        },
      }),
      {},
    );
    expect(res.status).toBe(201);
    const project = await res.json();
    // Scanner order is normalized to the canonical order.
    expect(project.scanDefaults.scanners).toEqual(["accessibility", "seo"]);

    const refs = await (
      await referencesRoute.GET(
        req(`/api/v1/projects/${project.id}/references`, alice),
        params(project.id),
      )
    ).json();
    expect(refs.items).toHaveLength(1);
    expect(refs.items[0]).toMatchObject({
      kind: "figma",
      status: "pending",
      figmaFileKey: "AbCdEfGh1234",
      figmaNodeIds: ["3:7"],
      fetchedAt: null,
    });

    // Another user can neither list nor add references to this project.
    expect(
      (
        await referencesRoute.GET(
          req(`/api/v1/projects/${project.id}/references`, bob),
          params(project.id),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await referencesRoute.POST(
          req(`/api/v1/projects/${project.id}/references`, bob, "POST", {
            figmaUrl: "https://www.figma.com/design/AbCdEfGh1234/x",
          }),
          params(project.id),
        )
      ).status,
    ).toBe(404);
  });

  it("rejects an invalid Figma link without creating the project", async () => {
    const before = (await (await projectsRoute.GET(req("/api/v1/projects", alice), {})).json())
      .total;
    const res = await projectsRoute.POST(
      req("/api/v1/projects", alice, "POST", {
        name: "Bad figma",
        websiteUrl: "example.com",
        figmaUrl: "https://evil.com/design/AbCdEfGh1234",
      }),
      {},
    );
    expect(res.status).toBe(400);
    expect((await res.json()).errors[0].path).toBe("figmaUrl");
    const after = (await (await projectsRoute.GET(req("/api/v1/projects", alice), {})).json())
      .total;
    expect(after).toBe(before);
  });

  it("dashboard summary is computed per user from stored rows", async () => {
    const a = await (await dashboardRoute.GET(req("/api/v1/dashboard/summary", alice), {})).json();
    expect(a).toMatchObject({ projectCount: 1, recentScans: [], latestScan: null });
    expect(a.issueCounts.total).toBe(0);
    const b = await (await dashboardRoute.GET(req("/api/v1/dashboard/summary", bob), {})).json();
    expect(b.projectCount).toBe(0);
    expect((await dashboardRoute.GET(req("/api/v1/dashboard/summary", ""), {})).status).toBe(401);
  });
});
