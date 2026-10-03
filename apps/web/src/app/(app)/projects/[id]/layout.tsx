import { ExternalLink } from "lucide-react";
import { Breadcrumbs } from "@/components/ui/breadcrumbs";
import { loadProjectForPage } from "@/server/loaders";
import { ProjectTabs } from "./project-tabs";

export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { project } = await loadProjectForPage(id);
  return (
    <>
      <Breadcrumbs items={[{ label: "Projects", href: "/projects" }, { label: project.name }]} />
      <div className="mb-4">
        <h1 className="text-2xl font-semibold tracking-tight">{project.name}</h1>
        <a
          href={project.websiteUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1 inline-flex items-center gap-1 break-all text-sm text-primary hover:underline"
        >
          {project.websiteUrl}
          <ExternalLink aria-hidden className="size-3.5 shrink-0" />
          <span className="sr-only">(opens in a new tab)</span>
        </a>
      </div>
      <ProjectTabs projectId={project.id} />
      <div className="mt-6">{children}</div>
    </>
  );
}
