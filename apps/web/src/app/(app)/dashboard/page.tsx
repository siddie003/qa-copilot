import { getDb, projectsRepo } from "@qa/db";
import { FolderKanban, LayoutDashboard } from "lucide-react";
import type { Metadata } from "next";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { requirePageUser } from "@/server/session";

export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const user = await requirePageUser();
  const projectCount = await projectsRepo.countOwnerProjects(getDb(), user.id);

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Issue counts, scanner status and recent scans across your projects."
      />
      {projectCount === 0 ? (
        <EmptyState
          icon={FolderKanban}
          title="No projects yet"
          description="Create a project for the website you want to QA. Dashboard figures are calculated from stored scans only."
          action={<ButtonLink href="/projects/new">Create project</ButtonLink>}
        />
      ) : (
        <EmptyState
          icon={LayoutDashboard}
          title={`${projectCount} project${projectCount === 1 ? "" : "s"}, no scan data yet`}
          description="Issue and scanner figures appear here once scans have run. Nothing is shown until real results exist."
          note="The full dashboard is built in Phase 3."
          action={
            <ButtonLink href="/projects" variant="secondary">
              View projects
            </ButtonLink>
          }
        />
      )}
    </>
  );
}
