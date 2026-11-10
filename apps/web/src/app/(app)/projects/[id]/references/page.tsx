import type { Metadata } from "next";
import { loadProjectForPage } from "@/server/loaders";
import { listFonts, listPageLinks } from "@/server/project-assets";
import { getReferenceState } from "@/server/references";
import { BrandFontsPanel } from "./brand-fonts-panel";
import { ContentDocumentsPanel } from "./content-documents-panel";
import { DesignReferencePanel } from "./design-reference-panel";
import { PageLinksPanel } from "./page-links-panel";

export const metadata: Metadata = { title: "References" };

export default async function ReferencesPage({ params }: { params: Promise<{ id: string }> }) {
  const { user, project } = await loadProjectForPage((await params).id);
  const [state, links, fonts] = await Promise.all([
    getReferenceState(user.id, project.id),
    listPageLinks(user.id, project.id),
    listFonts(user.id, project.id),
  ]);
  return (
    <div className="space-y-8">
      <p className="max-w-3xl text-sm text-muted">
        The design reference, brand fonts, approved content and selected pages the website is
        checked against. Extracted values are drafts until you confirm them; anything that cannot be
        matched to the website is reported as “Unable to verify”, never guessed.
      </p>
      <DesignReferencePanel projectId={project.id} state={state} />
      <BrandFontsPanel
        projectId={project.id}
        fonts={fonts}
        maxUploadMb={state.limits.maxUploadMb}
      />
      <ContentDocumentsPanel projectId={project.id} state={state} />
      <PageLinksPanel projectId={project.id} websiteUrl={project.websiteUrl} links={links} />
    </div>
  );
}
