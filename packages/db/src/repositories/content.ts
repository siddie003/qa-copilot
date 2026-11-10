import { and, asc, count, desc, eq, gt, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Database } from "../client";
import { contentBlock, contentChunk, contentDocument, project } from "../schema";
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
  stage: contentDocument.stage,
  outcome: contentDocument.outcome,
  coverage: contentDocument.coverage,
  chunkCount: contentDocument.chunkCount,
  attempts: contentDocument.attempts,
  cancelRequestedAt: contentDocument.cancelRequestedAt,
  extractorVersion: contentDocument.extractorVersion,
  /** Present when a stopped PDF extraction can continue where it stopped. */
  resumable: sql<boolean>`(${contentDocument.checkpoint} is not null)`,
  createdAt: contentDocument.createdAt,
  updatedAt: contentDocument.updatedAt,
};

/** A document of the project with exactly these bytes, if any (duplicate upload check). */
export async function findDocumentBySha(db: Database, projectId: string, sha256: string) {
  const [row] = await db
    .select({ id: contentDocument.id, filename: contentDocument.filename })
    .from(contentDocument)
    .where(and(eq(contentDocument.projectId, projectId), eq(contentDocument.sha256, sha256)))
    .limit(1);
  return row ?? null;
}

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

/**
 * Puts a document back into the queue: failed (read again from the start), cancelled or partial
 * with a checkpoint (continued where it stopped). Null when the document is in another state.
 */
export async function requeueDocument(db: Database, documentId: string) {
  const [row] = await db
    .update(contentDocument)
    .set({
      parseStatus: "pending",
      parseError: null,
      processingStartedAt: null,
      cancelRequestedAt: null,
      stage: null,
      attempts: 0,
      // A failed document starts over; cancelled and partial ones keep their checkpoint.
      checkpoint: sql`case when ${contentDocument.parseStatus} = 'failed' then null else ${contentDocument.checkpoint} end`,
    })
    .where(
      and(
        eq(contentDocument.id, documentId),
        or(
          inArray(contentDocument.parseStatus, ["failed", "cancelled"]),
          and(
            eq(contentDocument.parseStatus, "parsed"),
            sql`${contentDocument.checkpoint} is not null`,
          ),
        ),
      ),
    )
    .returning(documentColumns);
  if (row) await notifyReferenceQueued(db);
  return row ?? null;
}

/**
 * Cancels processing: a queued document is cancelled at once; a document being processed gets a
 * cancellation request that the worker honours between batches (within seconds). Blocks read so
 * far and the checkpoint are kept, so Retry continues. Null when there is nothing to cancel.
 */
export async function cancelDocument(db: Database, documentId: string) {
  return db.transaction(async (tx) => {
    const [doc] = await tx
      .select({ status: contentDocument.parseStatus })
      .from(contentDocument)
      .where(eq(contentDocument.id, documentId))
      .for("update");
    if (doc?.status === "pending") {
      const [row] = await tx
        .update(contentDocument)
        .set({
          parseStatus: "cancelled",
          stage: null,
          parseError: "Cancelled before processing started.",
        })
        .where(eq(contentDocument.id, documentId))
        .returning(documentColumns);
      return row ?? null;
    }
    if (doc?.status === "parsing") {
      const [row] = await tx
        .update(contentDocument)
        .set({ cancelRequestedAt: sql`now()` })
        .where(eq(contentDocument.id, documentId))
        .returning(documentColumns);
      return row ?? null;
    }
    return null;
  });
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
    Record<"pending" | "parsing" | "parsed" | "failed" | "cancelled", number>
  >;
}

// ---- worker side -------------------------------------------------------------------------------

/**
 * Claims the oldest pending document (SKIP LOCKED, safe with several workers) and counts the
 * attempt. The returned row includes the checkpoint of an earlier, stopped run.
 */
export async function claimNextDocument(db: Database) {
  const rows = await db.execute<{ id: string }>(sql`
    update ${contentDocument}
    set parse_status = 'parsing', processing_started_at = now(), stage = 'extracting',
      attempts = attempts + 1, parse_error = null
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
  /** Position in the document (the block's global index). */
  order: number;
}

/** Heartbeat of a processing run. Null when the document is no longer processed by this run. */
export async function documentHeartbeat(db: Database, documentId: string) {
  const [row] = await db
    .update(contentDocument)
    .set({ processingStartedAt: sql`now()` })
    .where(and(eq(contentDocument.id, documentId), eq(contentDocument.parseStatus, "parsing")))
    .returning({ cancelRequestedAt: contentDocument.cancelRequestedAt });
  return row ?? null;
}

/**
 * Prepares a processing run: a fresh run removes earlier blocks and chunks; a resumed run keeps
 * the blocks before the checkpoint (`keepBlocksBefore`) and only removes chunks (rebuilt later).
 */
export async function prepareDocumentRun(
  db: Database,
  documentId: string,
  keepBlocksBefore: number | null,
) {
  await db.transaction(async (tx) => {
    await tx.delete(contentChunk).where(eq(contentChunk.documentId, documentId));
    await tx
      .delete(contentBlock)
      .where(
        keepBlocksBefore === null
          ? eq(contentBlock.documentId, documentId)
          : and(eq(contentBlock.documentId, documentId), gte(contentBlock.order, keepBlocksBefore)),
      );
    await tx
      .update(contentDocument)
      .set({
        chunkCount: 0,
        ...(keepBlocksBefore === null
          ? { blockCount: 0, coverage: null, checkpoint: null, outcome: null }
          : {}),
      })
      .where(eq(contentDocument.id, documentId));
  });
}

/**
 * Stores one batch of blocks with the coverage and checkpoint reached after it, atomically, so an
 * interrupted run resumes exactly after the last stored batch. `stored` is false when the document
 * is no longer being processed (deleted, recovered elsewhere): nothing is written then. Also reports a
 * pending cancellation request, so the run stops right after this batch.
 */
export async function appendDocumentBatch(
  db: Database,
  documentId: string,
  blocks: NewContentBlock[],
  state: {
    coverage: Record<string, unknown>;
    checkpoint: Record<string, unknown> | null;
    blockCount: number;
  },
) {
  return db.transaction(async (tx) => {
    const [doc] = await tx
      .select({
        status: contentDocument.parseStatus,
        cancelRequestedAt: contentDocument.cancelRequestedAt,
      })
      .from(contentDocument)
      .where(eq(contentDocument.id, documentId))
      .for("update");
    if (doc?.status !== "parsing") return { stored: false, cancelRequested: false };
    const rows = blocks.map((b) => ({ ...b, documentId }));
    for (let i = 0; i < rows.length; i += 500)
      await tx.insert(contentBlock).values(rows.slice(i, i + 500));
    await tx
      .update(contentDocument)
      .set({
        coverage: state.coverage,
        checkpoint: state.checkpoint,
        blockCount: state.blockCount,
        processingStartedAt: sql`now()`,
      })
      .where(eq(contentDocument.id, documentId));
    return { stored: true, cancelRequested: doc.cancelRequestedAt !== null };
  });
}

export async function setDocumentStage(db: Database, documentId: string, stage: string) {
  await db
    .update(contentDocument)
    .set({ stage, processingStartedAt: sql`now()` })
    .where(eq(contentDocument.id, documentId));
}

/** Calls `fn` with the document's blocks in order, `pageSize` at a time (bounded memory). */
export async function forEachBlockPage(
  db: Database,
  documentId: string,
  fn: (blocks: Array<typeof contentBlock.$inferSelect>) => Promise<void> | void,
  pageSize = 2_000,
) {
  let after = -1;
  for (;;) {
    const rows = await db
      .select()
      .from(contentBlock)
      .where(and(eq(contentBlock.documentId, documentId), gt(contentBlock.order, after)))
      .orderBy(asc(contentBlock.order))
      .limit(pageSize);
    if (!rows.length) return;
    await fn(rows);
    after = rows[rows.length - 1]!.order;
  }
}

/** Removes a document's chunks (before they are rebuilt). */
export async function deleteChunks(db: Database, documentId: string) {
  await db.delete(contentChunk).where(eq(contentChunk.documentId, documentId));
}

export type NewContentChunk = Omit<
  typeof contentChunk.$inferInsert,
  "id" | "documentId" | "projectId" | "search"
>;

export async function insertChunks(
  db: Database,
  documentId: string,
  projectId: string,
  chunks: NewContentChunk[],
) {
  for (let i = 0; i < chunks.length; i += 200)
    await db
      .insert(contentChunk)
      .values(chunks.slice(i, i + 200).map((c) => ({ ...c, documentId, projectId })));
}

/**
 * Marks a processing run as finished (parsed with its outcome). The checkpoint is kept only when
 * the extraction stopped early and can continue. False when the run lost the document.
 */
export async function finishDocument(
  db: Database,
  documentId: string,
  v: {
    outcome: string;
    coverage: Record<string, unknown>;
    checkpoint: Record<string, unknown> | null;
    meta: Record<string, unknown>;
    blockCount: number;
    chunkCount: number;
    extractorVersion: string;
  },
) {
  const [row] = await db
    .update(contentDocument)
    .set({
      parseStatus: "parsed",
      parseError: null,
      stage: null,
      processingStartedAt: null,
      cancelRequestedAt: null,
      ...v,
    })
    .where(and(eq(contentDocument.id, documentId), eq(contentDocument.parseStatus, "parsing")))
    .returning({ id: contentDocument.id });
  return Boolean(row);
}

/** Cancelled by the user while processing: what was read so far and the checkpoint are kept. */
export async function markDocumentCancelled(
  db: Database,
  documentId: string,
  coverage: Record<string, unknown> | null,
) {
  await db
    .update(contentDocument)
    .set({
      parseStatus: "cancelled",
      parseError: "Cancelled by a user. Retry continues where it stopped.",
      stage: null,
      processingStartedAt: null,
      cancelRequestedAt: null,
      ...(coverage ? { coverage } : {}),
    })
    .where(and(eq(contentDocument.id, documentId), eq(contentDocument.parseStatus, "parsing")));
}

/**
 * Fails a document. Its blocks and chunks are removed (a failed document is never compared);
 * the coverage is kept so users can see what was found (e.g. every page image-only).
 */
export async function failDocument(
  db: Database,
  documentId: string,
  message: string,
  coverage?: Record<string, unknown> | null,
) {
  await db.transaction(async (tx) => {
    await tx
      .update(contentDocument)
      .set({
        parseStatus: "failed",
        parseError: message.slice(0, 1000),
        processingStartedAt: null,
        cancelRequestedAt: null,
        stage: null,
        outcome: null,
        checkpoint: null,
        blockCount: 0,
        chunkCount: 0,
        ...(coverage !== undefined ? { coverage } : {}),
      })
      .where(eq(contentDocument.id, documentId));
    await tx.delete(contentChunk).where(eq(contentChunk.documentId, documentId));
    await tx.delete(contentBlock).where(eq(contentBlock.documentId, documentId));
  });
}

/**
 * Documents left "parsing" by a stopped worker: re-queued to continue from their checkpoint while
 * attempts remain, otherwise failed with a retry hint. Parsed documents whose indexing was
 * interrupted are released for the indexing job again.
 */
export async function recoverStaleDocuments(db: Database, staleAfterMs: number, maxAttempts = 3) {
  const stale = sql`now() - (${staleAfterMs} || ' milliseconds')::interval`;
  const requeued = await db
    .update(contentDocument)
    .set({ parseStatus: "pending", stage: null, processingStartedAt: null })
    .where(
      and(
        eq(contentDocument.parseStatus, "parsing"),
        lt(contentDocument.processingStartedAt, stale),
        lt(contentDocument.attempts, maxAttempts),
        isNull(contentDocument.cancelRequestedAt),
      ),
    )
    .returning({ id: contentDocument.id });
  if (requeued.length) await notifyReferenceQueued(db);
  // A cancellation requested before the worker stopped is honoured.
  await db
    .update(contentDocument)
    .set({
      parseStatus: "cancelled",
      parseError: "Cancelled by a user. Retry continues where it stopped.",
      processingStartedAt: null,
      cancelRequestedAt: null,
      stage: null,
    })
    .where(
      and(
        eq(contentDocument.parseStatus, "parsing"),
        lt(contentDocument.processingStartedAt, stale),
        sql`${contentDocument.cancelRequestedAt} is not null`,
      ),
    );
  const failed = await db
    .update(contentDocument)
    .set({
      parseStatus: "failed",
      parseError: `Processing was interrupted ${maxAttempts} times (the worker stopped or ran out of resources). Use Retry to process it again.`,
      processingStartedAt: null,
      stage: null,
    })
    .where(
      and(
        eq(contentDocument.parseStatus, "parsing"),
        lt(contentDocument.processingStartedAt, stale),
      ),
    )
    .returning({ id: contentDocument.id });
  const reindex = await db
    .update(contentDocument)
    .set({ stage: null, processingStartedAt: null })
    .where(
      and(
        eq(contentDocument.parseStatus, "parsed"),
        eq(contentDocument.stage, "indexing"),
        lt(contentDocument.processingStartedAt, stale),
      ),
    )
    .returning({ id: contentDocument.id });
  return {
    requeued: requeued.map((r) => r.id),
    failed: failed.map((r) => r.id),
    reindex: reindex.map((r) => r.id),
  };
}

/**
 * Indexing job for parsed documents without chunks (documents parsed before chunking existed, or
 * whose indexing was interrupted). Claimed with SKIP LOCKED; `stage` marks it as taken.
 */
export async function claimNextIndexing(db: Database) {
  const rows = await db.execute<{ id: string }>(sql`
    update ${contentDocument} set stage = 'indexing', processing_started_at = now()
    where id = (
      select id from ${contentDocument}
      where parse_status = 'parsed' and stage is null and chunk_count = 0 and block_count > 0
      order by created_at for update skip locked limit 1
    )
    returning id`);
  const id = rows.rows[0]?.id;
  if (!id) return null;
  const [row] = await db.select().from(contentDocument).where(eq(contentDocument.id, id));
  return row ?? null;
}

/** Ends an indexing job of a parsed document. */
export async function finishIndexing(
  db: Database,
  documentId: string,
  chunkCount: number,
  coverage: Record<string, unknown> | null,
) {
  await db
    .update(contentDocument)
    .set({ stage: null, processingStartedAt: null, chunkCount, ...(coverage ? { coverage } : {}) })
    .where(eq(contentDocument.id, documentId));
}

/**
 * A completely read document of the same project with identical bytes, read by the same
 * extractor version: its blocks and chunks can be copied instead of parsing again.
 */
export async function findReusableDocument(
  db: Database,
  projectId: string,
  sha256: string,
  excludeId: string,
  extractorVersion: string,
) {
  const [row] = await db
    .select({ id: contentDocument.id, filename: contentDocument.filename })
    .from(contentDocument)
    .where(
      and(
        eq(contentDocument.projectId, projectId),
        eq(contentDocument.sha256, sha256),
        eq(contentDocument.parseStatus, "parsed"),
        eq(contentDocument.extractorVersion, extractorVersion),
        inArray(contentDocument.outcome, ["completed", "completed_with_warnings"]),
        gt(contentDocument.chunkCount, 0),
        sql`${contentDocument.id} <> ${excludeId}`,
      ),
    )
    .orderBy(asc(contentDocument.createdAt))
    .limit(1);
  return row ?? null;
}

/** Copies blocks, chunks and results of `sourceId` to the document being processed. */
export async function copyDocumentResults(db: Database, targetId: string, sourceId: string) {
  return db.transaction(async (tx) => {
    const [target] = await tx
      .select({ status: contentDocument.parseStatus })
      .from(contentDocument)
      .where(eq(contentDocument.id, targetId))
      .for("update");
    if (target?.status !== "parsing") return false;
    await tx.delete(contentChunk).where(eq(contentChunk.documentId, targetId));
    await tx.delete(contentBlock).where(eq(contentBlock.documentId, targetId));
    await tx.execute(sql`
      insert into ${contentBlock} (document_id, "order", type, level, text, normalized_text, href, page_hint, location)
      select ${targetId}, "order", type, level, text, normalized_text, href, page_hint, location
      from ${contentBlock} where document_id = ${sourceId}`);
    await tx.execute(sql`
      insert into ${contentChunk} (document_id, project_id, chunk_index, text, heading_text, page_hint,
        page_start, page_end, block_start, block_end, char_start, char_end, token_estimate, content_hash)
      select ${targetId}, project_id, chunk_index, text, heading_text, page_hint, page_start, page_end,
        block_start, block_end, char_start, char_end, token_estimate, content_hash
      from ${contentChunk} where document_id = ${sourceId}`);
    const [src] = await tx.select().from(contentDocument).where(eq(contentDocument.id, sourceId));
    if (!src) return false;
    await tx
      .update(contentDocument)
      .set({
        parseStatus: "parsed",
        parseError: null,
        stage: null,
        processingStartedAt: null,
        outcome: src.outcome,
        coverage: src.coverage,
        checkpoint: null,
        blockCount: src.blockCount,
        chunkCount: src.chunkCount,
        extractorVersion: src.extractorVersion,
        meta: { ...(src.meta ?? {}), reusedFrom: { documentId: src.id, filename: src.filename } },
      })
      .where(eq(contentDocument.id, targetId));
    return true;
  });
}

// ---- retrieval ---------------------------------------------------------------------------------

const chunkColumns = {
  id: contentChunk.id,
  documentId: contentChunk.documentId,
  filename: contentDocument.filename,
  chunkIndex: contentChunk.chunkIndex,
  text: contentChunk.text,
  headingText: contentChunk.headingText,
  pageHint: contentChunk.pageHint,
  pageStart: contentChunk.pageStart,
  pageEnd: contentChunk.pageEnd,
  blockStart: contentChunk.blockStart,
  blockEnd: contentChunk.blockEnd,
  charStart: contentChunk.charStart,
  charEnd: contentChunk.charEnd,
  tokenEstimate: contentChunk.tokenEstimate,
};

/**
 * Full-text search over a project's indexed sections (`terms` = a to_tsquery OR expression from
 * `searchTerms`). Callers must have verified project ownership; results never leave the project.
 */
export async function searchChunks(
  db: Database,
  opts: { projectId: string; terms: string; documentIds?: string[]; limit?: number },
) {
  // Sections containing every word first; only if there are none, sections with any word
  // (PostgreSQL ranking has no term rarity, so "any word" alone would favour common words).
  const run = (expr: string) => {
    const query = sql`to_tsquery('simple', ${expr})`;
    const rank = sql<number>`ts_rank_cd(${contentChunk.search}, ${query})`;
    return db
      .select({ ...chunkColumns, rank })
      .from(contentChunk)
      .innerJoin(contentDocument, eq(contentDocument.id, contentChunk.documentId))
      .where(
        and(
          eq(contentChunk.projectId, opts.projectId),
          eq(contentDocument.parseStatus, "parsed"),
          sql`${contentChunk.search} @@ ${query}`,
          opts.documentIds?.length ? inArray(contentChunk.documentId, opts.documentIds) : undefined,
        ),
      )
      .orderBy(sql`${rank} desc`, asc(contentChunk.documentId), asc(contentChunk.chunkIndex))
      .limit(Math.min(opts.limit ?? 10, 50));
  };
  const all = await run(opts.terms.split(" | ").join(" & "));
  return all.length || !opts.terms.includes(" | ") ? all : run(opts.terms);
}

/** The chunks containing the given blocks of one document (source sections of findings). */
export async function chunksForBlocks(db: Database, documentId: string, orders: number[]) {
  if (!orders.length) return [];
  return db
    .select(chunkColumns)
    .from(contentChunk)
    .innerJoin(contentDocument, eq(contentDocument.id, contentChunk.documentId))
    .where(
      and(
        eq(contentChunk.documentId, documentId),
        or(
          ...orders.map(
            (o) => sql`${o} between ${contentChunk.blockStart} and ${contentChunk.blockEnd}`,
          ),
        ),
      ),
    )
    .orderBy(asc(contentChunk.chunkIndex));
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
