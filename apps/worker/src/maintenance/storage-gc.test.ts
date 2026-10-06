import { describe, expect, it } from "vitest";
import { planStorageGc, type GcFacts, type StorageEntry } from "./storage-gc";

const NOW = new Date("2026-10-05T12:00:00Z");
const OLD = new Date("2026-10-01T12:00:00Z");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const entry = (key: string, kind: "dir" | "file" = "dir", modifiedAt = OLD): StorageEntry => ({
  key,
  kind,
  sizeBytes: 100,
  modifiedAt,
});

const facts = (over: Partial<GcFacts> = {}): GcFacts => ({
  scans: new Map([
    [id(1), { projectDeleted: false }],
    [id(2), { projectDeleted: true }],
  ]),
  reports: new Map([[id(10), `reports/${id(1)}/${id(10)}.pdf`]]),
  projects: new Map([
    [id(20), { deleted: false }],
    [id(21), { deleted: true }],
  ]),
  referencedUploads: new Set([`projects/${id(20)}/documents/${id(30)}.md`]),
  ...over,
});

const plan = (entries: StorageEntry[], includeDeletedProjects = false, unknown: string[] = []) =>
  planStorageGc({ entries, unknown }, facts(), {
    now: NOW,
    minAgeMs: 24 * 3_600_000,
    includeDeletedProjects,
  });

describe("storage garbage collection plan", () => {
  it("keeps everything that rows still reference", () => {
    const p = plan([
      entry(`scans/${id(1)}`),
      entry(`reports/${id(1)}`),
      entry(`reports/${id(1)}/${id(10)}.pdf`, "file"),
      entry(`projects/${id(20)}`),
      entry(`projects/${id(20)}/documents/${id(30)}.md`, "file"),
    ]);
    expect(p.remove).toEqual([]);
  });

  it("removes files of rows that no longer exist, once per directory", () => {
    const p = plan([
      entry(`scans/${id(99)}`),
      entry(`reports/${id(99)}`),
      entry(`reports/${id(99)}/${id(11)}.md`, "file"),
      entry(`reports/${id(1)}/${id(12)}.json`, "file"),
      entry(`projects/${id(98)}`),
      entry(`projects/${id(98)}/guidelines/${id(31)}.pdf`, "file"),
      entry(`projects/${id(20)}/documents/${id(32)}.docx`, "file"),
    ]);
    expect(p.remove.map((c) => [c.key, c.reason])).toEqual([
      [`scans/${id(99)}`, "scan no longer exists"],
      [`reports/${id(99)}`, "scan no longer exists"],
      [`projects/${id(98)}`, "project no longer exists"],
      [`reports/${id(1)}/${id(12)}.json`, "report no longer exists"],
      [`projects/${id(20)}/documents/${id(32)}.docx`, "upload no longer referenced"],
    ]);
  });

  it("leaves soft-deleted projects alone unless asked", () => {
    const entries = [entry(`scans/${id(2)}`), entry(`projects/${id(21)}`)];
    expect(plan(entries).remove).toEqual([]);
    expect(plan(entries, true).remove.map((c) => c.reason)).toEqual([
      "project deleted",
      "project deleted",
    ]);
  });

  it("never removes recent entries or anything it does not recognize", () => {
    const recent = new Date(NOW.getTime() - 60_000);
    const p = plan([entry(`projects/${id(20)}/documents/${id(33)}.md`, "file", recent)], false, [
      "backup.tar",
      "scans/not-a-uuid",
    ]);
    expect(p.remove).toEqual([]);
    expect(p.tooRecent.map((c) => c.reason)).toEqual(["upload no longer referenced"]);
    expect(p.unknown).toEqual(["backup.tar", "scans/not-a-uuid"]);
  });
});
