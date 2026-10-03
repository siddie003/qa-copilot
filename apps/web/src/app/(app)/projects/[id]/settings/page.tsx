import { SCANNER_KEYS, SCANNER_LABELS, type ScanAuthSummary } from "@qa/core";
import { getDb, secretsRepo } from "@qa/db";
import type { Metadata } from "next";
import { serializeProject } from "@/server/projects";
import { loadProjectForPage } from "@/server/loaders";
import { DeleteProject } from "./delete-project";
import { ProjectSettingsForm } from "./project-settings-form";
import { SiteAuthSettings, type AuthSummary } from "./site-auth-settings";

export const metadata: Metadata = { title: "Project settings" };

export default async function ProjectSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { project } = await loadProjectForPage((await params).id);
  const p = serializeProject(project);
  const secret = await secretsRepo.getProjectSecret(
    getDb(),
    project.id,
    secretsRepo.SCAN_AUTH_KIND,
  );
  // Only the non-secret summary ever reaches the browser.
  const summary = (secret?.summary as ScanAuthSummary | undefined) ?? null;
  return (
    <div className="max-w-2xl space-y-8">
      <ProjectSettingsForm
        project={{ id: p.id, name: p.name, websiteUrl: p.websiteUrl, scanDefaults: p.scanDefaults }}
        scanners={SCANNER_KEYS.map((key) => ({ key, label: SCANNER_LABELS[key] }))}
      />
      <SiteAuthSettings projectId={p.id} summary={summary as AuthSummary | null} />
      <DeleteProject projectId={p.id} projectName={p.name} />
    </div>
  );
}
