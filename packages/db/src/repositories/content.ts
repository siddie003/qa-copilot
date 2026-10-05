import { and, asc, count, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { Database } from "../client";
import { contentBlock, contentDocument, project } from "../schema";
import { ownedProjects } from "./owned";

/** Channel the worker listens on for new reference work (documents, Figma, guidelines). */
export const REFERENCE_QUEUED_CHANNEL = "reference_queued";

export async function notifyReferenceQueued(db: Database) {
  await db.execute(sql`select pg_notify(${REFERENCE_QUEUED_CHANNEL}, '')`);
}

export type ContentDocumentRow = typeof contentDocument.$inferSelect;

const documentColumns = {
  id: contentDocument.id,
  projectId: contentDocument.projectId,
  filename: contentDocument.filename,
  mimeType: contentDocument.mimeType,
  sizeBytes: contentDocument.sizeBytes,
  sha256: contentDocument.sha256,
  parseStatus: contentDocument.parseStatus,
  parseError: contentDocument.parseError,
  targetPath: contentDocument.targetPath,
  blockCount: contentDocument.blockCount,
  meta: contentDocument.meta,
  createdAt: contentDocument.createdAt,
  updatedAt: contentDocument.updatedAt,
};

/** Callers must have verified project ownership first. */
export async function insertDocument(
  db: Database,
  projectId: string,
  values: {
    filename: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    storageKey: string;
    targetPath: string | null;
  },
) {
  const [row] = await db
    .insert(contentDocument)
    .values({ projectId, ...values, parseStatus: "pending" })
    .returning(documentColumns);
  await notifyReferenceQueued(db);
  return row!;
}

export async function listDocuments(db: Database, projectId: string) {
  return db
    .select(documentColumns)
    .from(contentDocument)
    .where(eq(contentDocument.projectId, projectId))
    .orderBy(asc(contentDocument.createdAt));
}

export async function countDocuments(db: Database, projectId: string) {
  const [row] = await db
    .select({ n: count() })
    .from(contentDocument)
    .where(eq(contentDocument.projectId, projectId));
  return row?.n ?? 0;
}

/** A document of a project the user owns, or null. */
export async function getOwnedDocument(db: Database, ownerId: string, documentId: string) {
  const [row] = await db
    .select({ ...documentColumns, storageKey: contentDocument.storageKey })
    .from(contentDocument)
    .innerJoin(project, eq(project.id, contentDocument.projectId))
    .where(and(eq(contentDocument.id, documentId), ownedProjects(ownerId)));
  return row ?? null;
}

export async function setTargetPath(db: Database, documentId: string, targetPath: string | null) {
  const [row] = await db
    .update(contentDocument)
    .set({ targetPath })
    .where(eq(contentDocument.id, documentId))
    .returning(documentColumns);
  return row ?? null;
}

export async function deleteDocument(db: Database, documentId: string) {
  const [row] = await db
    .delete(contentDocument)
    .where(eq(contentDocument.id, documentId))
    .returning({ storageKey: contentDocument.storageKey });
  return row ?? null;
}

/** Puts a failed document back into the queue. */
export async function requeueDocument(db: Database, documentId: string) {
  const [row] = await db
    .update(contentDocument)
    .set({ parseStatus: "pending", parseError: null, processingStartedAt: null })
    .where(and(eq(contentDocument.id, documentId), eq(contentDocument.parseStatus, "failed")))
    .returning(documentColumns);
  if (row) await notifyReferenceQueued(db);
  return row ?? null;
}

export async function listBlocks(db: Database, documentId: string, limit = 2_000) {
  return db
    .select({
      id: contentBlock.id,
      order: contentBlock.order,
      type: contentBlock.type,
      level: contentBlock.level,
      text: contentBlock.text,
      normalizedText: contentBlock.normalizedText,
      href: contentBlock.href,
      pageHint: contentBlock.pageHint,
      location: contentBlock.location,
    })
    .from(contentBlock)
    .where(eq(contentBlock.documentId, documentId))
    .orderBy(asc(contentBlock.order))
    .limit(limit);
}

/** Blocks of several documents (scan comparison input), in document order. */
export async function loadBlocksForDocuments(db: Database, documentIds: string[]) {
  if (!documentIds.length) return [];
  return db
    .select({
      documentId: contentBlock.documentId,
      order: contentBlock.order,
      type: contentBlock.type,
      level: contentBlock.level,
      text: contentBlock.text,
      normalizedText: contentBlock.normalizedText,
      href: contentBlock.href,
      pageHint: contentBlock.pageHint,
      location: contentBlock.location,
    })
    .from(contentBlock)
    .where(inArray(contentBlock.documentId, documentIds))
    .orderBy(asc(contentBlock.documentId), asc(contentBlock.order));
}

/** Parsed documents of a project (frozen into a scan when it starts). */
export async function listParsedDocuments(db: Database, projectId: string) {
  return db
    .select(documentColumns)
    .from(contentDocument)
    .where(and(eq(contentDocument.projectId, projectId), eq(contentDocument.parseStatus, "parsed")))
    .orderBy(asc(contentDocument.createdAt));
}

export async function documentStatusCounts(db: Database, projectId: string) {
  const rows = await db
    .select({ status: contentDocument.parseStatus, n: count() })
    .from(contentDocument)
    .where(eq(contentDocument.projectId, projectId))
    .groupBy(contentDocument.parseStatus);
  return Object.fromEntries(rows.map((r) => [r.status, r.n])) as Partial<
    Record<"pending" | "parsing" | "parsed" | "failed", number>
  >;
}

// ---- worker side -------------------------------------------------------------------------------

/** Claims the oldest pending document (SKIP LOCKED, safe with several workers). */
export async function claimNextDocument(db: Database) {
  const rows = await db.execute<{ id: string }>(sql`
    update ${contentDocument} set parse_status = 'parsing', processing_started_at = now()
    where id = (
      select id from ${contentDocument} where parse_status = 'pending'
      order by created_at for update skip locked limit 1
    )
    returning id`);
  const id = rows.rows[0]?.id;
  if (!id) return null;
  const [row] = await db.select().from(contentDocument).where(eq(contentDocument.id, id));
  return row ?? null;
}

export interface NewContentBlock {
  type: "heading" | "paragraph" | "list_item" | "cta" | "link" | "emphasis";
  level: number | null;
  text: string;
  normalizedText: string;
  href: string | null;
  pageHint: string | null;
  location: Record<string, unknown>;
}

/** Replaces the document's blocks and marks it parsed (no-op if it was deleted meanwhile). */
export async function completeDocument(
  db: Database,
  documentId: string,
  blocks: NewContentBlock[],
  meta: Record<string, unknown>,
) {
  return db.transaction(async (tx) => {
    const [doc] = await tx
      .select({ id: contentDocument.id })
      .from(contentDocument)
      .where(eq(contentDocument.id, documentId))
      .for("update");
    if (!doc) return false;
    await tx.delete(contentBlock).where(eq(contentBlock.documentId, documentId));
    const rows = blocks.map((b, i) => ({ ...b, documentId, order: i }));
    for (let i = 0; i < rows.length; i += 500)
      await tx.insert(contentBlock).values(rows.slice(i, i + 500));
    await tx
      .update(contentDocument)
      .set({
        parseStatus: "parsed",
        parseError: null,
        blockCount: blocks.length,
        meta,
        processingStartedAt: null,
      })
      .where(eq(contentDocument.id, documentId));
    return true;
  });
}

export async function failDocument(db: Database, documentId: string, message: string) {
  await db
    .update(contentDocument)
    .set({
      parseStatus: "failed",
      parseError: message.slice(0, 1000),
      processingStartedAt: null,
      blockCount: 0,
    })
    .where(eq(contentDocument.id, documentId));
  await db.delete(contentBlock).where(eq(contentBlock.documentId, documentId));
}

/** Documents left "parsing" by a stopped worker are failed with a retry hint. */
export async function recoverStaleDocuments(db: Database, staleAfterMs: number) {
  const rows = await db
    .update(contentDocument)
    .set({
      parseStatus: "failed",
      parseError: "Processing was interrupted (the worker stopped). Use Retry to process it again.",
      processingStartedAt: null,
    })
    .where(
      and(
        eq(contentDocument.parseStatus, "parsing"),
        lt(
          contentDocument.processingStartedAt,
          sql`now() - (${staleAfterMs} || ' milliseconds')::interval`,
        ),
      ),
    )
    .returning({ id: contentDocument.id });
  return rows.map((r) => r.id);
}

/** Newest documents first, for dashboards. */
export async function latestDocuments(db: Database, projectId: string, limit = 5) {
  return db
    .select(documentColumns)
    .from(contentDocument)
    .where(eq(contentDocument.projectId, projectId))
    .orderBy(desc(contentDocument.createdAt))
    .limit(limit);
}
