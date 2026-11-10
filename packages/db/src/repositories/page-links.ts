import { and, asc, count, eq } from "drizzle-orm";
import type { Database } from "../client";
import { projectPageLink } from "../schema";

const columns = {
  id: projectPageLink.id,
  url: projectPageLink.url,
  createdAt: projectPageLink.createdAt,
};

/** Callers must have verified project ownership first. */
export async function listPageLinks(db: Database, projectId: string) {
  return db
    .select(columns)
    .from(projectPageLink)
    .where(eq(projectPageLink.projectId, projectId))
    .orderBy(asc(projectPageLink.createdAt), asc(projectPageLink.url));
}

export async function countPageLinks(db: Database, projectId: string) {
  const [row] = await db
    .select({ n: count() })
    .from(projectPageLink)
    .where(eq(projectPageLink.projectId, projectId));
  return row?.n ?? 0;
}

/** Adds a link; returns null when the project already has a link with the same key. */
export async function addPageLink(
  db: Database,
  projectId: string,
  values: { url: string; linkKey: string },
) {
  const [row] = await db
    .insert(projectPageLink)
    .values({ projectId, ...values })
    .onConflictDoNothing({ target: [projectPageLink.projectId, projectPageLink.linkKey] })
    .returning(columns);
  return row ?? null;
}

export async function findPageLinkByKey(db: Database, projectId: string, linkKey: string) {
  const [row] = await db
    .select(columns)
    .from(projectPageLink)
    .where(and(eq(projectPageLink.projectId, projectId), eq(projectPageLink.linkKey, linkKey)));
  return row ?? null;
}

export async function deletePageLink(db: Database, projectId: string, id: string) {
  const [row] = await db
    .delete(projectPageLink)
    .where(and(eq(projectPageLink.projectId, projectId), eq(projectPageLink.id, id)))
    .returning(columns);
  return row ?? null;
}
