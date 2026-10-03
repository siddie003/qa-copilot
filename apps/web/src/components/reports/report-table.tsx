import Link from "next/link";
import { StatusPill } from "@/components/ui/status-pill";
import { formatBytes, formatDateTime } from "@/lib/format";

export interface ReportRow {
  id: string;
  format: string;
  status: string;
  sizeBytes: number | null;
  error: string | null;
  createdAt: Date;
  scanNumber: number;
  projectId: string;
  projectName: string;
}

const FORMAT_LABELS: Record<string, string> = { pdf: "PDF", md: "Markdown", json: "JSON" };
const TONE = {
  completed: "success",
  failed: "danger",
  running: "info",
  pending: "neutral",
} as const;

export function ReportTable({
  reports,
  showProject,
}: {
  reports: ReportRow[];
  showProject: boolean;
}) {
  return (
    <div
      role="region"
      aria-label="Reports table"
      tabIndex={0}
      className="overflow-x-auto rounded-lg border border-border bg-surface"
    >
      <table className="w-full min-w-[620px] text-left text-sm">
        <caption className="sr-only">Reports</caption>
        <thead className="border-b border-border bg-surface-muted text-xs uppercase tracking-wide text-muted">
          <tr>
            <th scope="col" className="px-4 py-3 font-medium">
              Format
            </th>
            {showProject && (
              <th scope="col" className="px-4 py-3 font-medium">
                Project
              </th>
            )}
            <th scope="col" className="px-4 py-3 font-medium">
              Scan
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              Status
            </th>
            <th scope="col" className="px-4 py-3 text-right font-medium">
              Size
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              Created
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {reports.map((r) => (
            <tr key={r.id}>
              <td className="px-4 py-3 font-medium">{FORMAT_LABELS[r.format] ?? r.format}</td>
              {showProject && (
                <td className="px-4 py-3">
                  <Link href={`/projects/${r.projectId}/reports`} className="hover:underline">
                    {r.projectName}
                  </Link>
                </td>
              )}
              <td className="px-4 py-3">#{r.scanNumber}</td>
              <td className="px-4 py-3">
                <StatusPill tone={TONE[r.status as keyof typeof TONE] ?? "neutral"}>
                  {r.status}
                </StatusPill>
                {r.error && <div className="mt-1 text-xs text-danger">{r.error}</div>}
              </td>
              <td className="px-4 py-3 text-right tabular-nums">{formatBytes(r.sizeBytes)}</td>
              <td className="px-4 py-3 text-muted">{formatDateTime(r.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
