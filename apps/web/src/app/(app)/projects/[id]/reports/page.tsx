import { REPORTABLE_SCAN_STATUSES } from "@qa/core";
import { getDb, reportsRepo, scansRepo } from "@qa/db";
import { FileText } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { GenerateReport } from "@/components/reports/generate-report";
import { ReportTable } from "@/components/reports/report-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Card } from "@/components/ui/stat";
import { formatDateTime, scanStatusLabel } from "@/lib/format";
import { loadProjectForPage } from "@/server/loaders";

export const metadata: Metadata = { title: "Project reports" };

const REPORTABLE = new Set<string>(REPORTABLE_SCAN_STATUSES);

export default async function ProjectReportsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user, project } = await loadProjectForPage((await params).id);
  const q = await searchParams;
  const [{ items }, scans] = await Promise.all([
    reportsRepo.listReports(getDb(), user.id, { projectId: project.id, page: 1, pageSize: 100 }),
    scansRepo.listScans(getDb(), user.id, { projectId: project.id, page: 1, pageSize: 50 }),
  ]);
  const finished = scans.items.filter((s) => REPORTABLE.has(s.status));
  const requested = typeof q.scan === "string" ? q.scan : "";
  const defaultScanId = finished.some((s) => s.id === requested)
    ? requested
    : (finished[0]?.id ?? "");

  return (
    <div className="space-y-6">
      <Card title="Generate a report">
        {finished.length === 0 ? (
          <p className="text-sm text-muted">
            Reports are built from a finished scan&apos;s stored results.{" "}
            {scans.items.length ? (
              "The scan of this project has not finished yet."
            ) : (
              <>
                This project has not been scanned yet.{" "}
                <Link href={`/projects/${project.id}/scan`} className="text-primary underline">
                  Start a scan
                </Link>
                .
              </>
            )}
          </p>
        ) : (
          <>
            <p className="mb-4 text-sm text-muted">
              A report contains the scan&apos;s settings, every scanner and step result (including
              failed, inconclusive and skipped ones and the checks that could not be verified), and
              every issue with its current status, verdict, fix guidance and source findings. It is
              built only from stored scan data.
            </p>
            <GenerateReport
              scans={finished.map((s) => ({
                id: s.id,
                number: s.number,
                statusLabel: scanStatusLabel(s.status),
                createdAt: formatDateTime(s.createdAt),
              }))}
              defaultScanId={defaultScanId}
            />
          </>
        )}
      </Card>
      {items.length ? (
        <ReportTable reports={items} showProject={false} />
      ) : (
        <EmptyState
          icon={FileText}
          title="No reports yet"
          description="Generated PDF, Markdown and JSON reports of this project's scans appear here."
        />
      )}
    </div>
  );
}
