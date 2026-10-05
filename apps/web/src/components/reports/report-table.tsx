"use client";

import { Download, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useRefreshWhile } from "@/components/references/processing-status";
import { buttonClasses } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { StatusPill } from "@/components/ui/status-pill";
import { useToast } from "@/components/ui/toast";
import { ApiError, apiFetch } from "@/lib/api-client";
import { formatBytes, formatDateTime } from "@/lib/format";

export interface ReportRow {
  id: string;
  format: string;
  status: string;
  sizeBytes: number | null;
  error: string | null;
  createdAt: Date | string;
  scanId: string;
  scanNumber: number;
  projectId: string;
  projectName: string;
}

export const FORMAT_LABELS: Record<string, string> = { pdf: "PDF", md: "Markdown", json: "JSON" };
const TONE = {
  completed: "success",
  failed: "danger",
  running: "info",
  pending: "neutral",
} as const;
const STATUS_LABELS: Record<string, string> = {
  pending: "Queued",
  running: "Generating",
  completed: "Ready",
  failed: "Failed",
};

/** Generated reports with download and delete; refreshes while any report is being generated. */
export function ReportTable({
  reports,
  showProject,
}: {
  reports: ReportRow[];
  showProject: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [deleting, setDeleting] = useState<ReportRow | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useRefreshWhile(reports.some((r) => r.status === "pending" || r.status === "running"));

  async function remove() {
    if (!deleting) return;
    setPending(true);
    setError(null);
    try {
      await apiFetch(`/api/v1/reports/${deleting.id}`, { method: "DELETE" });
      toast.success("Report deleted.");
      setDeleting(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "The report could not be deleted.");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <div
        role="region"
        aria-label="Reports table"
        tabIndex={0}
        className="relative overflow-x-auto rounded-lg border border-border bg-surface"
      >
        <table className="w-full min-w-[720px] text-left text-sm">
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
                Requested
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {reports.map((r) => {
              const label = `${FORMAT_LABELS[r.format] ?? r.format} report of scan #${r.scanNumber}`;
              return (
                <tr key={r.id}>
                  <td className="px-4 py-3 font-medium">{FORMAT_LABELS[r.format] ?? r.format}</td>
                  {showProject && (
                    <td className="px-4 py-3">
                      <Link href={`/projects/${r.projectId}/reports`} className="hover:underline">
                        {r.projectName}
                      </Link>
                    </td>
                  )}
                  <td className="px-4 py-3">
                    <Link
                      href={`/projects/${r.projectId}/scans/${r.scanId}`}
                      className="hover:underline"
                    >
                      #{r.scanNumber}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <StatusPill tone={TONE[r.status as keyof typeof TONE] ?? "neutral"}>
                      {STATUS_LABELS[r.status] ?? r.status}
                    </StatusPill>
                    {r.error && <div className="mt-1 max-w-sm text-xs text-danger">{r.error}</div>}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{formatBytes(r.sizeBytes)}</td>
                  <td className="px-4 py-3 text-muted">{formatDateTime(r.createdAt)}</td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1">
                      {r.status === "completed" && (
                        <a
                          href={`/api/v1/reports/${r.id}/download`}
                          download
                          aria-label={`Download ${label}`}
                          className={buttonClasses("secondary", "sm")}
                        >
                          <Download aria-hidden className="size-4" />
                          Download
                        </a>
                      )}
                      {r.status !== "running" && (
                        <button
                          type="button"
                          onClick={() => setDeleting(r)}
                          aria-label={`Delete ${label}`}
                          className={buttonClasses("ghost", "sm")}
                        >
                          <Trash2 aria-hidden className="size-4" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ConfirmDialog
        open={deleting !== null}
        title="Delete report?"
        description={
          deleting
            ? `The ${FORMAT_LABELS[deleting.format] ?? deleting.format} report of scan #${deleting.scanNumber} will be deleted. The scan, its issues and findings are not affected; you can generate the report again.`
            : ""
        }
        confirmLabel="Delete report"
        pending={pending}
        error={error}
        onConfirm={remove}
        onClose={() => {
          setDeleting(null);
          setError(null);
        }}
      />
    </>
  );
}
