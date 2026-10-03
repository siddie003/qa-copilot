import type { Metadata } from "next";
import { IssueList } from "@/components/issues/issue-list";
import { loadProjectForPage } from "@/server/loaders";

export const metadata: Metadata = { title: "Project issues" };

export default async function ProjectIssuesPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user, project } = await loadProjectForPage((await params).id);
  return (
    <IssueList
      userId={user.id}
      projectId={project.id}
      params={await searchParams}
      basePath={`/projects/${project.id}/issues`}
      showProject={false}
    />
  );
}
