import { ISSUE_STATUSES, SEVERITIES } from "@qa/core";
import { getDb, issuesRepo, type IssueSort } from "@qa/db";
import { ListChecks } from "lucide-react";
import Link from "next/link";
import { z } from "zod";
import {
  ISSUE_STATUS_LABELS,
  IssueStatusBadge,
  SEVERITY_LABELS,
  SeverityBadge,
} from "@/components/ui/badges";
import { buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { inputClasses } from "@/components/ui/field-styles";
import { Pagination } from "@/components/ui/pagination";
import { formatDateTime } from "@/lib/format";

type RawParams = Record<string, string | string[] | undefined>;

const list = <T extends string>(values: readonly [T, ...T[]]) =>
  z.preprocess(
    (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]),
    z.array(z.enum(values)).catch([]),
  );

const filterSchema = z.object({
  severity: list(SEVERITIES),
  status: list(ISSUE_STATUSES),
  category: z.string().trim().max(64).optional().catch(undefined),
  q: z.string().trim().max(200).optional().catch(undefined),
  sort: z.enum(["severity", "status", "category", "date"]).catch("severity").default("severity"),
  page: z.coerce.number().int().min(1).max(10_000).catch(1).default(1),
});

const SORT_LABELS: Record<IssueSort, string> = {
  severity: "Severity",
  status: "Status",
  category: "Category",
  date: "Last updated",
};

const PAGE_SIZE = 25;

/** Filterable issue table backed by `issue_track` (server component; filters via query string). */
export async function IssueList({
  userId,
  projectId,
  params,
  basePath,
  showProject,
}: {
  userId: string;
  projectId?: string;
  params: RawParams;
  basePath: string;
  showProject: boolean;
}) {
  const f = filterSchema.parse(params);
  const [{ items, total }, categories] = await Promise.all([
    issuesRepo.listIssues(getDb(), userId, {
      projectId,
      severities: f.severity,
      statuses: f.status,
      category: f.category || undefined,
      q: f.q || undefined,
      sort: f.sort,
      page: f.page,
      pageSize: PAGE_SIZE,
    }),
    issuesRepo.listIssueCategories(getDb(), userId, projectId),
  ]);
  const filtered = Boolean(f.severity.length || f.status.length || f.category || f.q);

  if (total === 0 && !filtered) {
    return (
      <EmptyState
        icon={ListChecks}
        title="No issues detected yet"
        description="Issues are created only from evidence collected by scanners. None exist until a scan has produced findings."
      />
    );
  }

  return (
    <>
      <form
        role="search"
        action={basePath}
        className="mb-4 rounded-lg border border-border bg-surface p-4"
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="sm:col-span-2">
            <label htmlFor="issue-q" className="mb-1 block text-xs font-medium text-muted">
              Search
            </label>
            <input
              id="issue-q"
              name="q"
              type="search"
              defaultValue={f.q ?? ""}
              placeholder="Title or ISSUE-number"
              className={inputClasses}
            />
          </div>
          <div>
            <label htmlFor="issue-category" className="mb-1 block text-xs font-medium text-muted">
              Category
            </label>
            <select
              id="issue-category"
              name="category"
              defaultValue={f.category ?? ""}
              className={inputClasses}
            >
              <option value="">All categories</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="issue-sort" className="mb-1 block text-xs font-medium text-muted">
              Sort by
            </label>
            <select id="issue-sort" name="sort" defaultValue={f.sort} className={inputClasses}>
              {Object.entries(SORT_LABELS).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          <fieldset>
            <legend className="mb-1 text-xs font-medium text-muted">Severity</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {SEVERITIES.map((s) => (
                <label key={s} className="flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    name="severity"
                    value={s}
                    defaultChecked={f.severity.includes(s)}
                    className="size-4 accent-[var(--primary)]"
                  />
                  {SEVERITY_LABELS[s]}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend className="mb-1 text-xs font-medium text-muted">Status</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {ISSUE_STATUSES.map((s) => (
                <label key={s} className="flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    name="status"
                    value={s}
                    defaultChecked={f.status.includes(s)}
                    className="size-4 accent-[var(--primary)]"
                  />
                  {ISSUE_STATUS_LABELS[s]}
                </label>
              ))}
            </div>
          </fieldset>
        </div>
        <div className="mt-3 flex gap-2">
          <button type="submit" className={buttonClasses("primary", "sm")}>
            Apply filters
          </button>
          {filtered && (
            <Link href={basePath} className={buttonClasses("ghost", "sm")}>
              Clear
            </Link>
          )}
        </div>
      </form>

      {items.length === 0 ? (
        <p className="rounded-lg border border-border bg-surface px-4 py-8 text-center text-sm text-muted">
          No issues match these filters.
        </p>
      ) : (
        <div
          role="region"
          aria-label="Issues table"
          tabIndex={0}
          className="overflow-x-auto rounded-lg border border-border bg-surface"
        >
          <table className="w-full min-w-[720px] text-left text-sm">
            <caption className="sr-only">Issues, {total} matching</caption>
            <thead className="border-b border-border bg-surface-muted text-xs uppercase tracking-wide text-muted">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">
                  Issue
                </th>
                {showProject && (
                  <th scope="col" className="px-4 py-3 font-medium">
                    Project
                  </th>
                )}
                <th scope="col" className="px-4 py-3 font-medium">
                  Severity
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Category
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Status
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Updated
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {items.map((i) => (
                <tr key={i.id}>
                  <td className="px-4 py-3">
                    <div className="font-mono text-xs text-subtle">ISSUE-{i.displayNo}</div>
                    <div className="font-medium">{i.title}</div>
                  </td>
                  {showProject && (
                    <td className="px-4 py-3">
                      <Link href={`/projects/${i.projectId}/issues`} className="hover:underline">
                        {i.projectName}
                      </Link>
                    </td>
                  )}
                  <td className="px-4 py-3">
                    <SeverityBadge severity={i.severity} />
                  </td>
                  <td className="px-4 py-3 text-muted">{i.category}</td>
                  <td className="px-4 py-3">
                    <IssueStatusBadge status={i.status} />
                  </td>
                  <td className="px-4 py-3 text-muted">{formatDateTime(i.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pagination
        page={f.page}
        pageSize={PAGE_SIZE}
        total={total}
        basePath={basePath}
        params={params}
        noun="issues"
      />
    </>
  );
}
