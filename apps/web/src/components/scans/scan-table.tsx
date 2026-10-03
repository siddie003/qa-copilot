import type { ScanListItem } from "@qa/db";
import Link from "next/link";
import { StatusPill } from "@/components/ui/status-pill";
import { formatDateTime, formatDuration, scanStatusLabel, scanStatusTone } from "@/lib/format";

export function ScanTable({ scans, showProject }: { scans: ScanListItem[]; showProject: boolean }) {
  return (
    <div
      role="region"
      aria-label="Scans table"
      tabIndex={0}
      className="overflow-x-auto rounded-lg border border-border bg-surface"
    >
      <table className="w-full min-w-[680px] text-left text-sm">
        <caption className="sr-only">Scans</caption>
        <thead className="border-b border-border bg-surface-muted text-xs uppercase tracking-wide text-muted">
          <tr>
            <th scope="col" className="px-4 py-3 font-medium">
              Scan
            </th>
            {showProject && (
              <th scope="col" className="px-4 py-3 font-medium">
                Project
              </th>
            )}
            <th scope="col" className="px-4 py-3 font-medium">
              Status
            </th>
            <th scope="col" className="px-4 py-3 text-right font-medium">
              Findings
            </th>
            <th scope="col" className="px-4 py-3 text-right font-medium">
              Failed steps
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              Started
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              Duration
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {scans.map((s) => (
            <tr key={s.id}>
              <td className="px-4 py-3 font-medium">
                <Link
                  href={`/projects/${s.projectId}/scans/${s.id}`}
                  className="text-primary hover:underline"
                >
                  #{s.number}
                </Link>
              </td>
              {showProject && (
                <td className="px-4 py-3">
                  <Link href={`/projects/${s.projectId}/history`} className="hover:underline">
                    {s.projectName}
                  </Link>
                </td>
              )}
              <td className="px-4 py-3">
                <StatusPill tone={scanStatusTone(s.status)}>{scanStatusLabel(s.status)}</StatusPill>
              </td>
              <td className="px-4 py-3 text-right tabular-nums">{s.findingCount}</td>
              <td className="px-4 py-3 text-right tabular-nums">{s.failedSteps}</td>
              <td className="px-4 py-3 text-muted">{formatDateTime(s.startedAt ?? s.createdAt)}</td>
              <td className="px-4 py-3 text-muted">
                {s.startedAt && s.finishedAt
                  ? formatDuration(s.finishedAt.getTime() - s.startedAt.getTime())
                  : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
