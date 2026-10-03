import { getDb, scansRepo } from "@qa/db";
import { History } from "lucide-react";
import type { Metadata } from "next";
import { ScanTable } from "@/components/scans/scan-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Pagination } from "@/components/ui/pagination";
import { loadProjectForPage } from "@/server/loaders";

export const metadata: Metadata = { title: "Scan history" };
const PAGE_SIZE = 25;

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
  const { items, total } = await scansRepo.listScans(getDb(), user.id, {
    projectId: project.id,
    page,
    pageSize: PAGE_SIZE,
  });

  if (total === 0) {
    return (
      <EmptyState
        icon={History}
        title="No scan history yet"
        description="Every scan of this project is kept here. Comparing two scans (new, resolved, persistent and reopened issues) becomes available in Phase 9."
      />
    );
  }
  return (
    <>
      <ScanTable scans={items} showProject={false} />
      <Pagination
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        basePath={`/projects/${project.id}/history`}
        params={query}
        noun="scans"
      />
    </>
  );
}
