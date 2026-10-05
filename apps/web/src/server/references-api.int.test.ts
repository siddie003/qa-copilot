import { readFileSync } from "node:fs";
import { createLogger, getConfig } from "@qa/core";
import { closeDb, getDb, schema } from "@qa/db";
import { createLocalStorage } from "@qa/storage";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { processNextReferenceJob } from "../../../worker/src/references/process";
import { hasTestDb, resetDatabase } from "../../../../tests/setup/db";

vi.mock("server-only", () => ({}));

const APP = "http://localhost:3000";
const { createAuth } = await import("./auth");
(globalThis as { __qaAuth?: unknown }).__qaAuth = hasTestDb
  ? createAuth({ withNextCookies: false })
  : undefined;
const { getAuth } = await import("./auth");
const projectsRoute = await import("@/app/api/v1/projects/route");
const docsRoute = await import("@/app/api/v1/projects/[id]/content-documents/route");
const docRoute = await import("@/app/api/v1/content-documents/[id]/route");
const blocksRoute = await import("@/app/api/v1/content-documents/[id]/blocks/route");
const retryRoute = await import("@/app/api/v1/content-documents/[id]/retry/route");
const specRoute = await import("@/app/api/v1/projects/[id]/design-spec/route");
const draftRoute = await import("@/app/api/v1/projects/[id]/design-spec/draft/route");
const confirmRoute = await import("@/app/api/v1/projects/[id]/design-spec/draft/confirm/route");
const guidelineRoute = await import("@/app/api/v1/projects/[id]/guideline-documents/route");
const referencesRoute = await import("@/app/api/v1/projects/[id]/references/route");
const referenceRoute = await import("@/app/api/v1/projects/[id]/references/[refId]/route");
const refreshRoute = await import("@/app/api/v1/projects/[id]/references/[refId]/refresh/route");
const tokenRoute = await import("@/app/api/v1/projects/[id]/figma-token/route");
const scansRoute = await import("@/app/api/v1/projects/[id]/scans/route");
const cancelRoute = await import("@/app/api/v1/scans/[id]/cancel/route");

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
const upload = (
  path: string,
  cookie: string,
  name: string,
  bytes: Buffer,
  fields: Record<string, string> = {},
) => {
  const form = new FormData();
  form.append("file", new File([new Uint8Array(bytes)], name));
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return new NextRequest(`${APP}${path}`, {
    method: "POST",
    headers: { cookie, origin: APP },
    body: form,
  });
};
const p = (id: string) => ({ params: Promise.resolve({ id }) });
const pr = (id: string, refId: string) => ({ params: Promise.resolve({ id, refId }) });
const drain = async () => {
  const rt = {
    db: getDb(),
    storage: createLocalStorage(getConfig().storageDirAbsolute),
    config: getConfig(),
    log: createLogger(),
  };
  while (await processNextReferenceJob(rt)) {
    // process everything queued
  }
};

describe.skipIf(!hasTestDb)("references API (real database)", () => {
  let alice: string;
  let bob: string;
  let projectId: string;
  const created: string[] = [];
  beforeAll(async () => {
    await resetDatabase();
    alice = await signUp("alice-refs@example.test");
    bob = await signUp("bob-refs@example.test");
    const res = await projectsRoute.POST(
      req("/api/v1/projects", alice, "POST", { name: "Refs", websiteUrl: "example.com" }),
      {},
    );
    projectId = (await res.json()).id;
  });
  afterAll(async () => {
    // Remove uploaded files from the shared storage folder.
    for (const id of created)
      await docRoute
        .DELETE(req(`/api/v1/content-documents/${id}`, alice, "DELETE"), p(id))
        .catch(() => {});
    await closeDb();
  });

  it("uploads, validates, processes and maps content documents", async () => {
    const md = readFileSync(
      new URL("../../../../fixtures/documents/approved-content.md", import.meta.url),
    );
    const res = await docsRoute.POST(
      upload(`/api/v1/projects/${projectId}/content-documents`, alice, "approved.md", md, {
        targetPath: "/about",
      }),
      p(projectId),
    );
    expect(res.status).toBe(201);
    const doc = await res.json();
    created.push(doc.id);
    expect(doc).toMatchObject({
      filename: "approved.md",
      parseStatus: "pending",
      targetPath: "/about",
    });
    expect(doc.storageKey).toBeUndefined(); // storage keys never leave the server

    // Content that does not match its extension, bad paths and unsupported types are rejected.
    const fake = await docsRoute.POST(
      upload(
        `/api/v1/projects/${projectId}/content-documents`,
        alice,
        "fake.pdf",
        Buffer.from("<html>"),
      ),
      p(projectId),
    );
    expect(fake.status).toBe(400);
    expect((await fake.json()).detail).toMatch(/not a PDF/);
    const exe = await docsRoute.POST(
      upload(
        `/api/v1/projects/${projectId}/content-documents`,
        alice,
        "run.exe",
        Buffer.from("MZ"),
      ),
      p(projectId),
    );
    expect(exe.status).toBe(400);
    const badPath = await docsRoute.POST(
      upload(`/api/v1/projects/${projectId}/content-documents`, alice, "a.txt", Buffer.from("Hi"), {
        targetPath: "about us",
      }),
      p(projectId),
    );
    expect(badPath.status).toBe(400);
    const big = await docsRoute.POST(
      upload(
        `/api/v1/projects/${projectId}/content-documents`,
        alice,
        "big.txt",
        Buffer.alloc((getConfig().MAX_UPLOAD_MB + 1) * 1024 * 1024, 65),
      ),
      p(projectId),
    );
    expect(big.status).toBe(413);

    // Other users cannot see or touch the document.
    expect(
      (await blocksRoute.GET(req(`/api/v1/content-documents/${doc.id}/blocks`, bob), p(doc.id)))
        .status,
    ).toBe(404);
    expect(
      (await docRoute.DELETE(req(`/api/v1/content-documents/${doc.id}`, bob, "DELETE"), p(doc.id)))
        .status,
    ).toBe(404);
    expect(
      (
        await docsRoute.POST(
          upload(`/api/v1/projects/${projectId}/content-documents`, bob, "x.md", md),
          p(projectId),
        )
      ).status,
    ).toBe(404);

    await drain();
    const blocks = await (
      await blocksRoute.GET(req(`/api/v1/content-documents/${doc.id}/blocks`, alice), p(doc.id))
    ).json();
    expect(blocks.document.blockCount).toBe(13);
    expect(blocks.blocks[0]).toMatchObject({
      type: "heading",
      text: "Contact",
      location: { line: 1 },
    });

    const patched = await docRoute.PATCH(
      req(`/api/v1/content-documents/${doc.id}`, alice, "PATCH", { targetPath: "" }),
      p(doc.id),
    );
    expect(await patched.json()).toMatchObject({ targetPath: null, parseStatus: "parsed" });
    const retry = await retryRoute.POST(
      req(`/api/v1/content-documents/${doc.id}/retry`, alice, "POST"),
      p(doc.id),
    );
    expect(retry.status).toBe(409); // only failed documents can be retried
  });

  it("saves, drafts, confirms and discards design references", async () => {
    const invalid = await specRoute.PUT(
      req(`/api/v1/projects/${projectId}/design-spec`, alice, "PUT", {
        colors: { Brand: { value: "blue" } },
      }),
      p(projectId),
    );
    expect(invalid.status).toBe(400);
    expect(JSON.stringify(await invalid.json())).toMatch(/hex color/);

    const saved = await specRoute.PUT(
      req(`/api/v1/projects/${projectId}/design-spec`, alice, "PUT", {
        typography: { h1: { fontSize: 48 } },
        colors: { Link: { value: "#1A56DB", role: "link" } },
      }),
      p(projectId),
    );
    expect(saved.status).toBe(201);
    expect(await saved.json()).toEqual({ version: 1 });

    const guideline = await guidelineRoute.POST(
      upload(
        `/api/v1/projects/${projectId}/guideline-documents`,
        alice,
        "brand.txt",
        Buffer.from("H2 — Georgia Bold, 32px\n\nLink: #ff0000\n"),
      ),
      p(projectId),
    );
    expect(guideline.status).toBe(201);
    const ref = await guideline.json();
    await drain();

    const state = await (
      await specRoute.GET(req(`/api/v1/projects/${projectId}/design-spec`, alice), p(projectId))
    ).json();
    expect(state.active).toMatchObject({ version: 1, origin: "manual" });
    expect(state.draft).toMatchObject({ version: 2, origin: "document" });
    // The manually entered link color is kept; the document adds h2.
    expect(state.draft.spec.colors.Link.value).toBe("#1a56db");
    expect(state.draft.changes.map((c: { path: string }) => c.path)).toEqual(
      expect.arrayContaining(["typography.h2.fontFamily", "typography.h2.fontSize"]),
    );
    expect(
      (
        await specRoute.PUT(
          req(`/api/v1/projects/${projectId}/design-spec`, alice, "PUT", {}),
          p(projectId),
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await confirmRoute.POST(
          req(`/api/v1/projects/${projectId}/design-spec/draft/confirm`, alice, "POST", {
            version: 1,
          }),
          p(projectId),
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await confirmRoute.POST(
          req(`/api/v1/projects/${projectId}/design-spec/draft/confirm`, bob, "POST", {
            version: 2,
          }),
          p(projectId),
        )
      ).status,
    ).toBe(404);
    const confirmed = await confirmRoute.POST(
      req(`/api/v1/projects/${projectId}/design-spec/draft/confirm`, alice, "POST", { version: 2 }),
      p(projectId),
    );
    expect(await confirmed.json()).toEqual({ version: 2 });
    expect(
      (
        await draftRoute.DELETE(
          req(`/api/v1/projects/${projectId}/design-spec/draft`, alice, "DELETE"),
          p(projectId),
        )
      ).status,
    ).toBe(404);

    // Removing the guideline keeps the confirmed values and deletes the stored file.
    expect(
      (
        await referenceRoute.DELETE(
          req(`/api/v1/projects/${projectId}/references/${ref.id}`, alice, "DELETE"),
          pr(projectId, ref.id),
        )
      ).status,
    ).toBe(204);
    const after = await (
      await specRoute.GET(req(`/api/v1/projects/${projectId}/design-spec`, alice), p(projectId))
    ).json();
    expect(after.active.spec.typography.h2.fontSize).toBe(32);
  });

  it("queues Figma links and stores the Figma token encrypted, never returning it", async () => {
    const add = await referencesRoute.POST(
      req(`/api/v1/projects/${projectId}/references`, alice, "POST", {
        figmaUrl: "https://www.figma.com/design/AbCdEfGh1234/x?node-id=3-1",
      }),
      p(projectId),
    );
    expect(add.status).toBe(201);
    const ref = await add.json();
    expect(ref).toMatchObject({ status: "pending", figmaNodeIds: ["3:1"] });
    expect(
      (
        await refreshRoute.POST(
          req(`/api/v1/projects/${projectId}/references/${ref.id}/refresh`, alice, "POST"),
          pr(projectId, ref.id),
        )
      ).status,
    ).toBe(409);

    const put = await tokenRoute.PUT(
      req(`/api/v1/projects/${projectId}/figma-token`, alice, "PUT", {
        token: "figd_super_secret_token",
      }),
      p(projectId),
    );
    expect(put.status).toBe(204);
    const [secret] = await getDb()
      .select()
      .from(schema.projectSecret)
      .where(eq(schema.projectSecret.kind, "figma_token"));
    expect(secret!.ciphertext).not.toContain("figd_super_secret_token");
    const list = await (
      await referencesRoute.GET(
        req(`/api/v1/projects/${projectId}/references`, alice),
        p(projectId),
      )
    ).text();
    expect(list).not.toContain("figd_super");
    expect(
      (
        await tokenRoute.PUT(
          req(`/api/v1/projects/${projectId}/figma-token`, bob, "PUT", {
            token: "figd_bob_token_123",
          }),
          p(projectId),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await tokenRoute.DELETE(
          req(`/api/v1/projects/${projectId}/figma-token`, alice, "DELETE"),
          p(projectId),
        )
      ).status,
    ).toBe(204);
    expect(
      (
        await referenceRoute.DELETE(
          req(`/api/v1/projects/${projectId}/references/${ref.id}`, bob, "DELETE"),
          pr(projectId, ref.id),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await referenceRoute.DELETE(
          req(`/api/v1/projects/${projectId}/references/${ref.id}`, alice, "DELETE"),
          pr(projectId, ref.id),
        )
      ).status,
    ).toBe(204);
  });

  it("freezes the confirmed spec and parsed documents into a new scan", async () => {
    const res = await scansRoute.POST(
      req(`/api/v1/projects/${projectId}/scans`, alice, "POST", { authorizationAttested: true }),
      p(projectId),
    );
    expect(res.status).toBe(201);
    const scan = await res.json();
    const [row] = await getDb().select().from(schema.scan).where(eq(schema.scan.id, scan.id));
    expect(row!.designSpecId).toBeTruthy();
    expect(row!.contentSnapshotHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.configSnapshot).toMatchObject({
      designSpecVersion: 2,
      contentDocuments: [expect.objectContaining({ filename: "approved.md", blockCount: 13 })],
    });
    const steps = await getDb()
      .select()
      .from(schema.scannerRun)
      .where(eq(schema.scannerRun.scanId, scan.id));
    expect(steps.find((s) => s.stepKey === "design")!.status).toBe("pending");
    expect(steps.find((s) => s.stepKey === "content")!.status).toBe("pending");
    await cancelRoute.POST(req(`/api/v1/scans/${scan.id}/cancel`, alice, "POST"), p(scan.id));
  });
});
