import { and, asc, count, eq } from "drizzle-orm";
import type { Database } from "../client";
import { projectFont } from "../schema";

const columns = {
  id: projectFont.id,
  filename: projectFont.filename,
  format: projectFont.format,
  mimeType: projectFont.mimeType,
  sizeBytes: projectFont.sizeBytes,
  sha256: projectFont.sha256,
  metadata: projectFont.metadata,
  createdAt: projectFont.createdAt,
};

export type ProjectFontRow = Awaited<ReturnType<typeof listFonts>>[number];

/** Callers must have verified project ownership first. */
export async function listFonts(db: Database, projectId: string) {
  return db
    .select(columns)
    .from(projectFont)
    .where(eq(projectFont.projectId, projectId))
    .orderBy(asc(projectFont.createdAt), asc(projectFont.filename));
}

export async function countFonts(db: Database, projectId: string) {
  const [row] = await db
    .select({ n: count() })
    .from(projectFont)
    .where(eq(projectFont.projectId, projectId));
  return row?.n ?? 0;
}

export async function findFontBySha(db: Database, projectId: string, sha256: string) {
  const [row] = await db
    .select(columns)
    .from(projectFont)
    .where(and(eq(projectFont.projectId, projectId), eq(projectFont.sha256, sha256)));
  return row ?? null;
}

/** Inserts a validated font; returns null when the same file is already attached (race). */
export async function insertFont(
  db: Database,
  projectId: string,
  values: {
    filename: string;
    format: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    storageKey: string;
    metadata: Record<string, unknown>;
  },
) {
  const [row] = await db
    .insert(projectFont)
    .values({ projectId, ...values })
    .onConflictDoNothing({ target: [projectFont.projectId, projectFont.sha256] })
    .returning(columns);
  return row ?? null;
}

/** Deletes a font; returns its storage key so the caller can remove the file. */
export async function deleteFont(db: Database, projectId: string, id: string) {
  const [row] = await db
    .delete(projectFont)
    .where(and(eq(projectFont.projectId, projectId), eq(projectFont.id, id)))
    .returning({ id: projectFont.id, storageKey: projectFont.storageKey });
  return row ?? null;
}
