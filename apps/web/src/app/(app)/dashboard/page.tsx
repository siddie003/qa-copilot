import { LayoutDashboard } from "lucide-react";
import type { Metadata } from "next";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";

export const metadata: Metadata = { title: "Dashboard" };

export default function DashboardPage() {
  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Issue counts, scanner status and recent scans across your projects."
      />
      <EmptyState
        icon={LayoutDashboard}
        title="No project data yet"
        description="Dashboard figures are calculated from scans stored in the database. Nothing is shown until real scans exist."
        note="Projects arrive in Phase 2; the full dashboard in Phase 3."
      />
    </>
  );
}
