import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultScanDefaults, planScanSteps } from "@qa/core";
import {
  closeDb,
  contentRepo,
  getDb,
  pipelineRepo,
  projectsRepo,
  reportsRepo,
  schema,
} from "@qa/db";
import { createLocalStorage } from "@qa/storage";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestUser, hasTestDb, resetDatabase } from "../../../../tests/setup/db";
import { collectStorageGarbage } from "./storage-gc";

describe.skipIf(!hasTestDb)("storage garbage collection (real database, temporary folder)", () => {
  let root: string;
  const exists = async (key: string) => {
    const dir = path.join(root, ...key.split("/").slice(0, -1));
    return (await readdir(dir).catch(() => [] as string[])).includes(key.split("/").at(-1)!);
  };
  // Writes a file and backdates it and the folders it created (a folder's own modification
  // time counts as activity, like a file written into it).
  const put = async (key: string, ageHours = 48) => {
    const parts = key.split("/");
    const full = path.join(root, ...parts);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, "x".repeat(1000));
    const t = new Date(Date.now() - ageHours * 3_600_000);
    await utimes(full, t, t);
    for (let i = parts.length - 1; i >= 1; i--)
      await utimes(path.join(root, ...parts.slice(0, i)), t, t);
  };

  beforeAll(async () => {
    await resetDatabase();
    root = await mkdtemp(path.join(os.tmpdir(), "qa-gc-"));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await closeDb();
  });

  it("removes only unreferenced, old enough files; dry run changes nothing", async () => {
    const db = getDb();
    const owner = (await createTestUser()).id;
    const project = await projectsRepo.createProject(db, owner, {
      name: "Kept",
      websiteUrl: "https://example.com/",
      scanDefaults: defaultScanDefaults(),
    });
    const deleted = await projectsRepo.createProject(db, owner, {
      name: "Deleted",
      websiteUrl: "https://example.com/",
      scanDefaults: defaultScanDefaults(),
    });
    const scan = (await pipelineRepo.createScan(db, owner, project.id, {
      configSnapshot: {},
      steps: planScanSteps(["seo"]),
      triggeredByUserId: owner,
    }))!;
    await db.update(schema.scan).set({ status: "completed" }).where(eq(schema.scan.id, scan.id));
    const created = await reportsRepo.createReport(db, owner, scan.id, "md", owner);
    const reportId = (created as { report: { id: string } }).report.id;
    const reportKey = `reports/${scan.id}/${reportId}.md`;
    await db
      .update(schema.report)
      .set({ status: "completed", storageKey: reportKey })
      .where(eq(schema.report.id, reportId));
    const docKey = `projects/${project.id}/documents/${randomUUID()}.md`;
    await contentRepo.insertDocument(db, project.id, {
      filename: "copy.md",
      mimeType: "text/markdown; charset=utf-8",
      sizeBytes: 1000,
      sha256: "0".repeat(64),
      storageKey: docKey,
      targetPath: null,
    });
    const deletedProjectFile = `projects/${deleted.id}/documents/${randomUUID()}.md`;
    await contentRepo.insertDocument(db, deleted.id, {
      filename: "old.md",
      mimeType: "text/markdown; charset=utf-8",
      sizeBytes: 1000,
      sha256: "0".repeat(64),
      storageKey: deletedProjectFile,
      targetPath: null,
    });
    await projectsRepo.softDeleteProject(db, owner, deleted.id);

    const keep = [`scans/${scan.id}/pages/a/desktop.png`, reportKey, docKey];
    const orphans = [
      `scans/${randomUUID()}/pages/a/desktop.png`,
      `reports/${scan.id}/${randomUUID()}.pdf`,
      `projects/${randomUUID()}/guidelines/${randomUUID()}.pdf`,
      `projects/${project.id}/documents/${randomUUID()}.docx`,
    ];
    const recentOrphan = `projects/${project.id}/guidelines/${randomUUID()}.txt`;
    for (const key of [...keep, ...orphans, deletedProjectFile]) await put(key);
    await put(recentOrphan, 0);
    await writeFile(path.join(root, "operator-notes.txt"), "do not touch");

    const run = (apply: boolean, includeDeletedProjects = false) =>
      collectStorageGarbage({
        db,
        storage: createLocalStorage(root),
        root,
        apply,
        minAgeMs: 24 * 3_600_000,
        includeDeletedProjects,
      });

    const dry = await run(false);
    expect(dry.remove).toHaveLength(4);
    for (const key of [...keep, ...orphans]) expect(await exists(key)).toBe(true);

    const applied = await run(true);
    expect(applied.failed).toEqual([]);
    expect(applied.removedBytes).toBeGreaterThanOrEqual(4000);
    for (const key of keep) expect(await exists(key), key).toBe(true);
    for (const key of orphans) expect(await exists(key), key).toBe(false);
    expect(await exists(recentOrphan)).toBe(true);
    expect(await exists(deletedProjectFile)).toBe(true);
    expect(applied.unknown).toContain("operator-notes.txt");
    expect(await exists("operator-notes.txt")).toBe(true);

    // Soft-deleted projects only on request.
    const withDeleted = await run(true, true);
    expect(withDeleted.remove.map((c) => c.reason)).toEqual(["project deleted"]);
    expect(await exists(deletedProjectFile)).toBe(false);
    for (const key of keep) expect(await exists(key), key).toBe(true);
  });
});
