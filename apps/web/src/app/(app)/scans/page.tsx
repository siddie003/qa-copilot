import { getDb, scansRepo } from "@qa/db";
import { Radar } from "lucide-react";
import type { Metadata } from "next";
import { ScanTable } from "@/components/scans/scan-table";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { requirePageUser } from "@/server/session";

export const metadata: Metadata = { title: "Scans" };
const PAGE_SIZE = 25;

export default async function ScansPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePageUser();
  const params = await searchParams;
  const page = Math.max(1, Number(params.page) || 1);
  const { items, total } = await scansRepo.listScans(getDb(), user.id, {
    page,
    pageSize: PAGE_SIZE,
  });
  return (
    <>
      <PageHeader title="Scans" description="Every QA scan across your projects, newest first." />
      {total === 0 ? (
        <EmptyState
          icon={Radar}
          title="No scans yet"
          description="Scans appear here as soon as one is started from a project. Status is read from the scan records, never simulated."
          note="The scan engine (crawler, browser automation, scanners) is built in Phases 4–5."
        />
      ) : (
        <>
          <ScanTable scans={items} showProject />
          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={total}
            basePath="/scans"
            params={params}
            noun="scans"
          />
        </>
      )}
    </>
  );
}
