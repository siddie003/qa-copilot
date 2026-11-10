import { defaultScanDefaults, getConfig, SCANNER_KEYS, SCANNER_LABELS } from "@qa/core";
import type { Metadata } from "next";
import { Breadcrumbs } from "@/components/ui/breadcrumbs";
import { PageHeader } from "@/components/ui/page-header";
import { ProjectWizard } from "./project-wizard";

export const metadata: Metadata = { title: "New project" };

export default function NewProjectPage() {
  const cfg = getConfig();
  return (
    <>
      <Breadcrumbs items={[{ label: "Projects", href: "/projects" }, { label: "New project" }]} />
      <PageHeader
        title="New project"
        description="Tell us which live website to test, then optionally add the design it should match and the text it should contain."
      />
      <ProjectWizard
        defaults={defaultScanDefaults({
          maxPages: cfg.SCAN_MAX_PAGES,
          maxDepth: cfg.SCAN_MAX_DEPTH,
        })}
        scanners={SCANNER_KEYS.map((key) => ({ key, label: SCANNER_LABELS[key] }))}
        maxUploadMb={cfg.MAX_UPLOAD_MB}
        integrations={{
          figmaServerToken: Boolean(cfg.FIGMA_ACCESS_TOKEN),
          aiConfigured: cfg.AI_PROVIDER !== "none",
        }}
      />
    </>
  );
}
