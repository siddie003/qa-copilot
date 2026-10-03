import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { NewProjectForm } from "./new-project-form";

export const metadata: Metadata = { title: "New project" };

export default function NewProjectPage() {
  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-2 text-sm text-muted">
        <Link href="/projects" className="hover:underline">
          Projects
        </Link>{" "}
        / New project
      </nav>
      <PageHeader
        title="New project"
        description="Start with the website to QA. Figma or brand references, approved content and scan options are added in the project afterwards."
      />
      <div className="max-w-xl rounded-lg border border-border bg-surface p-6">
        <NewProjectForm />
      </div>
    </>
  );
}
