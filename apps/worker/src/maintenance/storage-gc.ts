import { lstat, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { schema, type Database } from "@qa/db";
import type { Storage } from "@qa/storage";
import { eq, inArray } from "drizzle-orm";

/**
 * Storage garbage collection. Files are written by the application under three roots:
 *   scans/<scanId>/…                         captures, snapshots (scan rows)
 *   reports/<scanId>/<reportId>.<ext>        generated reports (report rows)
 *   projects/<projectId>/{documents,guidelines}/<uuid>.<ext>   uploads (document/reference rows)
 * Rows can disappear without their files (database cascades, e.g. a deleted user; a failed file
 * removal). This finds files no row references any more. It never touches anything it does not
 * recognize, nothing newer than `minAgeMs` (uploads are stored just before their row is
 * inserted), and soft-deleted projects only when asked to.
 */

export interface StorageEntry {
  key: string;
  kind: "dir" | "file";
  sizeBytes: number;
  /** Newest modification time inside the entry. */
  modifiedAt: Date;
}

export interface GcFacts {
  /** Existing scans and whether their project is soft-deleted. */
  scans: Map<string, { projectDeleted: boolean }>;
  /** Existing reports and their storage key. */
  reports: Map<string, string | null>;
  /** Existing projects and whether they are soft-deleted. */
  projects: Map<string, { deleted: boolean }>;
  /** Storage keys of uploads that rows still reference. */
  referencedUploads: Set<string>;
}

export interface GcCandidate {
  key: string;
  kind: "dir" | "file";
  sizeBytes: number;
  reason: string;
}

export interface GcPlan {
  remove: GcCandidate[];
  /** Entries that would be removed but are newer than the minimum age. */
  tooRecent: GcCandidate[];
  /** Entries this collector does not recognize (reported, never removed). */
  unknown: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REPORT_FILE = /^([0-9a-f-]{36})\.(pdf|md|json)$/;
const UPLOAD_FILE = /^[0-9a-f-]{36}\.(pdf|docx|txt|md)$/;
/** Left behind only if the process died between writing and removing a readiness probe. */
const PROBE_FILE = /^\.healthcheck-[0-9a-f-]{36}$/;

async function measure(full: string): Promise<{ sizeBytes: number; modifiedAt: Date }> {
  const info = await lstat(full);
  if (info.isSymbolicLink()) return { sizeBytes: 0, modifiedAt: info.mtime };
  if (!info.isDirectory()) return { sizeBytes: info.size, modifiedAt: info.mtime };
  let sizeBytes = 0;
  let newest = info.mtime;
  for (const name of await readdir(full)) {
    const child = await measure(path.join(full, name));
    sizeBytes += child.sizeBytes;
    if (child.modifiedAt > newest) newest = child.modifiedAt;
  }
  return { sizeBytes, modifiedAt: newest };
}

async function list(dir: string): Promise<Array<{ name: string; dir: boolean; link: boolean }>> {
  try {
    const names = await readdir(dir);
    return Promise.all(
      names.map(async (name) => {
        const info = await lstat(path.join(dir, name));
        return { name, dir: info.isDirectory(), link: info.isSymbolicLink() };
      }),
    );
  } catch {
    return [];
  }
}

/** Lists the entries the collector reasons about (symbolic links are reported as unknown). */
export async function listStorage(
  root: string,
): Promise<{ entries: StorageEntry[]; unknown: string[] }> {
  const entries: StorageEntry[] = [];
  const unknown: string[] = [];
  const add = async (key: string, kind: "dir" | "file") =>
    entries.push({ key, kind, ...(await measure(path.join(root, ...key.split("/")))) });

  for (const top of await list(root)) {
    if (top.link) unknown.push(top.name);
    else if (PROBE_FILE.test(top.name) && !top.dir) await add(top.name, "file");
    else if (top.name === "scans" && top.dir) {
      for (const s of await list(path.join(root, "scans")))
        if (s.dir && !s.link && UUID.test(s.name)) await add(`scans/${s.name}`, "dir");
        else unknown.push(`scans/${s.name}`);
    } else if (top.name === "reports" && top.dir) {
      for (const s of await list(path.join(root, "reports"))) {
        if (!s.dir || s.link || !UUID.test(s.name)) {
          unknown.push(`reports/${s.name}`);
          continue;
        }
        await add(`reports/${s.name}`, "dir");
        for (const f of await list(path.join(root, "reports", s.name)))
          if (!f.dir && !f.link && REPORT_FILE.test(f.name))
            await add(`reports/${s.name}/${f.name}`, "file");
          else unknown.push(`reports/${s.name}/${f.name}`);
      }
    } else if (top.name === "projects" && top.dir) {
      for (const p of await list(path.join(root, "projects"))) {
        if (!p.dir || p.link || !UUID.test(p.name)) {
          unknown.push(`projects/${p.name}`);
          continue;
        }
        await add(`projects/${p.name}`, "dir");
        for (const folder of await list(path.join(root, "projects", p.name))) {
          if (!folder.dir || folder.link || !["documents", "guidelines"].includes(folder.name)) {
            unknown.push(`projects/${p.name}/${folder.name}`);
            continue;
          }
          for (const f of await list(path.join(root, "projects", p.name, folder.name)))
            if (!f.dir && !f.link && UPLOAD_FILE.test(f.name))
              await add(`projects/${p.name}/${folder.name}/${f.name}`, "file");
            else unknown.push(`projects/${p.name}/${folder.name}/${f.name}`);
        }
      }
    } else unknown.push(top.name);
  }
  return { entries, unknown };
}

/** Loads the rows that decide whether the listed entries are still referenced. */
export async function loadGcFacts(db: Database, entries: StorageEntry[]): Promise<GcFacts> {
  const idsUnder = (prefix: string) => [
    ...new Set(
      entries
        .map((e) => e.key.split("/"))
        .filter((parts) => parts[0] === prefix && parts[1] && UUID.test(parts[1]))
        .map((parts) => parts[1]!),
    ),
  ];
  const reportIds = entries
    .map((e) => REPORT_FILE.exec(e.key.split("/")[2] ?? "")?.[1])
    .filter((id): id is string => Boolean(id && UUID.test(id)));
  const scanIds = [...new Set([...idsUnder("scans"), ...idsUnder("reports")])];
  const projectIds = idsUnder("projects");
  const chunks = <T>(items: T[]) =>
    Array.from({ length: Math.ceil(items.length / 1000) }, (_, i) =>
      items.slice(i * 1000, (i + 1) * 1000),
    );

  const facts: GcFacts = {
    scans: new Map(),
    reports: new Map(),
    projects: new Map(),
    referencedUploads: new Set(),
  };
  for (const ids of chunks(scanIds)) {
    const rows = await db
      .select({ id: schema.scan.id, deletedAt: schema.project.deletedAt })
      .from(schema.scan)
      .innerJoin(schema.project, eq(schema.project.id, schema.scan.projectId))
      .where(inArray(schema.scan.id, ids));
    for (const r of rows) facts.scans.set(r.id, { projectDeleted: r.deletedAt !== null });
  }
  for (const ids of chunks(reportIds)) {
    const rows = await db
      .select({ id: schema.report.id, storageKey: schema.report.storageKey })
      .from(schema.report)
      .where(inArray(schema.report.id, ids));
    for (const r of rows) facts.reports.set(r.id, r.storageKey);
  }
  for (const ids of chunks(projectIds)) {
    const rows = await db
      .select({ id: schema.project.id, deletedAt: schema.project.deletedAt })
      .from(schema.project)
      .where(inArray(schema.project.id, ids));
    for (const r of rows) facts.projects.set(r.id, { deleted: r.deletedAt !== null });
    const docs = await db
      .select({ key: schema.contentDocument.storageKey })
      .from(schema.contentDocument)
      .where(inArray(schema.contentDocument.projectId, ids));
    const refs = await db
      .select({ key: schema.referenceSource.storageKey })
      .from(schema.referenceSource)
      .where(inArray(schema.referenceSource.projectId, ids));
    for (const r of [...docs, ...refs]) if (r.key) facts.referencedUploads.add(r.key);
  }
  return facts;
}

/** Decides what can be removed (pure; see the module comment for the rules). */
export function planStorageGc(
  listing: { entries: StorageEntry[]; unknown: string[] },
  facts: GcFacts,
  opts: { now: Date; minAgeMs: number; includeDeletedProjects: boolean },
): GcPlan {
  const plan: GcPlan = { remove: [], tooRecent: [], unknown: [...listing.unknown] };
  const removedDirs: string[] = [];
  const insideRemoved = (key: string) => removedDirs.some((d) => key.startsWith(`${d}/`));
  const consider = (e: StorageEntry, reason: string) => {
    const c = { key: e.key, kind: e.kind, sizeBytes: e.sizeBytes, reason };
    if (opts.now.getTime() - e.modifiedAt.getTime() < opts.minAgeMs) plan.tooRecent.push(c);
    else {
      plan.remove.push(c);
      if (e.kind === "dir") removedDirs.push(e.key);
    }
  };
  // Directories first, so files inside a removed directory are not listed twice.
  const ordered = [...listing.entries].sort(
    (a, b) => a.key.split("/").length - b.key.split("/").length,
  );
  for (const e of ordered) {
    if (insideRemoved(e.key)) continue;
    const parts = e.key.split("/");
    if (PROBE_FILE.test(parts[0]!)) consider(e, "leftover readiness probe file");
    else if (parts[0] === "scans") {
      const scan = facts.scans.get(parts[1]!);
      if (!scan) consider(e, "scan no longer exists");
      else if (scan.projectDeleted && opts.includeDeletedProjects) consider(e, "project deleted");
    } else if (parts[0] === "reports" && parts.length === 2) {
      const scan = facts.scans.get(parts[1]!);
      if (!scan) consider(e, "scan no longer exists");
      else if (scan.projectDeleted && opts.includeDeletedProjects) consider(e, "project deleted");
    } else if (parts[0] === "reports" && parts.length === 3) {
      const reportId = REPORT_FILE.exec(parts[2]!)![1]!;
      if (facts.reports.get(reportId) !== e.key) consider(e, "report no longer exists");
    } else if (parts[0] === "projects" && parts.length === 2) {
      const project = facts.projects.get(parts[1]!);
      if (!project) consider(e, "project no longer exists");
      else if (project.deleted && opts.includeDeletedProjects) consider(e, "project deleted");
    } else if (parts[0] === "projects" && parts.length === 4) {
      if (!facts.referencedUploads.has(e.key)) consider(e, "upload no longer referenced");
    }
  }
  return plan;
}

export interface GcResult extends GcPlan {
  applied: boolean;
  removedBytes: number;
  failed: Array<{ key: string; error: string }>;
}

/** Lists, plans and (with `apply`) removes. Without `apply` nothing is changed (dry run). */
export async function collectStorageGarbage(opts: {
  db: Database;
  storage: Storage;
  root: string;
  apply: boolean;
  minAgeMs: number;
  includeDeletedProjects: boolean;
  now?: Date;
}): Promise<GcResult> {
  const listing = await listStorage(opts.root);
  const facts = await loadGcFacts(opts.db, listing.entries);
  const plan = planStorageGc(listing, facts, {
    now: opts.now ?? new Date(),
    minAgeMs: opts.minAgeMs,
    includeDeletedProjects: opts.includeDeletedProjects,
  });
  const result: GcResult = { ...plan, applied: opts.apply, removedBytes: 0, failed: [] };
  if (!opts.apply) return result;
  for (const c of plan.remove) {
    try {
      // removePrefix validates the key and stays inside the storage root. Probe files (dot
      // names, not valid storage keys) are matched by their exact pattern before removal.
      if (PROBE_FILE.test(c.key)) await rm(path.join(opts.root, c.key), { force: true });
      else await opts.storage.removePrefix(c.key);
      result.removedBytes += c.sizeBytes;
    } catch (err) {
      result.failed.push({ key: c.key, error: (err as Error).message });
    }
  }
  return result;
}
