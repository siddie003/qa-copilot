import { getConfig } from "@qa/core";
import { closeDb } from "@qa/db";
import { createLocalStorage } from "@qa/storage";
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
const projectScansRoute = await import("@/app/api/v1/projects/[id]/scans/route");
const scanRoute = await import("@/app/api/v1/scans/[id]/route");
const cancelRoute = await import("@/app/api/v1/scans/[id]/cancel/route");
const eventsRoute = await import("@/app/api/v1/scans/[id]/events/route");
const artifactRoute = await import("@/app/api/v1/artifacts/[...key]/route");

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
const p = <T extends Record<string, unknown>>(v: T) => ({ params: Promise.resolve(v) });

describe.skipIf(!hasTestDb)("scan API (route handlers, real database)", () => {
  let alice: string;
  let bob: string;
  let projectId: string;
  let scanId: string;

  beforeAll(async () => {
    await resetDatabase();
    alice = await signUp("alice-scan@example.test");
    bob = await signUp("bob-scan@example.test");
    const res = await projectsRoute.POST(
      req("/api/v1/projects", alice, "POST", { name: "Scan target", websiteUrl: "example.com" }),
      {},
    );
    projectId = (await res.json()).id;
  });
  afterAll(() => closeDb());

  it("requires the authorization confirmation", async () => {
    const res = await projectScansRoute.POST(
      req(`/api/v1/projects/${projectId}/scans`, alice, "POST", {}),
      p({ id: projectId }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).errors[0].path).toBe("authorizationAttested");
  });

  it("queues a scan with planned steps; other users cannot start or see it", async () => {
    const forbidden = await projectScansRoute.POST(
      req(`/api/v1/projects/${projectId}/scans`, bob, "POST", { authorizationAttested: true }),
      p({ id: projectId }),
    );
    expect(forbidden.status).toBe(404);

    const res = await projectScansRoute.POST(
      req(`/api/v1/projects/${projectId}/scans`, alice, "POST", { authorizationAttested: true }),
      p({ id: projectId }),
    );
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created).toMatchObject({ number: 1, status: "queued" });
    scanId = created.id;

    const detail = await (
      await scanRoute.GET(req(`/api/v1/scans/${scanId}`, alice), p({ id: scanId }))
    ).json();
    expect(detail.configSnapshot).toMatchObject({
      websiteUrl: "https://example.com/",
      maxPages: 25,
    });
    expect(detail.configSnapshot.authorizationAttestedAt).toBeTruthy();
    expect(detail.runs.map((r: { stepKey: string }) => r.stepKey).slice(0, 3)).toEqual([
      "preflight",
      "crawl",
      "capture",
    ]);
    expect(detail.runs.find((r: { stepKey: string }) => r.stepKey === "seo").status).toBe(
      "pending",
    );
    // AI analysis and evidence validation are planned; the worker skips AI without a provider.
    const status = (key: string) =>
      detail.runs.find((r: { stepKey: string }) => r.stepKey === key).status;
    expect([status("ai"), status("grounding")]).toEqual(["pending", "pending"]);
    // Reports are generated on demand for finished scans, not during the scan (Phase 8).
    expect(detail.runs.some((r: { stepKey: string }) => r.stepKey === "report")).toBe(false);

    expect(
      (await scanRoute.GET(req(`/api/v1/scans/${scanId}`, bob), p({ id: scanId }))).status,
    ).toBe(404);
    expect(
      (await scanRoute.GET(req(`/api/v1/scans/not-a-uuid`, alice), p({ id: "not-a-uuid" }))).status,
    ).toBe(404);
  });

  it("allows only one active scan per project", async () => {
    const res = await projectScansRoute.POST(
      req(`/api/v1/projects/${projectId}/scans`, alice, "POST", { authorizationAttested: true }),
      p({ id: projectId }),
    );
    expect(res.status).toBe(409);
  });

  it("streams scan events and closes the stream when the scan is cancelled", async () => {
    const res = await eventsRoute.GET(
      req(`/api/v1/scans/${scanId}/events`, alice),
      p({ id: scanId }),
    );
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = decoder.decode((await reader.read()).value);
    expect(text).toMatch(/^event: scan\ndata: .*"status":"queued"/);

    expect(
      (
        await cancelRoute.POST(
          req(`/api/v1/scans/${scanId}/cancel`, bob, "POST"),
          p({ id: scanId }),
        )
      ).status,
    ).toBe(404);
    const cancel = await cancelRoute.POST(
      req(`/api/v1/scans/${scanId}/cancel`, alice, "POST"),
      p({ id: scanId }),
    );
    expect(await cancel.json()).toMatchObject({ status: "cancelled", previousStatus: "queued" });

    // The notification arrives via LISTEN/NOTIFY; read until the server closes the stream.
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    expect(text).toMatch(/"status":"cancelled"/);

    const again = await cancelRoute.POST(
      req(`/api/v1/scans/${scanId}/cancel`, alice, "POST"),
      p({ id: scanId }),
    );
    expect(again.status).toBe(409);
  });

  it("serves artifacts only to the scan owner and rejects unsafe keys", async () => {
    const storage = createLocalStorage(getConfig().storageDirAbsolute);
    const key = `scans/${scanId}/pages/test/desktop.png`;
    await storage.put(key, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    try {
      const segs = key.split("/");
      const ok = await artifactRoute.GET(req(`/api/v1/artifacts/${key}`, alice), p({ key: segs }));
      expect(ok.status).toBe(200);
      expect(ok.headers.get("content-type")).toBe("image/png");
      expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
      expect((await ok.arrayBuffer()).byteLength).toBe(4);

      expect(
        (await artifactRoute.GET(req(`/api/v1/artifacts/${key}`, bob), p({ key: segs }))).status,
      ).toBe(404);
      expect(
        (
          await artifactRoute.GET(
            req("/api/v1/artifacts/x", alice),
            p({ key: ["..", "..", ".env"] }),
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await artifactRoute.GET(
            req("/api/v1/artifacts/x", alice),
            p({ key: ["projects", "x.png"] }),
          )
        ).status,
      ).toBe(404);
    } finally {
      await storage.removePrefix(`scans/${scanId}`);
    }
  });
});
