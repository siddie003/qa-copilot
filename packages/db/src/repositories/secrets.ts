import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../client";
import { projectSecret } from "../schema";

export const SCAN_AUTH_KIND = "scan_auth";
/** Per-project Figma personal access token (overrides FIGMA_ACCESS_TOKEN). */
export const FIGMA_TOKEN_KIND = "figma_token";

/** Callers must verify project ownership first and pass already-encrypted data. */
export async function setProjectSecret(
  db: Database,
  projectId: string,
  kind: string,
  ciphertext: string,
  summary: Record<string, unknown>,
) {
  await db
    .insert(projectSecret)
    .values({ projectId, kind, ciphertext, summary })
    .onConflictDoUpdate({
      target: [projectSecret.projectId, projectSecret.kind],
      set: { ciphertext, summary, updatedAt: sql`now()` },
    });
}

export async function getProjectSecret(db: Database, projectId: string, kind: string) {
  const [row] = await db
    .select()
    .from(projectSecret)
    .where(and(eq(projectSecret.projectId, projectId), eq(projectSecret.kind, kind)));
  return row ?? null;
}

export async function deleteProjectSecret(db: Database, projectId: string, kind: string) {
  const rows = await db
    .delete(projectSecret)
    .where(and(eq(projectSecret.projectId, projectId), eq(projectSecret.kind, kind)))
    .returning({ projectId: projectSecret.projectId });
  return rows.length > 0;
}
