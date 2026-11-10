import { and, asc, count, eq } from "drizzle-orm";
import type { Database } from "../client";
import { page, project, rawFinding, scan } from "../schema";
import { ownedProjects } from "./owned";

export interface PageListItem {
  id: string;
  url: string;
  title: string | null;
  httpStatus: number | null;
  depth: number;
  crawlError: string | null;
  /** "user" when the page came from the project's page links, "crawl" otherwise. */
  origin: string;
  /** Raw finding counts per category for this page, e.g. { seo: 3, accessibility: 5 }. */
  findingsByCategory: Record<string, number>;
}

/** Pages crawled in a scan (owner-checked) with per-category finding counts. */
export async function listPagesForScan(
  db: Database,
  ownerId: string,
  scanId: string,
): Promise<PageListItem[]> {
  const pages = await db
    .select({
      id: page.id,
      url: page.url,
      title: page.title,
      httpStatus: page.httpStatus,
      depth: page.depth,
      crawlError: page.crawlError,
      origin: page.origin,
    })
    .from(page)
    .innerJoin(scan, eq(scan.id, page.scanId))
    .innerJoin(project, eq(project.id, scan.projectId))
    .where(and(ownedProjects(ownerId), eq(page.scanId, scanId)))
    .orderBy(asc(page.depth), asc(page.url));
  if (pages.length === 0) return [];

  const counts = await db
    .select({ pageId: rawFinding.pageId, category: rawFinding.category, n: count() })
    .from(rawFinding)
    .where(eq(rawFinding.scanId, scanId))
    .groupBy(rawFinding.pageId, rawFinding.category);
  const byPage = new Map<string, Record<string, number>>();
  for (const c of counts) {
    if (!c.pageId) continue;
    const entry = byPage.get(c.pageId) ?? {};
    entry[c.category] = c.n;
    byPage.set(c.pageId, entry);
  }
  return pages.map((p) => ({ ...p, findingsByCategory: byPage.get(p.id) ?? {} }));
}
