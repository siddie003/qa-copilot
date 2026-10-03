import { listQuerySchema } from "@qa/core";
import { FolderKanban, Plus, Search } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { ButtonLink, buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { inputClasses } from "@/components/ui/field-styles";
import { PageHeader } from "@/components/ui/page-header";
import { StatusPill } from "@/components/ui/status-pill";
import { displayUrl, formatDate, formatDateTime, scanStatusLabel } from "@/lib/format";
import { listProjects } from "@/server/projects";
import { requirePageUser } from "@/server/session";

export const metadata: Metadata = { title: "Projects" };

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePageUser();
  const raw = await searchParams;
  const parsed = listQuerySchema.safeParse({
    q: typeof raw.q === "string" && raw.q.trim() ? raw.q : undefined,
    page: typeof raw.page === "string" ? raw.page : undefined,
  });
  const query = parsed.success ? parsed.data : listQuerySchema.parse({});
  const { items, total, page, pageSize } = await listProjects(user.id, query);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const pageHref = (p: number) =>
    `/projects?${new URLSearchParams({ ...(query.q ? { q: query.q } : {}), page: String(p) })}`;

  return (
    <>
      <PageHeader
        title="Projects"
        description="Each project holds a website URL, its design reference, approved content and scan history."
        actions={
          <ButtonLink href="/projects/new">
            <Plus aria-hidden className="size-4" />
            New project
          </ButtonLink>
        }
      />

      {total === 0 && !query.q ? (
        <EmptyState
          icon={FolderKanban}
          title="No projects yet"
          description="Create a project with the website you want to QA. Design references and content can be added afterwards."
          action={<ButtonLink href="/projects/new">Create your first project</ButtonLink>}
        />
      ) : (
        <>
          <form role="search" className="mb-4 flex max-w-md gap-2" action="/projects">
            <label htmlFor="project-search" className="sr-only">
              Search projects
            </label>
            <input
              id="project-search"
              name="q"
              type="search"
              defaultValue={query.q ?? ""}
              placeholder="Search by name or URL"
              className={inputClasses}
            />
            <button type="submit" className={buttonClasses("secondary")}>
              <Search aria-hidden className="size-4" />
              Search
            </button>
          </form>

          {items.length === 0 ? (
            <p className="rounded-lg border border-border bg-surface px-4 py-8 text-center text-sm text-muted">
              No projects match “{query.q}”.{" "}
              <Link href="/projects" className="font-medium text-primary hover:underline">
                Clear search
              </Link>
            </p>
          ) : (
            <div
              role="region"
              aria-label="Projects table"
              tabIndex={0}
              className="overflow-x-auto rounded-lg border border-border bg-surface"
            >
              <table className="w-full min-w-[720px] text-left text-sm">
                <caption className="sr-only">
                  Projects, {total} total, page {page} of {pages}
                </caption>
                <thead className="border-b border-border bg-surface-muted text-xs uppercase tracking-wide text-muted">
                  <tr>
                    <th scope="col" className="px-4 py-3 font-medium">
                      Project
                    </th>
                    <th scope="col" className="px-4 py-3 font-medium">
                      Last scan
                    </th>
                    <th scope="col" className="px-4 py-3 text-right font-medium">
                      Open issues
                    </th>
                    <th scope="col" className="px-4 py-3 text-right font-medium">
                      Critical
                    </th>
                    <th scope="col" className="px-4 py-3 text-right font-medium">
                      Resolved
                    </th>
                    <th scope="col" className="px-4 py-3 font-medium">
                      Created
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {items.map((p) => {
                    const c = p.issueCounts;
                    const outstanding = c.open + c.inProgress + c.reopened;
                    return (
                      <tr key={p.id} className="hover:bg-surface-muted/60">
                        <td className="px-4 py-3">
                          <Link
                            href={`/projects/${p.id}`}
                            className="font-medium text-foreground hover:text-primary hover:underline"
                          >
                            {p.name}
                          </Link>
                          <div className="text-xs text-subtle">{displayUrl(p.websiteUrl)}</div>
                        </td>
                        <td className="px-4 py-3 text-muted">
                          {p.lastScan ? (
                            <>
                              <StatusPill tone="neutral">
                                {scanStatusLabel(p.lastScan.status)}
                              </StatusPill>
                              <div className="mt-1 text-xs">
                                {formatDateTime(p.lastScan.createdAt)}
                              </div>
                            </>
                          ) : (
                            "Never scanned"
                          )}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">{outstanding}</td>
                        <td className="px-4 py-3 text-right tabular-nums">{c.critical}</td>
                        <td className="px-4 py-3 text-right tabular-nums">{c.resolved}</td>
                        <td className="px-4 py-3 text-muted">{formatDate(p.createdAt)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {pages > 1 && (
            <nav aria-label="Pagination" className="mt-4 flex items-center justify-between text-sm">
              <span className="text-muted">
                Page {page} of {pages} · {total} projects
              </span>
              <div className="flex gap-2">
                {page > 1 && (
                  <ButtonLink variant="secondary" size="sm" href={pageHref(page - 1)}>
                    Previous
                  </ButtonLink>
                )}
                {page < pages && (
                  <ButtonLink variant="secondary" size="sm" href={pageHref(page + 1)}>
                    Next
                  </ButtonLink>
                )}
              </div>
            </nav>
          )}
        </>
      )}
    </>
  );
}
