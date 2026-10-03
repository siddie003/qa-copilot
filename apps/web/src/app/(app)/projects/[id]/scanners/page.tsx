import { stepLabel } from "@qa/core";
import { getDb, scansRepo } from "@qa/db";
import { Gauge } from "lucide-react";
import type { Metadata } from "next";
import { StepStatus } from "@/components/ui/badges";
import { EmptyState } from "@/components/ui/empty-state";
import { formatDateTime, formatDuration } from "@/lib/format";
import { loadProjectForPage } from "@/server/loaders";

export const metadata: Metadata = { title: "Scanner results" };

export default async function ScannerResultsPage({ params }: { params: Promise<{ id: string }> }) {
  const { user, project } = await loadProjectForPage((await params).id);
  const latest = await scansRepo.getLatestScan(getDb(), user.id, project.id);

  if (!latest || latest.runs.length === 0) {
    return (
      <EmptyState
        icon={Gauge}
        title="No scanner results yet"
        description="Each scanner's status (completed, failed, inconclusive), findings, duration and tool version appear here after a scan."
      />
    );
  }

  return (
    <>
      <p className="mb-3 text-sm text-muted">
        Scan #{latest.number} · started {formatDateTime(latest.startedAt ?? latest.createdAt)}
      </p>
      <div
        role="region"
        aria-label="Scanner results table"
        tabIndex={0}
        className="overflow-x-auto rounded-lg border border-border bg-surface"
      >
        <table className="w-full min-w-[760px] text-left text-sm">
          <caption className="sr-only">Pipeline steps of scan #{latest.number}</caption>
          <thead className="border-b border-border bg-surface-muted text-xs uppercase tracking-wide text-muted">
            <tr>
              <th scope="col" className="px-4 py-3 font-medium">
                Step
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Status
              </th>
              <th scope="col" className="px-4 py-3 text-right font-medium">
                Findings
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Duration
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Tool
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Details
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {latest.runs.map((r) => (
              <tr key={r.id}>
                <td className="px-4 py-3 font-medium">{stepLabel(r.stepKey)}</td>
                <td className="px-4 py-3">
                  <StepStatus status={r.status} />
                </td>
                <td className="px-4 py-3 text-right tabular-nums">{r.findingCount}</td>
                <td className="px-4 py-3 text-muted">{formatDuration(r.durationMs)}</td>
                <td className="px-4 py-3 text-muted">
                  {r.toolName ? `${r.toolName}${r.toolVersion ? ` ${r.toolVersion}` : ""}` : "—"}
                </td>
                <td className="px-4 py-3 text-muted">
                  {r.error ? (
                    <span className="text-danger">{r.error}</span>
                  ) : (
                    (r.statusReason ?? "—")
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
