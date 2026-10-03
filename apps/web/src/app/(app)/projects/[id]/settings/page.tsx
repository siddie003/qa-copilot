import { SCANNER_KEYS, SCANNER_LABELS } from "@qa/core";
import type { Metadata } from "next";
import { serializeProject } from "@/server/projects";
import { loadProjectForPage } from "@/server/loaders";
import { DeleteProject } from "./delete-project";
import { ProjectSettingsForm } from "./project-settings-form";

export const metadata: Metadata = { title: "Project settings" };

export default async function ProjectSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { project } = await loadProjectForPage((await params).id);
  const p = serializeProject(project);
  return (
    <div className="max-w-2xl space-y-8">
      <ProjectSettingsForm
        project={{ id: p.id, name: p.name, websiteUrl: p.websiteUrl, scanDefaults: p.scanDefaults }}
        scanners={SCANNER_KEYS.map((key) => ({ key, label: SCANNER_LABELS[key] }))}
      />
      <DeleteProject projectId={p.id} projectName={p.name} />
    </div>
  );
}
