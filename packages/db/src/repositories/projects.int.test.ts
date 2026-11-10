import { defaultScanDefaults } from "@qa/core";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createTestUser, hasTestDb, resetDatabase } from "../../../../tests/setup/db";
import { closeDb, getDb } from "../client";
import { issueTrack, scan } from "../schema";
import {
  countOwnerProjects,
  createProject,
  escapeLike,
  getProject,
  listProjects,
  softDeleteProject,
  updateProject,
} from "./projects";

const values = (name: string, websiteUrl = "https://example.com/") => ({
  name,
  websiteUrl,
  scanDefaults: defaultScanDefaults(),
});

describe.skipIf(!hasTestDb)("projects repository (real PostgreSQL)", () => {
  const db = () => getDb();

  beforeEach(() => resetDatabase());
  afterAll(() => closeDb());

  it("creates a project and reads it back with defaults and empty counts", async () => {
    const owner = await createTestUser();
    const created = await createProject(db(), owner.id, values("Marketing site"));
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);

    const fetched = await getProject(db(), owner.id, created.id);
    expect(fetched).toMatchObject({
      name: "Marketing site",
      websiteUrl: "https://example.com/",
      isDemo: false,
      lastScan: null,
    });
    // Six original scanners plus Design Quality & Typography (default on for new projects).
    expect(fetched!.scanDefaults.scanners).toHaveLength(7);
    expect(fetched!.issueCounts.total).toBe(0);
  });

  it("isolates projects between users for read, update and delete", async () => {
    const alice = await createTestUser("Alice");
    const bob = await createTestUser("Bob");
    const p = await createProject(db(), alice.id, values("Alice project"));

    expect(await getProject(db(), bob.id, p.id)).toBeUndefined();
    expect(await updateProject(db(), bob.id, p.id, { name: "hijacked" })).toBeUndefined();
    expect(await softDeleteProject(db(), bob.id, p.id)).toBe(false);
    expect((await listProjects(db(), bob.id, { page: 1, pageSize: 20 })).total).toBe(0);

    expect((await getProject(db(), alice.id, p.id))!.name).toBe("Alice project");
  });

  it("updates fields and bumps updatedAt", async () => {
    const owner = await createTestUser();
    const p = await createProject(db(), owner.id, values("Old"));
    const updated = await updateProject(db(), owner.id, p.id, {
      name: "New",
      scanDefaults: { ...defaultScanDefaults(), scanners: ["seo"], maxPages: 5 },
    });
    expect(updated).toMatchObject({ name: "New" });
    expect(updated!.scanDefaults).toMatchObject({ scanners: ["seo"], maxPages: 5 });
    expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(p.updatedAt.getTime());
  });

  it("soft-deletes so the project disappears from reads and lists", async () => {
    const owner = await createTestUser();
    const p = await createProject(db(), owner.id, values("Temp"));
    expect(await softDeleteProject(db(), owner.id, p.id)).toBe(true);
    expect(await getProject(db(), owner.id, p.id)).toBeUndefined();
    expect(await softDeleteProject(db(), owner.id, p.id)).toBe(false);
    expect(await countOwnerProjects(db(), owner.id)).toBe(0);
  });

  it("searches by name or URL (wildcards matched literally) and paginates newest first", async () => {
    const owner = await createTestUser();
    for (const n of ["Alpha", "Beta", "Gamma 100%"]) {
      await createProject(
        db(),
        owner.id,
        values(n, `https://${n.split(" ")[0]!.toLowerCase()}.example.com/`),
      );
    }
    const byName = await listProjects(db(), owner.id, { q: "alp", page: 1, pageSize: 20 });
    expect(byName.items.map((i) => i.name)).toEqual(["Alpha"]);

    const byUrl = await listProjects(db(), owner.id, { q: "beta.example", page: 1, pageSize: 20 });
    expect(byUrl.items.map((i) => i.name)).toEqual(["Beta"]);

    const literalPercent = await listProjects(db(), owner.id, { q: "%", page: 1, pageSize: 20 });
    expect(literalPercent.items.map((i) => i.name)).toEqual(["Gamma 100%"]);

    const page1 = await listProjects(db(), owner.id, { page: 1, pageSize: 2 });
    const page2 = await listProjects(db(), owner.id, { page: 2, pageSize: 2 });
    expect(page1.total).toBe(3);
    expect(page1.items.map((i) => i.name)).toEqual(["Gamma 100%", "Beta"]);
    expect(page2.items.map((i) => i.name)).toEqual(["Alpha"]);
  });

  it("excludes demo projects from the real workspace", async () => {
    const owner = await createTestUser();
    await createProject(db(), owner.id, { ...values("Demo"), isDemo: true });
    await createProject(db(), owner.id, values("Real"));
    const real = await listProjects(db(), owner.id, { page: 1, pageSize: 20 });
    const demo = await listProjects(db(), owner.id, { page: 1, pageSize: 20, isDemo: true });
    expect(real.items.map((i) => i.name)).toEqual(["Real"]);
    expect(demo.items.map((i) => i.name)).toEqual(["Demo"]);
  });

  it("computes issue counts and last scan from stored rows", async () => {
    const owner = await createTestUser();
    const p = await createProject(db(), owner.id, values("Counted"));
    const [s1] = await db()
      .insert(scan)
      .values({ projectId: p.id, number: 1, status: "completed", configSnapshot: {} })
      .returning();
    const [s2] = await db()
      .insert(scan)
      .values({
        projectId: p.id,
        number: 2,
        status: "running",
        configSnapshot: {},
        createdAt: new Date(Date.now() + 1000),
      })
      .returning();
    const track = (
      n: number,
      status: "open" | "resolved" | "in_progress" | "ignored",
      severity: "critical" | "high" | "low",
    ) => ({
      projectId: p.id,
      displayNo: n,
      fingerprint: `fp-${n}`,
      status,
      severity,
      category: "seo",
      title: `Issue ${n}`,
      firstSeenScanId: s1!.id,
      lastSeenScanId: s1!.id,
    });
    await db()
      .insert(issueTrack)
      .values([
        track(1, "open", "critical"),
        track(2, "in_progress", "high"),
        track(3, "resolved", "critical"),
        track(4, "ignored", "low"),
      ]);

    const summary = await getProject(db(), owner.id, p.id);
    expect(summary!.issueCounts).toMatchObject({
      total: 4,
      open: 1,
      inProgress: 1,
      resolved: 1,
      ignored: 1,
      critical: 1, // the resolved critical issue is not outstanding
      high: 1,
      low: 0, // ignored issues are not outstanding
    });
    expect(summary!.lastScan).toMatchObject({ id: s2!.id, number: 2, status: "running" });
  });
});

describe("escapeLike", () => {
  it("escapes LIKE wildcards", () => {
    expect(escapeLike("50%_off\\")).toBe("50\\%\\_off\\\\");
  });
});
