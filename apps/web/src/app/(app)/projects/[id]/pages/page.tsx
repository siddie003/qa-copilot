import { getDb, pagesRepo, scansRepo } from "@qa/db";
import { FileSearch } from "lucide-react";
import type { Metadata } from "next";
import { EmptyState } from "@/components/ui/empty-state";
import { loadProjectForPage } from "@/server/loaders";

export const metadata: Metadata = { title: "Pages" };

// Columns follow the per-page QA view in the requirements; values are raw finding counts.
const CATEGORIES = [
  ["accessibility", "Accessibility"],
  ["security", "Security"],
  ["seo", "SEO"],
  ["links", "Links"],
  ["performance", "Performance"],
  ["responsive", "Responsive"],
  ["design", "Design"],
  ["content", "Content"],
] as const;

export default async function ProjectPagesPage({ params }: { params: Promise<{ id: string }> }) {
  const { user, project } = await loadProjectForPage((await params).id);
  const latest = await scansRepo.getLatestScan(getDb(), user.id, project.id);
  const pages = latest ? await pagesRepo.listPagesForScan(getDb(), user.id, latest.id) : [];

  if (pages.length === 0) {
    return (
      <EmptyState
        icon={FileSearch}
        title="No pages crawled yet"
        description={
          latest
            ? `Scan #${latest.number} has no crawled pages recorded.`
            : "Pages appear here after a scan crawls the website, with findings per category for each page."
        }
      />
    );
  }

  return (
    <>
      <p className="mb-3 text-sm text-muted">
        {pages.length} page{pages.length === 1 ? "" : "s"} from scan #{latest!.number}. Numbers are
        scanner findings per category.
      </p>
      <div
        role="region"
        aria-label="Pages table"
        tabIndex={0}
        className="overflow-x-auto rounded-lg border border-border bg-surface"
      >
        <table className="w-full min-w-[900px] text-left text-sm">
          <caption className="sr-only">Crawled pages with findings per category</caption>
          <thead className="border-b border-border bg-surface-muted text-xs uppercase tracking-wide text-muted">
            <tr>
              <th scope="col" className="px-4 py-3 font-medium">
                Page
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                HTTP
              </th>
              {CATEGORIES.map(([k, l]) => (
                <th key={k} scope="col" className="px-3 py-3 text-right font-medium">
                  {l}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {pages.map((p) => (
              <tr key={p.id}>
                <td className="max-w-xs px-4 py-3">
                  <div className="truncate font-medium" title={p.url}>
                    {p.title || p.url}
                  </div>
                  <div className="truncate text-xs text-subtle">{p.url}</div>
                  {p.crawlError && <div className="text-xs text-danger">{p.crawlError}</div>}
                </td>
                <td className="px-4 py-3 tabular-nums">{p.httpStatus ?? "—"}</td>
                {CATEGORIES.map(([k]) => (
                  <td key={k} className="px-3 py-3 text-right tabular-nums">
                    {p.findingsByCategory[k] ?? 0}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
