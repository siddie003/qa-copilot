import { asc, count, eq } from "drizzle-orm";
import type { Database } from "../client";
import { contentDocument, referenceSource } from "../schema";

export interface FigmaReferenceValues {
  figmaUrl: string;
  figmaFileKey: string;
  figmaNodeIds: string[];
}

/** Callers must have verified project ownership first. */
export async function listReferenceSources(db: Database, projectId: string) {
  return db
    .select({
      id: referenceSource.id,
      kind: referenceSource.kind,
      figmaUrl: referenceSource.figmaUrl,
      figmaFileKey: referenceSource.figmaFileKey,
      figmaNodeIds: referenceSource.figmaNodeIds,
      status: referenceSource.status,
      error: referenceSource.error,
      fetchedAt: referenceSource.fetchedAt,
      createdAt: referenceSource.createdAt,
    })
    .from(referenceSource)
    .where(eq(referenceSource.projectId, projectId))
    .orderBy(asc(referenceSource.createdAt));
}

/**
 * Records a Figma reference. Status stays `pending`: nothing has been fetched from Figma yet,
 * so no design values exist until the reference is processed (Phase 6).
 */
export async function addFigmaReference(db: Database, projectId: string, v: FigmaReferenceValues) {
  const [row] = await db
    .insert(referenceSource)
    .values({ projectId, kind: "figma", status: "pending", ...v })
    .returning();
  return row!;
}

export async function countContentDocuments(db: Database, projectId: string) {
  const [row] = await db
    .select({ n: count() })
    .from(contentDocument)
    .where(eq(contentDocument.projectId, projectId));
  return row?.n ?? 0;
}
