import { closeDb, getDb, schema } from "@qa/db";
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
const authRoute = await import("@/app/api/v1/projects/[id]/scan-auth/route");
const scansRoute = await import("@/app/api/v1/projects/[id]/scans/route");
const scanRoute = await import("@/app/api/v1/scans/[id]/route");

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

describe.skipIf(!hasTestDb)("site authentication API (real database)", () => {
  let alice: string;
  let bob: string;
  let projectId: string;
  beforeAll(async () => {
    await resetDatabase();
    alice = await signUp("alice-auth@example.test");
    bob = await signUp("bob-auth@example.test");
    const res = await projectsRoute.POST(
      req("/api/v1/projects", alice, "POST", { name: "Members", websiteUrl: "example.com" }),
      {},
    );
    projectId = (await res.json()).id;
  });
  afterAll(() => closeDb());

  it("starts with no credentials", async () => {
    const res = await authRoute.GET(
      req(`/api/v1/projects/${projectId}/scan-auth`, alice),
      p(projectId),
    );
    expect(await res.json()).toEqual({ auth: null });
  });

  it("stores credentials encrypted and only ever returns a summary", async () => {
    const put = await authRoute.PUT(
      req(`/api/v1/projects/${projectId}/scan-auth`, alice, "PUT", {
        type: "basic",
        username: "qa",
        password: "Sup3r-Secret",
      }),
      p(projectId),
    );
    expect(put.status).toBe(200);
    const body = await put.text();
    expect(body).not.toContain("Sup3r-Secret");
    expect(JSON.parse(body)).toEqual({ auth: { type: "basic", username: "qa" } });

    const [row] = await getDb().select().from(schema.projectSecret);
    expect(row!.ciphertext).not.toContain("Sup3r-Secret");
    expect(row!.ciphertext.startsWith("v1.")).toBe(true);

    const get = await authRoute.GET(
      req(`/api/v1/projects/${projectId}/scan-auth`, alice),
      p(projectId),
    );
    expect(await get.json()).toEqual({ auth: { type: "basic", username: "qa" } });
  });

  it("records only the credential type on scans", async () => {
    const res = await scansRoute.POST(
      req(`/api/v1/projects/${projectId}/scans`, alice, "POST", { authorizationAttested: true }),
      p(projectId),
    );
    const { id } = await res.json();
    const detail = await (await scanRoute.GET(req(`/api/v1/scans/${id}`, alice), p(id))).json();
    expect(detail.configSnapshot.authType).toBe("basic");
    expect(JSON.stringify(detail)).not.toContain("Sup3r-Secret");
  });

  it("isolates credentials between users and validates input", async () => {
    expect(
      (await authRoute.GET(req(`/api/v1/projects/${projectId}/scan-auth`, bob), p(projectId)))
        .status,
    ).toBe(404);
    expect(
      (
        await authRoute.PUT(
          req(`/api/v1/projects/${projectId}/scan-auth`, bob, "PUT", {
            type: "basic",
            username: "x",
            password: "y",
          }),
          p(projectId),
        )
      ).status,
    ).toBe(404);
    const bad = await authRoute.PUT(
      req(`/api/v1/projects/${projectId}/scan-auth`, alice, "PUT", {
        type: "header",
        name: "Host",
        value: "evil",
      }),
      p(projectId),
    );
    expect(bad.status).toBe(400);
  });

  it("replaces and removes credentials", async () => {
    const put = await authRoute.PUT(
      req(`/api/v1/projects/${projectId}/scan-auth`, alice, "PUT", {
        type: "cookies",
        cookies: "sid=abc; theme=dark",
      }),
      p(projectId),
    );
    expect(await put.json()).toEqual({ auth: { type: "cookies", cookieNames: ["sid", "theme"] } });
    expect(await getDb().select().from(schema.projectSecret)).toHaveLength(1);
    expect(
      (
        await authRoute.DELETE(
          req(`/api/v1/projects/${projectId}/scan-auth`, alice, "DELETE"),
          p(projectId),
        )
      ).status,
    ).toBe(204);
    expect(
      await (
        await authRoute.GET(req(`/api/v1/projects/${projectId}/scan-auth`, alice), p(projectId))
      ).json(),
    ).toEqual({ auth: null });
  });
});
