"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { PageLinksEditor, type PageLinkItem } from "@/components/projects/page-links-editor";
import { useToast } from "@/components/ui/toast";
import { ApiError, apiFetch } from "@/lib/api-client";

/** Page links of an existing project (stored immediately through the API). */
export function PageLinksPanel({
  projectId,
  websiteUrl,
  links,
}: {
  projectId: string;
  websiteUrl: string;
  links: PageLinkItem[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [removing, setRemoving] = useState<string[]>([]);

  return (
    <section
      aria-labelledby="page-links-heading"
      className="space-y-4 rounded-lg border border-border bg-surface p-5"
    >
      <div>
        <h2 id="page-links-heading" className="text-base font-semibold">
          Page links
        </h2>
        <p className="mt-1 text-sm text-muted">
          Pages every scan includes in addition to the pages found by following links. They are not
          limited by the maximum page count or link depth; a page that cannot be loaded is reported
          with its error on the scan&apos;s Pages list. Changes apply to the next scan.
        </p>
      </div>
      <PageLinksEditor
        websiteUrl={websiteUrl}
        links={links}
        removing={removing}
        onAdd={async (url) => {
          try {
            const link = await apiFetch<PageLinkItem>(`/api/v1/projects/${projectId}/page-links`, {
              method: "POST",
              body: { url },
            });
            toast.success(`${link.path} added.`);
            router.refresh();
            return null;
          } catch (err) {
            return err instanceof ApiError
              ? (err.fieldErrors.url ?? err.message)
              : "The page could not be added.";
          }
        }}
        onRemove={async (link) => {
          setRemoving((r) => [...r, link.id]);
          try {
            await apiFetch(`/api/v1/projects/${projectId}/page-links/${link.id}`, {
              method: "DELETE",
            });
            toast.success(`${link.path} removed.`);
            router.refresh();
          } catch (err) {
            toast.error(err instanceof ApiError ? err.message : "The page could not be removed.");
          } finally {
            setRemoving((r) => r.filter((x) => x !== link.id));
          }
        }}
      />
    </section>
  );
}
