import { and, asc, count, eq, inArray, lt, sql } from "drizzle-orm";
import type { Database } from "../client";
import { contentDocument, referenceSource } from "../schema";
import { notifyReferenceQueued } from "./content";

export interface FigmaReferenceValues {
  figmaUrl: string;
  figmaFileKey: string;
  figmaNodeIds: string[];
}

export type ReferenceSourceRow = typeof referenceSource.$inferSelect;

const columns = {
  id: referenceSource.id,
  kind: referenceSource.kind,
  figmaUrl: referenceSource.figmaUrl,
  figmaFileKey: referenceSource.figmaFileKey,
  figmaNodeIds: referenceSource.figmaNodeIds,
  status: referenceSource.status,
  error: referenceSource.error,
  meta: referenceSource.meta,
  fetchedAt: referenceSource.fetchedAt,
  createdAt: referenceSource.createdAt,
};

/** Callers must have verified project ownership first. */
export async function listReferenceSources(db: Database, projectId: string) {
  return db
    .select(columns)
    .from(referenceSource)
    .where(eq(referenceSource.projectId, projectId))
    .orderBy(asc(referenceSource.createdAt));
}

/** Records a Figma reference and queues it; the worker reads its design values. */
export async function addFigmaReference(db: Database, projectId: string, v: FigmaReferenceValues) {
  const [row] = await db
    .insert(referenceSource)
    .values({ projectId, kind: "figma", status: "pending", ...v })
    .returning(columns);
  await notifyReferenceQueued(db);
  return row!;
}

/** Records an uploaded brand-guideline document and queues it for extraction. */
export async function addGuidelineReference(
  db: Database,
  projectId: string,
  v: { storageKey: string; meta: Record<string, unknown> },
) {
  const [row] = await db
    .insert(referenceSource)
    .values({ projectId, kind: "guideline_document", status: "pending", ...v })
    .returning(columns);
  await notifyReferenceQueued(db);
  return row!;
}

export async function getReference(db: Database, projectId: string, referenceId: string) {
  const [row] = await db
    .select({ ...columns, storageKey: referenceSource.storageKey })
    .from(referenceSource)
    .where(and(eq(referenceSource.id, referenceId), eq(referenceSource.projectId, projectId)));
  return row ?? null;
}

export async function deleteReference(db: Database, projectId: string, referenceId: string) {
  const [row] = await db
    .delete(referenceSource)
    .where(and(eq(referenceSource.id, referenceId), eq(referenceSource.projectId, projectId)))
    .returning({ storageKey: referenceSource.storageKey });
  return row ?? null;
}

/** Queues a reference to be processed again (e.g. after the Figma file changed). */
export async function requeueReference(db: Database, projectId: string, referenceId: string) {
  const [row] = await db
    .update(referenceSource)
    .set({ status: "pending", error: null, processingStartedAt: null })
    .where(
      and(
        eq(referenceSource.id, referenceId),
        eq(referenceSource.projectId, projectId),
        inArray(referenceSource.status, ["ready", "failed", "unavailable"]),
      ),
    )
    .returning(columns);
  if (row) await notifyReferenceQueued(db);
  return row ?? null;
}

export async function countContentDocuments(db: Database, projectId: string) {
  const [row] = await db
    .select({ n: count() })
    .from(contentDocument)
    .where(eq(contentDocument.projectId, projectId));
  return row?.n ?? 0;
}

// ---- worker side -------------------------------------------------------------------------------

/** Claims the oldest pending Figma/guideline reference (SKIP LOCKED). */
export async function claimNextReference(db: Database) {
  const rows = await db.execute<{ id: string }>(sql`
    update ${referenceSource} set status = 'processing', processing_started_at = now()
    where id = (
      select id from ${referenceSource}
      where status = 'pending' and kind in ('figma', 'guideline_document')
      order by created_at for update skip locked limit 1
    )
    returning id`);
  const id = rows.rows[0]?.id;
  if (!id) return null;
  const [row] = await db.select().from(referenceSource).where(eq(referenceSource.id, id));
  return row ?? null;
}

export async function completeReference(
  db: Database,
  referenceId: string,
  v: {
    status: "ready" | "failed" | "unavailable";
    error?: string | null;
    meta?: Record<string, unknown> | null;
  },
) {
  await db
    .update(referenceSource)
    .set({
      status: v.status,
      error: v.error?.slice(0, 1000) ?? null,
      ...(v.meta !== undefined ? { meta: v.meta } : {}),
      processingStartedAt: null,
      ...(v.status === "ready" ? { fetchedAt: sql`now()` } : {}),
    })
    .where(eq(referenceSource.id, referenceId));
}

/** References left "processing" by a stopped worker are failed with a retry hint. */
export async function recoverStaleReferences(db: Database, staleAfterMs: number) {
  const rows = await db
    .update(referenceSource)
    .set({
      status: "failed",
      error: "Processing was interrupted (the worker stopped). Use Fetch again to retry.",
      processingStartedAt: null,
    })
    .where(
      and(
        eq(referenceSource.status, "processing"),
        lt(
          referenceSource.processingStartedAt,
          sql`now() - (${staleAfterMs} || ' milliseconds')::interval`,
        ),
      ),
    )
    .returning({ id: referenceSource.id });
  return rows.map((r) => r.id);
}
