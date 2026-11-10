import { FINDING_SOURCE_LABELS, ISSUE_STATUSES, SEVERITIES } from "@qa/core";
import { getDb, issuesRepo } from "@qa/db";
import { ListChecks } from "lucide-react";
import Link from "next/link";
import { ISSUE_STATUS_LABELS, SEVERITY_LABELS } from "@/components/ui/badges";
import { buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { inputClasses } from "@/components/ui/field-styles";
import { Pagination } from "@/components/ui/pagination";
import {
  DETECTED_SINCE_LABELS,
  hasActiveFilters,
  parseIssueFilters,
  SORT_LABELS,
  VERDICT_FILTER_LABELS,
  type RawParams,
} from "@/lib/issue-filters";
import { ISSUE_PAGE_SIZE, listIssues } from "@/server/issues";
import { IssueTable } from "./issue-table";

const CONFIDENCE_OPTIONS = [
  ["", "Any confidence"],
  ["50", "50% or more"],
  ["70", "70% or more"],
  ["90", "90% or more"],
] as const;

function Checkboxes({
  legend,
  name,
  options,
  selected,
}: {
  legend: string;
  name: string;
  options: Array<[string, string]>;
  selected: readonly string[];
}) {
  return (
    <fieldset className="min-w-0">
      <legend className="mb-1 text-xs font-medium text-muted">{legend}</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {options.map(([value, label]) => (
          <label key={value} className="flex items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              name={name}
              value={value}
              defaultChecked={selected.includes(value)}
              className="size-4 accent-[var(--primary)]"
            />
            {label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * Issue explorer backed by `issue_track` (server component; filters via the query string),
 * with a selectable table for bulk status changes.
 */
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
  const f = parseIssueFilters(params);
  const [{ items, total }, categories] = await Promise.all([
    listIssues(userId, f, { projectId }),
    issuesRepo.listIssueCategories(getDb(), userId, projectId),
  ]);
  const filtered = hasActiveFilters(f);
  // Secondary filters fold away (they take a whole phone screen); open when one is in use.
  const moreActive = [
    f.url,
    f.minConfidence !== undefined,
    f.since,
    f.severity.length,
    f.status.length,
    f.verdict.length,
  ].filter(Boolean).length;

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
        aria-label="Filter issues"
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
              Scanner / category
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
                  {FINDING_SOURCE_LABELS[c] ?? c}
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
        <details open={moreActive > 0} className="mt-3">
          <summary className="inline-flex min-h-6 cursor-pointer items-center text-sm font-medium text-primary">
            More filters{moreActive > 0 ? ` (${moreActive} active)` : ""}: severity, status,
            verdict, page, confidence, date
          </summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="sm:col-span-2">
              <label htmlFor="issue-url" className="mb-1 block text-xs font-medium text-muted">
                Page URL contains
              </label>
              <input
                id="issue-url"
                name="url"
                type="search"
                defaultValue={f.url ?? ""}
                placeholder="/pricing"
                className={inputClasses}
              />
            </div>
            <div>
              <label
                htmlFor="issue-confidence"
                className="mb-1 block text-xs font-medium text-muted"
              >
                Confidence
              </label>
              <select
                id="issue-confidence"
                name="minConfidence"
                defaultValue={f.minConfidence !== undefined ? String(f.minConfidence) : ""}
                className={inputClasses}
              >
                {CONFIDENCE_OPTIONS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="issue-since" className="mb-1 block text-xs font-medium text-muted">
                Last detected
              </label>
              <select
                id="issue-since"
                name="since"
                defaultValue={f.since ?? ""}
                className={inputClasses}
              >
                <option value="">Any time</option>
                {Object.entries(DETECTED_SINCE_LABELS).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="mt-3 grid gap-3 lg:grid-cols-3">
            <Checkboxes
              legend="Severity"
              name="severity"
              options={SEVERITIES.map((s) => [s, SEVERITY_LABELS[s]!])}
              selected={f.severity}
            />
            <Checkboxes
              legend="Status"
              name="status"
              options={ISSUE_STATUSES.map((s) => [s, ISSUE_STATUS_LABELS[s]!])}
              selected={f.status}
            />
            <Checkboxes
              legend="Verdict"
              name="verdict"
              options={Object.entries(VERDICT_FILTER_LABELS)}
              selected={f.verdict}
            />
          </div>
        </details>
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

      <p className="mb-2 text-sm text-muted" aria-live="polite">
        {total === 1 ? "1 issue" : `${total} issues`}
        {filtered ? " match these filters" : ""}
      </p>
      {items.length === 0 ? (
        <p className="rounded-lg border border-border bg-surface px-4 py-8 text-center text-sm text-muted">
          No issues match these filters.
        </p>
      ) : (
        <IssueTable items={items} total={total} showProject={showProject} />
      )}
      <Pagination
        page={f.page}
        pageSize={ISSUE_PAGE_SIZE}
        total={total}
        basePath={basePath}
        params={params}
        noun="issues"
      />
    </>
  );
}
