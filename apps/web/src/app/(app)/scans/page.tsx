import { Radar } from "lucide-react";
import type { Metadata } from "next";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";

export const metadata: Metadata = { title: "Scans" };

export default function ScansPage() {
  return (
    <>
      <PageHeader
        title="Scans"
        description="Every QA scan with its live scanner status, duration and results."
      />
      <EmptyState
        icon={Radar}
        title="No scans yet"
        description="Scanning needs the crawler, browser automation and scanner modules, which are built in later phases."
        note="Crawler and live status: Phase 4. Scanners: Phase 5."
      />
    </>
  );
}
