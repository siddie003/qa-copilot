import type { Metadata } from "next";
import { IssueList } from "@/components/issues/issue-list";
import { PageHeader } from "@/components/ui/page-header";
import { requirePageUser } from "@/server/session";

export const metadata: Metadata = { title: "Issues" };

export default async function IssuesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePageUser();
  return (
    <>
      <PageHeader
        title="Issues"
        description="Evidence-backed issues across all projects, tracked across scans."
      />
      <IssueList userId={user.id} params={await searchParams} basePath="/issues" showProject />
    </>
  );
}
