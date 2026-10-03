import { FolderKanban } from "lucide-react";
import type { Metadata } from "next";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";

export const metadata: Metadata = { title: "Projects" };

export default function ProjectsPage() {
  return (
    <>
      <PageHeader
        title="Projects"
        description="Each project holds a website URL, its design reference, approved content and scan history."
      />
      <EmptyState
        icon={FolderKanban}
        title="Project management is not available yet"
        description="Creating and managing projects requires the database schema and sign-in, which are built next."
        note="Planned for Phase 2."
      />
    </>
  );
}
