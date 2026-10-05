import type { Metadata } from "next";
import { loadProjectForPage } from "@/server/loaders";
import { getReferenceState } from "@/server/references";
import { ContentDocumentsPanel } from "./content-documents-panel";
import { DesignReferencePanel } from "./design-reference-panel";

export const metadata: Metadata = { title: "References" };

export default async function ReferencesPage({ params }: { params: Promise<{ id: string }> }) {
  const { user, project } = await loadProjectForPage((await params).id);
  const state = await getReferenceState(user.id, project.id);
  return (
    <div className="space-y-8">
      <p className="max-w-3xl text-sm text-muted">
        The design reference and approved content the website is compared against. Extracted values
        are drafts until you confirm them; anything that cannot be matched to the website is
        reported as “Unable to verify”, never guessed.
      </p>
      <DesignReferencePanel projectId={project.id} state={state} />
      <ContentDocumentsPanel projectId={project.id} state={state} />
    </div>
  );
}
