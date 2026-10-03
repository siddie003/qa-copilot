import { getDb, reportsRepo } from "@qa/db";
import { FileText } from "lucide-react";
import type { Metadata } from "next";
import { ReportTable } from "@/components/reports/report-table";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { requirePageUser } from "@/server/session";

export const metadata: Metadata = { title: "Reports" };
const PAGE_SIZE = 25;

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePageUser();
  const params = await searchParams;
  const page = Math.max(1, Number(params.page) || 1);
  const { items, total } = await reportsRepo.listReports(getDb(), user.id, {
    page,
    pageSize: PAGE_SIZE,
  });
  return (
    <>
      <PageHeader
        title="Reports"
        description="Developer-ready QA reports generated from stored scan data (PDF, Markdown, JSON)."
      />
      {total === 0 ? (
        <EmptyState
          icon={FileText}
          title="No reports yet"
          description="Reports are generated from a completed scan. None have been generated."
          note="Report generation and export: Phase 8."
        />
      ) : (
        <>
          <ReportTable reports={items} showProject />
          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={total}
            basePath="/reports"
            params={params}
            noun="reports"
          />
        </>
      )}
    </>
  );
}
