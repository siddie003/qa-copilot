import { getConfig } from "@qa/core";
import { closeDb, getDb, reportsRepo, schema } from "@qa/db";
import { createLocalStorage } from "@qa/storage";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hasTestDb, resetDatabase } from "../../../../tests/setup/db";

vi.mock("server-only", () => ({}));

// Phase 8: report requests, listing, status, download and deletion (the worker side is tested
// in apps/worker/src/reports).
const APP = "http://localhost:3000";
const { createAuth } = await import("./auth");
(globalThis as { __qaAuth?: unknown }).__qaAuth = hasTestDb
  ? createAuth({ withNextCookies: false })
  : undefined;
const { getAuth } = await import("./auth");
const projectsRoute = await import("@/app/api/v1/projects/route");
const scansRoute = await import("@/app/api/v1/projects/[id]/scans/route");
const scanReportsRoute = await import("@/app/api/v1/scans/[id]/reports/route");
const reportRoute = await import("@/app/api/v1/reports/[id]/route");
const downloadRoute = await import("@/app/api/v1/reports/[id]/download/route");

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

describe.skipIf(!hasTestDb)("reports API (real database)", () => {
  let alice: string;
  let bob: string;
  let scanId: string;
  let reportId: string;

  beforeAll(async () => {
    await resetDatabase();
    alice = await signUp("alice-reports@example.test");
    bob = await signUp("bob-reports@example.test");
    const project = await (
      await projectsRoute.POST(
        req("/api/v1/projects", alice, "POST", {
          name: "Acme Site / Ü",
          websiteUrl: "example.com",
        }),
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
  });
  afterAll(async () => {
    // Report files written by this test live in the configured storage directory.
    await createLocalStorage(getConfig().storageDirAbsolute).removePrefix(`reports/${scanId}`);
    await closeDb();
  });

  const post = (cookie: string, body: unknown, id = scanId) =>
    scanReportsRoute.POST(req(`/api/v1/scans/${id}/reports`, cookie, "POST", body), p(id));

  it("refuses reports of scans that have not finished", async () => {
    const res = await post(alice, { format: "pdf" });
    expect(res.status).toBe(409);
    expect((await res.json()).detail).toMatch(/has not started yet/);
  });

  it("queues a report of a finished scan and refuses duplicates while it is pending", async () => {
    await getDb()
      .update(schema.scan)
      .set({ status: "completed_with_failures", finishedAt: new Date() })
      .where(eq(schema.scan.id, scanId));
    const res = await post(alice, { format: "pdf" });
    expect(res.status).toBe(202);
    const body = await res.json();
    reportId = body.id;
    expect(body).toMatchObject({
      format: "pdf",
      status: "pending",
      scanNumber: 1,
      downloadUrl: null,
    });
    expect(body).not.toHaveProperty("storageKey");

    const again = await post(alice, { format: "pdf" });
    expect(again.status).toBe(409);
    expect((await post(alice, { format: "md" })).status).toBe(202);
  });

  it("validates the format and the scan", async () => {
    for (const body of [{ format: "docx" }, {}, { format: "PDF" }])
      expect((await post(alice, body)).status).toBe(400);
    expect((await post(alice, { format: "json" }, "not-a-uuid")).status).toBe(404);
    expect((await post(alice, { format: "json" }, crypto.randomUUID())).status).toBe(404);
    expect((await post(bob, { format: "json" })).status).toBe(404);
  });

  it("lists a scan's reports for its owner only", async () => {
    const res = await scanReportsRoute.GET(
      req(`/api/v1/scans/${scanId}/reports`, alice),
      p(scanId),
    );
    const body = await res.json();
    expect(body.total).toBe(2);
    expect(body.items.map((r: { format: string }) => r.format).sort()).toEqual(["md", "pdf"]);
    expect(
      (await scanReportsRoute.GET(req(`/api/v1/scans/${scanId}/reports`, bob), p(scanId))).status,
    ).toBe(404);
  });

  it("does not download a report before it is ready", async () => {
    const res = await downloadRoute.GET(
      req(`/api/v1/reports/${reportId}/download`, alice),
      p(reportId),
    );
    expect(res.status).toBe(409);
  });

  it("downloads a completed report as an attachment, owner only", async () => {
    // Simulates the worker finishing the job (generation itself is tested in the worker).
    const claimed = await reportsRepo.claimNextReport(getDb());
    expect(claimed?.id).toBe(reportId);
    const key = `reports/${scanId}/${reportId}.pdf`;
    const storage = createLocalStorage(getConfig().storageDirAbsolute);
    await storage.put(key, Buffer.from("%PDF-1.7 test"));
    expect(
      await reportsRepo.completeReport(getDb(), reportId, { storageKey: key, sizeBytes: 13 }),
    ).toBe(true);

    const status = await (
      await reportRoute.GET(req(`/api/v1/reports/${reportId}`, alice), p(reportId))
    ).json();
    expect(status).toMatchObject({
      status: "completed",
      sizeBytes: 13,
      downloadUrl: `/api/v1/reports/${reportId}/download`,
    });

    const res = await downloadRoute.GET(
      req(`/api/v1/reports/${reportId}/download`, alice),
      p(reportId),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="qa-report-acme-site-u-scan-1.pdf"',
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("%PDF-1.7 test");

    for (const route of [
      () => downloadRoute.GET(req(`/api/v1/reports/${reportId}/download`, bob), p(reportId)),
      () => reportRoute.GET(req(`/api/v1/reports/${reportId}`, bob), p(reportId)),
      () => reportRoute.GET(req(`/api/v1/reports/bad-id`, alice), p("bad-id")),
    ])
      expect((await route()).status).toBe(404);
  });

  it("deletes reports and their files (not while generating)", async () => {
    const key = `reports/${scanId}/${reportId}.pdf`;
    const storage = createLocalStorage(getConfig().storageDirAbsolute);
    expect(
      (await reportRoute.DELETE(req(`/api/v1/reports/${reportId}`, bob, "DELETE"), p(reportId)))
        .status,
    ).toBe(404);
    const res = await reportRoute.DELETE(
      req(`/api/v1/reports/${reportId}`, alice, "DELETE"),
      p(reportId),
    );
    expect(res.status).toBe(204);
    expect(await storage.exists(key)).toBe(false);

    const running = await reportsRepo.claimNextReport(getDb()); // the queued Markdown report
    expect(running?.format).toBe("md");
    const conflict = await reportRoute.DELETE(
      req(`/api/v1/reports/${running!.id}`, alice, "DELETE"),
      p(running!.id),
    );
    expect(conflict.status).toBe(409);
  });

  it("fails reports left running by a stopped worker", async () => {
    await getDb()
      .update(schema.report)
      .set({ startedAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(schema.report.status, "running"));
    const recovered = await reportsRepo.recoverStaleReports(getDb(), 5 * 60_000);
    expect(recovered).toHaveLength(1);
    const [row] = await getDb()
      .select()
      .from(schema.report)
      .where(eq(schema.report.id, recovered[0]!));
    expect(row).toMatchObject({ status: "failed" });
    expect(row!.error).toMatch(/interrupted/);
  });
});
