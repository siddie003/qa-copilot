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
  outcome: referenceSource.outcome,
  manifest: referenceSource.manifest,
  attempts: referenceSource.attempts,
  cancelRequestedAt: referenceSource.cancelRequestedAt,
  /** A stopped Figma read that can continue where it stopped. */
  resumable: sql<boolean>`(${referenceSource.checkpoint} is not null)`,
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
    .set({
      status: "pending",
      error: null,
      processingStartedAt: null,
      cancelRequestedAt: null,
      attempts: 0,
    })
    .where(
      and(
        eq(referenceSource.id, referenceId),
        eq(referenceSource.projectId, projectId),
        inArray(referenceSource.status, ["ready", "failed", "unavailable", "cancelled"]),
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
    update ${referenceSource}
    set status = 'processing', processing_started_at = now(), attempts = attempts + 1
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
    status: "ready" | "failed" | "unavailable" | "cancelled";
    error?: string | null;
    meta?: Record<string, unknown> | null;
    outcome?: string | null;
    manifest?: Record<string, unknown> | null;
    /** Kept when a stopped read can continue; null clears it. Undefined leaves it unchanged. */
    checkpoint?: Record<string, unknown> | null;
  },
) {
  await db
    .update(referenceSource)
    .set({
      status: v.status,
      error: v.error?.slice(0, 1000) ?? null,
      ...(v.meta !== undefined ? { meta: v.meta } : {}),
      ...(v.manifest !== undefined ? { manifest: v.manifest } : {}),
      ...(v.checkpoint !== undefined ? { checkpoint: v.checkpoint } : {}),
      outcome: v.status === "ready" ? (v.outcome ?? "completed") : null,
      processingStartedAt: null,
      cancelRequestedAt: null,
      ...(v.status === "ready" ? { fetchedAt: sql`now()` } : {}),
    })
    .where(eq(referenceSource.id, referenceId));
}

/** Heartbeat of a processing run. Null when the reference is no longer processed by this run. */
export async function referenceHeartbeat(db: Database, referenceId: string) {
  const [row] = await db
    .update(referenceSource)
    .set({ processingStartedAt: sql`now()` })
    .where(and(eq(referenceSource.id, referenceId), eq(referenceSource.status, "processing")))
    .returning({ cancelRequestedAt: referenceSource.cancelRequestedAt });
  return row ?? null;
}

/**
 * Stores the manifest and checkpoint of a Figma read after a batch. `stored` is false when the
 * reference is no longer being processed; `cancelRequested` asks the run to stop.
 */
export async function saveReferenceProgress(
  db: Database,
  referenceId: string,
  v: { manifest: Record<string, unknown>; checkpoint: Record<string, unknown> | null },
) {
  const [row] = await db
    .update(referenceSource)
    .set({ manifest: v.manifest, checkpoint: v.checkpoint, processingStartedAt: sql`now()` })
    .where(and(eq(referenceSource.id, referenceId), eq(referenceSource.status, "processing")))
    .returning({ cancelRequestedAt: referenceSource.cancelRequestedAt });
  return { stored: Boolean(row), cancelRequested: Boolean(row?.cancelRequestedAt) };
}

/**
 * Cancels a reference: a queued one at once; one being read gets a request the worker honours
 * between requests. Pages read so far and the checkpoint are kept (Fetch again continues).
 */
export async function cancelReference(db: Database, projectId: string, referenceId: string) {
  return db.transaction(async (tx) => {
    const [ref] = await tx
      .select({ status: referenceSource.status })
      .from(referenceSource)
      .where(and(eq(referenceSource.id, referenceId), eq(referenceSource.projectId, projectId)))
      .for("update");
    if (ref?.status === "pending") {
      const [row] = await tx
        .update(referenceSource)
        .set({ status: "cancelled", error: "Cancelled before processing started." })
        .where(eq(referenceSource.id, referenceId))
        .returning(columns);
      return row ?? null;
    }
    if (ref?.status === "processing") {
      const [row] = await tx
        .update(referenceSource)
        .set({ cancelRequestedAt: sql`now()` })
        .where(eq(referenceSource.id, referenceId))
        .returning(columns);
      return row ?? null;
    }
    return null;
  });
}

/**
 * References left "processing" by a stopped worker: re-queued (a Figma read continues from its
 * checkpoint) while attempts remain, cancelled if a cancellation was requested, otherwise failed
 * with a retry hint.
 */
export async function recoverStaleReferences(db: Database, staleAfterMs: number, maxAttempts = 3) {
  const stale = and(
    eq(referenceSource.status, "processing"),
    lt(
      referenceSource.processingStartedAt,
      sql`now() - (${staleAfterMs} || ' milliseconds')::interval`,
    ),
  );
  const cancelled = await db
    .update(referenceSource)
    .set({
      status: "cancelled",
      error: "Cancelled by a user. Fetch again continues where it stopped.",
      processingStartedAt: null,
      cancelRequestedAt: null,
    })
    .where(and(stale, sql`${referenceSource.cancelRequestedAt} is not null`))
    .returning({ id: referenceSource.id });
  const requeued = await db
    .update(referenceSource)
    .set({ status: "pending", processingStartedAt: null })
    .where(and(stale, lt(referenceSource.attempts, maxAttempts)))
    .returning({ id: referenceSource.id });
  if (requeued.length) await notifyReferenceQueued(db);
  const failed = await db
    .update(referenceSource)
    .set({
      status: "failed",
      error: `Processing was interrupted ${maxAttempts} times (the worker stopped). Use Fetch again to retry.`,
      processingStartedAt: null,
    })
    .where(stale)
    .returning({ id: referenceSource.id });
  return [...cancelled, ...requeued, ...failed].map((r) => r.id);
}
