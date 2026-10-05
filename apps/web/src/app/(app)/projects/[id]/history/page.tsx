import { CHANGE_CATEGORY_DESCRIPTIONS } from "@qa/core/comparison";
import { History } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { CHANGE_TONES } from "@/components/history/change-badge";
import { CompareForm } from "@/components/history/compare-form";
import { TrendChart } from "@/components/history/trend-chart";
import { EmptyState } from "@/components/ui/empty-state";
import { Pagination } from "@/components/ui/pagination";
import { Card, StatTile } from "@/components/ui/stat";
import { StatusPill } from "@/components/ui/status-pill";
import { formatDateTime, scanStatusLabel, scanStatusTone } from "@/lib/format";
import { projectHistory, type HistoryItem } from "@/server/comparisons";
import { loadProjectForPage } from "@/server/loaders";

export const metadata: Metadata = { title: "Scan history" };
const PAGE_SIZE = 25;

const compareHref = (projectId: string, item: HistoryItem) =>
  item.previous
    ? `/projects/${projectId}/history/compare?base=${item.previous.id}&target=${item.id}`
    : null;

/** Why a scan has no comparison with an earlier one (shown instead of change counts). */
function noChangesReason(item: HistoryItem) {
  if (["queued", "running"].includes(item.status)) return "Not finished yet";
  if (item.groundingStatus === null) return "Ran before issue tracking (no issue records)";
  if (item.groundingStatus !== "completed")
    return `No issue records (evidence validation ${item.groundingStatus === "skipped" ? "did not run" : item.groundingStatus})`;
  return "First scan with issue records: nothing earlier to compare with";
}

function Changes({ item }: { item: HistoryItem }) {
  const c = item.changes?.counts;
  if (!c) return <span className="text-xs text-subtle">{noChangesReason(item)}</span>;
  const parts = (
    ["new", "reopened", "changed", "resolved", "not_rechecked", "newly_checked"] as const
  )
    .filter((k) => c[k] > 0)
    .map((k) => ({ k, n: c[k] }));
  if (!parts.length)
    return <span className="text-xs text-muted">No changes ({c.persistent} persistent)</span>;
  const words: Record<(typeof parts)[number]["k"], string> = {
    new: "new",
    reopened: "reopened",
    changed: "changed",
    resolved: "resolved",
    not_rechecked: "not rechecked",
    newly_checked: "newly checked",
  };
  return (
    <ul className="flex flex-wrap gap-1">
      {parts.map(({ k, n }) => (
        <li key={k}>
          <StatusPill tone={CHANGE_TONES[k]}>
            {n} {words[k]}
          </StatusPill>
        </li>
      ))}
    </ul>
  );
}

export default async function ScanHistoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user, project } = await loadProjectForPage((await params).id);
  const query = await searchParams;
  const page = Math.max(1, Number(query.page) || 1);
  const history = await projectHistory(user.id, project.id, { page, pageSize: PAGE_SIZE });

  if (history.total === 0)
    return (
      <EmptyState
        icon={History}
        title="No scan history yet"
        description="Every scan of this project is kept here. Once two scans have finished, you can compare them: new, resolved, persistent, reopened and changed issues, and scanner status changes."
        action={
          <Link href={`/projects/${project.id}/scan`} className="text-sm text-primary underline">
            Start a scan
          </Link>
        }
      />
    );

  const latest = history.trend.at(-1);
  const latestChanges = latest?.changes?.counts;
  const latestHref = latest ? compareHref(project.id, latest) : null;

  return (
    <div className="space-y-6">
      {latest && latestChanges && latest.previous && latestHref ? (
        <Card
          title={`Latest changes: scan #${latest.number} compared with scan #${latest.previous.number}`}
          action={
            <Link href={latestHref} className="text-sm font-medium text-primary hover:underline">
              View comparison
            </Link>
          }
        >
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {(
              ["new", "reopened", "changed", "resolved", "not_rechecked", "persistent"] as const
            ).map((k) => (
              <StatTile
                key={k}
                label={
                  {
                    new: "New",
                    reopened: "Reopened",
                    changed: "Changed",
                    resolved: "Resolved",
                    not_rechecked: "Not rechecked",
                    persistent: "Persistent",
                  }[k]
                }
                value={latestChanges[k]}
                href={`${latestHref}&show=${k}`}
                hint={k === "not_rechecked" ? "Not counted as resolved" : undefined}
              />
            ))}
          </div>
          {latestChanges.newly_checked > 0 && (
            <p className="mt-3 text-xs text-muted">
              {latestChanges.newly_checked} issue(s) newly checked:{" "}
              {CHANGE_CATEGORY_DESCRIPTIONS.newly_checked}
            </p>
          )}
        </Card>
      ) : (
        <Card title="Latest changes">
          <p className="text-sm text-muted">
            {history.comparableCount === 0
              ? "No finished scan with issue records yet. Comparisons become available once two scans have finished."
              : "Only one finished scan with issue records so far. Run another scan to see what changed."}
          </p>
        </Card>
      )}

      {history.trend.length > 0 && (
        <Card title="Issues per scan">
          <TrendChart projectId={project.id} items={history.trend} />
        </Card>
      )}

      {history.comparableCount >= 2 && (
        <Card title="Compare two scans">
          <CompareForm
            projectId={project.id}
            scans={history.scans}
            baseId={latest?.previous?.id}
            targetId={latest?.id}
          />
        </Card>
      )}

      <section aria-labelledby="all-scans">
        <h2 id="all-scans" className="mb-3 text-sm font-semibold">
          All scans ({history.total})
        </h2>
        <div
          role="region"
          aria-label="Scan history table"
          tabIndex={0}
          className="relative overflow-x-auto rounded-lg border border-border bg-surface"
        >
          <table className="w-full min-w-[860px] text-left text-sm">
            <caption className="sr-only">
              Scans of this project with issue counts and changes compared with the previous scan
            </caption>
            <thead className="border-b border-border bg-surface-muted text-xs uppercase tracking-wide text-muted">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">
                  Scan
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Status
                </th>
                <th scope="col" className="px-4 py-3 text-right font-medium">
                  Issues
                </th>
                <th scope="col" className="px-4 py-3 text-right font-medium">
                  Needs review
                </th>
                <th scope="col" className="px-4 py-3 text-right font-medium">
                  Unable to verify
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Changes vs previous scan
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {history.items.map((item) => {
                const href = compareHref(project.id, item);
                return (
                  <tr key={item.id}>
                    <td className="px-4 py-3">
                      <Link
                        href={`/projects/${project.id}/scans/${item.id}`}
                        className="font-medium text-primary hover:underline"
                      >
                        #{item.number}
                      </Link>
                      <div className="text-xs text-muted">
                        {formatDateTime(item.startedAt ?? item.createdAt)}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <StatusPill tone={scanStatusTone(item.status)}>
                        {scanStatusLabel(item.status)}
                      </StatusPill>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {item.comparable ? item.issueCount : "—"}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {item.breakdown ? item.breakdown.needsReview : "—"}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {item.breakdown ? item.breakdown.unableToVerify : "—"}
                    </td>
                    <td className="px-4 py-3">
                      {item.previous && (
                        <div className="mb-1 text-xs text-muted">vs #{item.previous.number}</div>
                      )}
                      <Changes item={item} />
                    </td>
                    <td className="px-4 py-3 text-right">
                      {href && (
                        <Link
                          href={href}
                          className="whitespace-nowrap text-sm font-medium text-primary hover:underline"
                        >
                          Compare
                          <span className="sr-only">
                            {" "}
                            scan #{item.number} with the previous scan
                          </span>
                        </Link>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <Pagination
          page={page}
          pageSize={PAGE_SIZE}
          total={history.total}
          basePath={`/projects/${project.id}/history`}
          params={query}
          noun="scans"
        />
      </section>
    </div>
  );
}
