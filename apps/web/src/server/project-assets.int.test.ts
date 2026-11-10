import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { closeDb, getDb, schema } from "@qa/db";
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
const linksRoute = await import("@/app/api/v1/projects/[id]/page-links/route");
const linkRoute = await import("@/app/api/v1/projects/[id]/page-links/[linkId]/route");
const fontsRoute = await import("@/app/api/v1/projects/[id]/fonts/route");
const fontRoute = await import("@/app/api/v1/projects/[id]/fonts/[fontId]/route");
const docsRoute = await import("@/app/api/v1/projects/[id]/content-documents/route");
const docRoute = await import("@/app/api/v1/content-documents/[id]/route");
const guidelineRoute = await import("@/app/api/v1/projects/[id]/guideline-documents/route");
const referenceRoute = await import("@/app/api/v1/projects/[id]/references/[refId]/route");
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
const req = (url: string, cookie: string, method = "GET", body?: unknown) =>
  new NextRequest(`${APP}${url}`, {
    method,
    headers: {
      cookie,
      origin: APP,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
const upload = (url: string, cookie: string, name: string, bytes: Buffer, type = "") => {
  const form = new FormData();
  form.append("file", new File([new Uint8Array(bytes)], name, { type }));
  return new NextRequest(`${APP}${url}`, {
    method: "POST",
    headers: { cookie, origin: APP },
    body: form,
  });
};
const p = (id: string) => ({ params: Promise.resolve({ id }) });

// Real, openly licensed font (Geist, SIL OFL) shipped with Next.js: test data only.
const geist = path.resolve(
  import.meta.dirname,
  "../../../../node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf",
);

describe.skipIf(!hasTestDb)("page links, brand fonts and duplicate uploads (real database)", () => {
  let alice: string;
  let bob: string;
  const cleanup: Array<() => Promise<unknown>> = [];

  beforeAll(async () => {
    await resetDatabase();
    alice = await signUp("alice-assets@example.test");
    bob = await signUp("bob-assets@example.test");
  });
  afterAll(async () => {
    for (const fn of cleanup) await fn().catch(() => {});
    await closeDb();
  });

  const createProject = async (body: Record<string, unknown>) =>
    projectsRoute.POST(req("/api/v1/projects", alice, "POST", body), {});

  it("creates a project without any optional input (the required fields still suffice)", async () => {
    const res = await createProject({ name: "Plain", websiteUrl: "example.com" });
    expect(res.status).toBe(201);
    const id = (await res.json()).id as string;
    const links = await linksRoute.GET(req(`/api/v1/projects/${id}/page-links`, alice), p(id));
    expect((await links.json()).items).toEqual([]);
    const fonts = await fontsRoute.GET(req(`/api/v1/projects/${id}/fonts`, alice), p(id));
    expect((await fonts.json()).items).toEqual([]);
  });

  it("stores page links given at creation, and rejects invalid lists without creating anything", async () => {
    const before = (await getDb().select().from(schema.project)).length;
    const bad = await createProject({
      name: "Bad links",
      websiteUrl: "https://www.example.com",
      pageLinks: ["/about", "https://other.org/x"],
    });
    expect(bad.status).toBe(400);
    const problem = await bad.json();
    expect(problem.errors).toEqual([
      expect.objectContaining({
        path: "pageLinks.1",
        message: expect.stringContaining("other.org"),
      }),
    ]);
    const dup = await createProject({
      name: "Duplicate links",
      websiteUrl: "https://www.example.com",
      pageLinks: ["/about", "https://example.com/about/"],
    });
    expect(dup.status).toBe(400);
    expect((await getDb().select().from(schema.project)).length).toBe(before);

    const ok = await createProject({
      name: "With links",
      websiteUrl: "https://www.example.com",
      pageLinks: ["/about", "https://www.example.com/services", "/contact?ref=a#form"],
    });
    expect(ok.status).toBe(201);
    const id = (await ok.json()).id as string;
    const items = (
      await (await linksRoute.GET(req(`/api/v1/projects/${id}/page-links`, alice), p(id))).json()
    ).items;
    expect(items.map((l: { path: string }) => l.path)).toEqual([
      "/about",
      "/services",
      "/contact?ref=a",
    ]);
  });

  it("adds, de-duplicates, validates and removes page links; other users cannot touch them", async () => {
    const id = (
      await (await createProject({ name: "Links", websiteUrl: "https://shop.example.com" })).json()
    ).id as string;
    const add = (url: string, who = alice) =>
      linksRoute.POST(req(`/api/v1/projects/${id}/page-links`, who, "POST", { url }), p(id));
    const a = await add("/about");
    expect(a.status).toBe(201);
    const about = await a.json();
    expect(about).toMatchObject({ path: "/about", url: "https://shop.example.com/about" });
    expect((await add("/services")).status).toBe(201);

    const dup = await add("https://shop.example.com/about/");
    expect(dup.status).toBe(409);
    expect((await dup.json()).detail).toContain("already in the list (/about)");
    const other = await add("https://evil.example.org/");
    expect(other.status).toBe(400);
    expect((await other.json()).errors[0]).toMatchObject({ path: "url" });
    expect((await add("/files/report.pdf")).status).toBe(400);
    // SSRF rules: internal addresses are rejected even when written as a page of the site.
    const internal = (
      await (await createProject({ name: "IP", websiteUrl: "https://93.184.216.34" })).json()
    ).id as string;
    const ip = await linksRoute.POST(
      req(`/api/v1/projects/${internal}/page-links`, alice, "POST", {
        url: "http://169.254.169.254/latest",
      }),
      p(internal),
    );
    expect(ip.status).toBe(400);

    expect((await add("/about", bob)).status).toBe(404);
    const del = (linkId: string, who = alice) =>
      linkRoute.DELETE(req(`/api/v1/projects/${id}/page-links/${linkId}`, who, "DELETE"), {
        params: Promise.resolve({ id, linkId }),
      });
    expect((await del(about.id, bob)).status).toBe(404);
    expect((await del(about.id)).status).toBe(204);
    expect((await del(about.id)).status).toBe(404);
    const rest = (
      await (await linksRoute.GET(req(`/api/v1/projects/${id}/page-links`, alice), p(id))).json()
    ).items;
    expect(rest.map((l: { path: string }) => l.path)).toEqual(["/services"]);
  });

  it.skipIf(!existsSync(geist))(
    "uploads, validates, de-duplicates and removes brand fonts",
    async () => {
      const id = (await (await createProject({ name: "Fonts", websiteUrl: "example.com" })).json())
        .id as string;
      const url = `/api/v1/projects/${id}/fonts`;
      const bytes = readFileSync(geist);
      const res = await fontsRoute.POST(
        upload(url, alice, "Geist-Regular.ttf", bytes, "font/ttf"),
        p(id),
      );
      expect(res.status).toBe(201);
      const font = await res.json();
      cleanup.push(() =>
        fontRoute.DELETE(req(`${url}/${font.id}`, alice, "DELETE"), {
          params: Promise.resolve({ id, fontId: font.id }),
        }),
      );
      expect(font).toMatchObject({ family: "Geist", style: "Regular", weight: 400, format: "ttf" });
      const [row] = await getDb()
        .select()
        .from(schema.projectFont)
        .where(eq(schema.projectFont.id, font.id));
      expect(row!.storageKey).toMatch(new RegExp(`^projects/${id}/fonts/[0-9a-f-]{36}\\.ttf$`));

      // Same bytes again (any name): refused, no second record.
      const again = await fontsRoute.POST(upload(url, alice, "copy.ttf", bytes), p(id));
      expect(again.status).toBe(409);
      expect((await again.json()).detail).toContain("already uploaded");
      // Not a font, wrong container, unsupported extension.
      expect(
        (await fontsRoute.POST(upload(url, alice, "fake.woff2", Buffer.from("<html>")), p(id)))
          .status,
      ).toBe(400);
      expect(
        (
          await fontsRoute.POST(
            upload(url, alice, "font.ttf", Buffer.from("wOF2" + "x".repeat(60))),
            p(id),
          )
        ).status,
      ).toBe(400);
      expect((await fontsRoute.POST(upload(url, alice, "font.svg", bytes), p(id))).status).toBe(
        400,
      );
      expect(
        (await fontsRoute.POST(upload(url, bob, "Geist-Regular.ttf", bytes), p(id))).status,
      ).toBe(404);
      const list = (await (await fontsRoute.GET(req(url, alice), p(id))).json()).items;
      expect(list).toHaveLength(1);

      // The scan freezes the font names and page links (never the files).
      await linksRoute.POST(
        req(`/api/v1/projects/${id}/page-links`, alice, "POST", { url: "/pricing" }),
        p(id),
      );
      const scan = await scansRoute.POST(
        req(`/api/v1/projects/${id}/scans`, alice, "POST", { authorizationAttested: true }),
        p(id),
      );
      expect(scan.status).toBe(201);
      const scanId = (await scan.json()).id as string;
      const [stored] = await getDb().select().from(schema.scan).where(eq(schema.scan.id, scanId));
      expect(stored!.configSnapshot).toMatchObject({
        scanners: expect.arrayContaining(["design_quality"]),
        pageLinks: ["https://example.com/pricing"],
        approvedFonts: [
          expect.objectContaining({
            filename: "Geist-Regular.ttf",
            families: expect.arrayContaining(["Geist", "Geist-Regular"]),
          }),
        ],
      });
      const steps = await getDb()
        .select()
        .from(schema.scannerRun)
        .where(eq(schema.scannerRun.scanId, scanId));
      const order = steps.sort((a, b) => a.position - b.position).map((s) => s.stepKey);
      expect(order.indexOf("design_quality")).toBeGreaterThan(order.indexOf("content"));
      expect(order.indexOf("design_quality")).toBeLessThan(order.indexOf("ai"));
      await cancelRoute.POST(req(`/api/v1/scans/${scanId}/cancel`, alice, "POST"), p(scanId));

      const del = await fontRoute.DELETE(req(`${url}/${font.id}`, alice, "DELETE"), {
        params: Promise.resolve({ id, fontId: font.id }),
      });
      expect(del.status).toBe(204);
      expect((await (await fontsRoute.GET(req(url, alice), p(id))).json()).items).toEqual([]);
    },
  );

  it("refuses to store the same content document or brand guideline twice", async () => {
    const id = (await (await createProject({ name: "Docs", websiteUrl: "example.com" })).json())
      .id as string;
    const text = Buffer.from("# Home\n\nApproved copy for the home page.\n");
    const first = await docsRoute.POST(
      upload(`/api/v1/projects/${id}/content-documents`, alice, "copy.md", text),
      p(id),
    );
    expect(first.status).toBe(201);
    const doc = await first.json();
    cleanup.push(() =>
      docRoute.DELETE(req(`/api/v1/content-documents/${doc.id}`, alice, "DELETE"), p(doc.id)),
    );
    const second = await docsRoute.POST(
      upload(`/api/v1/projects/${id}/content-documents`, alice, "copy-again.md", text),
      p(id),
    );
    expect(second.status).toBe(409);
    expect((await second.json()).detail).toContain("“copy.md”");

    const guide = Buffer.from("Brand guideline\n\nPrimary — #1A56DB\n");
    const g1 = await guidelineRoute.POST(
      upload(`/api/v1/projects/${id}/guideline-documents`, alice, "brand.txt", guide),
      p(id),
    );
    expect(g1.status).toBe(201);
    const ref = await g1.json();
    cleanup.push(() =>
      referenceRoute.DELETE(req(`/api/v1/projects/${id}/references/${ref.id}`, alice, "DELETE"), {
        params: Promise.resolve({ id, refId: ref.id }),
      }),
    );
    const g2 = await guidelineRoute.POST(
      upload(`/api/v1/projects/${id}/guideline-documents`, alice, "brand-copy.txt", guide),
      p(id),
    );
    expect(g2.status).toBe(409);
  });
});
