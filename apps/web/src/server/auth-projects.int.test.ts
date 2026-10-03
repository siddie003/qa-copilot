import { closeDb } from "@qa/db";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hasTestDb, resetDatabase } from "../../../../tests/setup/db";

vi.mock("server-only", () => ({}));

const APP = "http://localhost:3000";

// Use an auth instance without the Next.js cookie plugin (no request scope in tests).
const { createAuth } = await import("./auth");
(globalThis as { __qaAuth?: unknown }).__qaAuth = hasTestDb
  ? createAuth({ withNextCookies: false })
  : undefined;
const { getAuth } = await import("./auth");
const projectsRoute = await import("@/app/api/v1/projects/route");
const projectRoute = await import("@/app/api/v1/projects/[id]/route");

async function signUp(email: string, password = "correct-horse-battery") {
  const res = await getAuth().api.signUpEmail({
    body: { name: email.split("@")[0]!, email, password },
    asResponse: true,
  });
  expect(res.status).toBe(200);
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  expect(cookie).toContain("session_token");
  return cookie;
}

function request(
  path: string,
  init: {
    method?: string;
    cookie?: string;
    body?: unknown;
    origin?: string;
    rawBody?: string;
  } = {},
) {
  const headers: Record<string, string> = {};
  if (init.cookie) headers.cookie = init.cookie;
  if (init.origin) headers.origin = init.origin;
  if (init.body !== undefined || init.rawBody !== undefined)
    headers["content-type"] = "application/json";
  return new NextRequest(`${APP}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.rawBody ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

// One pool for the whole file: the auth instance keeps a reference to it.
afterAll(() => closeDb());

describe.skipIf(!hasTestDb)("authentication (Better Auth on PostgreSQL)", () => {
  beforeEach(() => resetDatabase());

  it("signs up, resolves the session from the cookie, and signs out", async () => {
    const cookie = await signUp("alice@example.test");
    const session = await getAuth().api.getSession({ headers: new Headers({ cookie }) });
    expect(session?.user.email).toBe("alice@example.test");

    await getAuth().api.signOut({ headers: new Headers({ cookie }) });
    expect(await getAuth().api.getSession({ headers: new Headers({ cookie }) })).toBeNull();
  });

  it("stores a hashed password, never the plain text", async () => {
    await signUp("hash@example.test", "plain-text-password-123");
    const { getDb, schema } = await import("@qa/db");
    const [account] = await getDb().select().from(schema.account);
    expect(account?.password).toBeTruthy();
    expect(account?.password).not.toContain("plain-text-password-123");
  });

  it("rejects short passwords, duplicate emails and wrong passwords", async () => {
    await expect(
      getAuth().api.signUpEmail({
        body: { name: "x", email: "short@example.test", password: "short" },
      }),
    ).rejects.toThrow();

    await signUp("dup@example.test");
    await expect(
      getAuth().api.signUpEmail({
        body: { name: "x", email: "dup@example.test", password: "another-long-password" },
      }),
    ).rejects.toThrow();

    await expect(
      getAuth().api.signInEmail({
        body: { email: "dup@example.test", password: "wrong-password-123" },
      }),
    ).rejects.toThrow();
  });
});

describe.skipIf(!hasTestDb)("projects API (route handlers, real database)", () => {
  let alice: string;
  let bob: string;

  beforeAll(async () => {
    await resetDatabase();
    alice = await signUp("alice-api@example.test");
    bob = await signUp("bob-api@example.test");
  });

  it("requires authentication", async () => {
    const res = await projectsRoute.GET(request("/api/v1/projects"), {});
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
  });

  it("creates, lists, updates and deletes a project with owner isolation", async () => {
    const created = await projectsRoute.POST(
      request("/api/v1/projects", {
        method: "POST",
        cookie: alice,
        origin: APP,
        body: { name: "  Shop  ", websiteUrl: "shop.example.com" },
      }),
      {},
    );
    expect(created.status).toBe(201);
    const project = await created.json();
    expect(project).toMatchObject({
      name: "Shop",
      websiteUrl: "https://shop.example.com/",
      lastScan: null,
    });
    expect(project.scanDefaults.scanners).toHaveLength(6);

    const list = await (
      await projectsRoute.GET(request("/api/v1/projects?q=shop", { cookie: alice }), {})
    ).json();
    expect(list).toMatchObject({ total: 1, page: 1 });

    // Bob cannot see, change or delete Alice's project.
    expect(
      (
        await projectRoute.GET(
          request(`/api/v1/projects/${project.id}`, { cookie: bob }),
          params(project.id),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await projectRoute.PATCH(
          request(`/api/v1/projects/${project.id}`, {
            method: "PATCH",
            cookie: bob,
            body: { name: "x" },
          }),
          params(project.id),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await projectRoute.DELETE(
          request(`/api/v1/projects/${project.id}`, { method: "DELETE", cookie: bob }),
          params(project.id),
        )
      ).status,
    ).toBe(404);
    const bobList = await (
      await projectsRoute.GET(request("/api/v1/projects", { cookie: bob }), {})
    ).json();
    expect(bobList.total).toBe(0);

    const patched = await projectRoute.PATCH(
      request(`/api/v1/projects/${project.id}`, {
        method: "PATCH",
        cookie: alice,
        body: { name: "Shop v2" },
      }),
      params(project.id),
    );
    expect(patched.status).toBe(200);
    expect((await patched.json()).name).toBe("Shop v2");

    const deleted = await projectRoute.DELETE(
      request(`/api/v1/projects/${project.id}`, { method: "DELETE", cookie: alice }),
      params(project.id),
    );
    expect(deleted.status).toBe(204);
    expect(
      (
        await projectRoute.GET(
          request(`/api/v1/projects/${project.id}`, { cookie: alice }),
          params(project.id),
        )
      ).status,
    ).toBe(404);
  });

  it("rejects private and malformed website URLs with a field error", async () => {
    for (const websiteUrl of [
      "http://169.254.169.254/",
      "http://localhost:5432",
      "ftp://example.com",
    ]) {
      const res = await projectsRoute.POST(
        request("/api/v1/projects", {
          method: "POST",
          cookie: alice,
          body: { name: "x", websiteUrl },
        }),
        {},
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.errors[0].path).toBe("websiteUrl");
    }
  });

  it("rejects invalid bodies, unknown scanners and cross-origin writes", async () => {
    const bad = await projectsRoute.POST(
      request("/api/v1/projects", { method: "POST", cookie: alice, rawBody: "{not json" }),
      {},
    );
    expect(bad.status).toBe(400);

    const badScanner = await projectsRoute.POST(
      request("/api/v1/projects", {
        method: "POST",
        cookie: alice,
        body: {
          name: "x",
          websiteUrl: "https://example.com",
          scanDefaults: {
            scanners: ["port-scan"],
            viewports: [],
            maxPages: 1,
            maxDepth: 0,
            respectRobots: true,
          },
        },
      }),
      {},
    );
    expect(badScanner.status).toBe(400);

    const csrf = await projectsRoute.POST(
      request("/api/v1/projects", {
        method: "POST",
        cookie: alice,
        origin: "https://evil.example",
        body: { name: "x", websiteUrl: "https://example.com" },
      }),
      {},
    );
    expect(csrf.status).toBe(403);
  });

  it("returns 404 (not 500) for malformed project ids", async () => {
    const res = await projectRoute.GET(
      request("/api/v1/projects/not-a-uuid", { cookie: alice }),
      params("not-a-uuid"),
    );
    expect(res.status).toBe(404);
  });
});
