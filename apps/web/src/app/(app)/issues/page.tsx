import { ListChecks } from "lucide-react";
import type { Metadata } from "next";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";

export const metadata: Metadata = { title: "Issues" };

export default function IssuesPage() {
  return (
    <>
      <PageHeader
        title="Issues"
        description="Evidence-backed issues detected by scanners, with status tracking across scans."
      />
      <EmptyState
        icon={ListChecks}
        title="No issues yet"
        description="Issues are created only from real scanner findings. None exist until a scan has run."
        note="Issue explorer: Phase 8."
      />
    </>
  );
}
