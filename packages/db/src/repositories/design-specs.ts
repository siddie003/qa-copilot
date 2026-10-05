import {
  designSpecSchema,
  diffSpecs,
  emptyDesignSpec,
  mergeExtracted,
  type DesignSpec,
} from "@qa/core";
import { and, desc, eq, gt, ne, sql } from "drizzle-orm";
import type { Database } from "../client";
import { designSpec } from "../schema";

/**
 * Design specs are immutable, numbered versions per project. The active spec is the newest
 * confirmed version; a draft is an unconfirmed version newer than it (produced by Figma or
 * guideline extraction) and waits for the user to confirm or discard it. Callers must have
 * verified project ownership first.
 */

export type DesignSpecRow = typeof designSpec.$inferSelect;
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Parses stored tokens; stored specs were validated on write, so this only fills defaults. */
export function specOf(row: Pick<DesignSpecRow, "tokens">): DesignSpec {
  const parsed = designSpecSchema.safeParse(row.tokens);
  return parsed.success ? parsed.data : emptyDesignSpec();
}

async function lockProject(tx: Tx, projectId: string) {
  await tx.execute(sql`select id from project where id = ${projectId} for update`);
}

async function latest(db: Database | Tx, projectId: string, confirmed: boolean) {
  const [row] = await db
    .select()
    .from(designSpec)
    .where(and(eq(designSpec.projectId, projectId), eq(designSpec.confirmedByUser, confirmed)))
    .orderBy(desc(designSpec.version))
    .limit(1);
  return row ?? null;
}

async function nextVersion(tx: Tx, projectId: string) {
  const [row] = await tx
    .select({ v: sql<number>`coalesce(max(${designSpec.version}), 0)::int` })
    .from(designSpec)
    .where(eq(designSpec.projectId, projectId));
  return (row?.v ?? 0) + 1;
}

export async function getActiveSpec(db: Database, projectId: string) {
  return latest(db, projectId, true);
}

export async function getSpecById(db: Database, id: string) {
  const [row] = await db.select().from(designSpec).where(eq(designSpec.id, id));
  return row ?? null;
}

/** Active spec, pending draft (if any) and the confirmed version history. */
export async function getDesignSpecState(db: Database, projectId: string) {
  const active = await latest(db, projectId, true);
  const newestDraft = await latest(db, projectId, false);
  const draft =
    newestDraft && (!active || newestDraft.version > active.version) ? newestDraft : null;
  const history = await db
    .select({
      id: designSpec.id,
      version: designSpec.version,
      origin: designSpec.origin,
      confirmedAt: designSpec.confirmedAt,
      createdAt: designSpec.createdAt,
    })
    .from(designSpec)
    .where(and(eq(designSpec.projectId, projectId), eq(designSpec.confirmedByUser, true)))
    .orderBy(desc(designSpec.version))
    .limit(20);
  return { active, draft, history };
}

export class DraftPendingError extends Error {
  constructor() {
    super("A draft design reference is waiting for review");
  }
}

/** Saves a user-entered spec as a new confirmed version. Refuses while a draft is pending. */
export async function saveConfirmedSpec(
  db: Database,
  projectId: string,
  tokens: DesignSpec,
  opts: { userId: string },
) {
  return db.transaction(async (tx) => {
    await lockProject(tx, projectId);
    const active = await latest(tx, projectId, true);
    const draft = await latest(tx, projectId, false);
    if (draft && (!active || draft.version > active.version)) throw new DraftPendingError();
    const [row] = await tx
      .insert(designSpec)
      .values({
        projectId,
        version: await nextVersion(tx, projectId),
        tokens: tokens as unknown as Record<string, unknown>,
        confirmedByUser: true,
        confirmedAt: sql`now()`,
        origin: "manual",
        createdByUserId: opts.userId,
      })
      .returning();
    return row!;
  });
}

/**
 * Merges extracted values (Figma or guideline document) into a new draft on top of the pending
 * draft or the active spec. Manually entered values are never overwritten. Returns null when the
 * extraction adds nothing new compared with the active spec (no empty drafts).
 */
export async function upsertDraftFromExtraction(
  db: Database,
  projectId: string,
  extracted: DesignSpec,
  opts: { origin: "figma" | "document"; referenceSourceId: string },
) {
  return db.transaction(async (tx) => {
    await lockProject(tx, projectId);
    const active = await latest(tx, projectId, true);
    const newestDraft = await latest(tx, projectId, false);
    const draft =
      newestDraft && (!active || newestDraft.version > active.version) ? newestDraft : null;
    const activeSpec = active ? specOf(active) : emptyDesignSpec();
    const merged = mergeExtracted(draft ? specOf(draft) : activeSpec, extracted);
    if (diffSpecs(activeSpec, merged).length === 0) return null;
    // One pending draft at a time: the new draft replaces the previous one (it includes it).
    await tx
      .delete(designSpec)
      .where(and(eq(designSpec.projectId, projectId), eq(designSpec.confirmedByUser, false)));
    const [row] = await tx
      .insert(designSpec)
      .values({
        projectId,
        referenceSourceId: opts.referenceSourceId,
        version: await nextVersion(tx, projectId),
        tokens: merged as unknown as Record<string, unknown>,
        confirmedByUser: false,
        origin: opts.origin,
      })
      .returning();
    return row!;
  });
}

/** Confirms the pending draft with this version. Returns null if it is no longer pending. */
export async function confirmDraft(
  db: Database,
  projectId: string,
  version: number,
  userId: string,
) {
  return db.transaction(async (tx) => {
    await lockProject(tx, projectId);
    const active = await latest(tx, projectId, true);
    if (active && active.version >= version) return null;
    const [row] = await tx
      .update(designSpec)
      .set({ confirmedByUser: true, confirmedAt: sql`now()`, createdByUserId: userId })
      .where(
        and(
          eq(designSpec.projectId, projectId),
          eq(designSpec.version, version),
          eq(designSpec.confirmedByUser, false),
        ),
      )
      .returning();
    if (!row) return null;
    await tx
      .delete(designSpec)
      .where(
        and(
          eq(designSpec.projectId, projectId),
          eq(designSpec.confirmedByUser, false),
          ne(designSpec.id, row.id),
        ),
      );
    return row;
  });
}

/** Deletes the pending draft. Returns whether one existed. */
export async function discardDraft(db: Database, projectId: string) {
  const active = await latest(db, projectId, true);
  const rows = await db
    .delete(designSpec)
    .where(
      and(
        eq(designSpec.projectId, projectId),
        eq(designSpec.confirmedByUser, false),
        ...(active ? [gt(designSpec.version, active.version)] : []),
      ),
    )
    .returning({ id: designSpec.id });
  return rows.length > 0;
}
