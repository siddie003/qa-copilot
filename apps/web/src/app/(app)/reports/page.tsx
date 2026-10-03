import { FileText } from "lucide-react";
import type { Metadata } from "next";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";

export const metadata: Metadata = { title: "Reports" };

export default function ReportsPage() {
  return (
    <>
      <PageHeader
        title="Reports"
        description="Developer-ready QA reports exported as PDF, Markdown or JSON."
      />
      <EmptyState
        icon={FileText}
        title="No reports yet"
        description="Reports are generated from stored scan data. A completed scan is required first."
        note="Report export: Phase 8."
      />
    </>
  );
}
