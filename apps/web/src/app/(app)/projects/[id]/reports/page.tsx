import { getDb, reportsRepo } from "@qa/db";
import { FileText } from "lucide-react";
import type { Metadata } from "next";
import { ReportTable } from "@/components/reports/report-table";
import { EmptyState } from "@/components/ui/empty-state";
import { loadProjectForPage } from "@/server/loaders";

export const metadata: Metadata = { title: "Project reports" };

export default async function ProjectReportsPage({ params }: { params: Promise<{ id: string }> }) {
  const { user, project } = await loadProjectForPage((await params).id);
  const { items } = await reportsRepo.listReports(getDb(), user.id, {
    projectId: project.id,
    page: 1,
    pageSize: 100,
  });
  return items.length ? (
    <ReportTable reports={items} showProject={false} />
  ) : (
    <EmptyState
      icon={FileText}
      title="No reports yet"
      description="Reports (PDF, Markdown, JSON) are generated from a completed scan of this project."
      note="Report export: Phase 8."
    />
  );
}
