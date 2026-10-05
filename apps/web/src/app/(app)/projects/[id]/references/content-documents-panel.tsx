"use client";

import { CONTENT_ACCEPT, contentKindForFilename } from "@qa/core/content";
import { useRouter } from "next/navigation";
import { Fragment, useRef, useState } from "react";
import {
  isProcessing,
  ProcessingStatus,
  useRefreshWhile,
} from "@/components/references/processing-status";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field, inputClasses } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { ApiError, apiFetch, apiUpload } from "@/lib/api-client";
import { cn } from "@/lib/cn";
import { formatBytes } from "@/lib/format";
import type { ReferenceState } from "@/server/references";

type Doc = ReferenceState["documents"][number];
interface Block {
  id: string;
  order: number;
  type: string;
  level: number | null;
  text: string;
  href: string | null;
  pageHint: string | null;
  location: { page?: number; line?: number } | null;
}

const BLOCK_LABELS: Record<string, string> = {
  heading: "Heading",
  paragraph: "Paragraph",
  list_item: "List item",
  cta: "Call to action",
  link: "Link",
  emphasis: "Emphasis",
};

function Mapping({ doc }: { doc: Doc }) {
  const router = useRouter();
  const toast = useToast();
  const [value, setValue] = useState(doc.targetPath ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const dirty = value.trim() !== (doc.targetPath ?? "");
  async function save() {
    setSaving(true);
    setError(null);
    try {
      await apiFetch(`/api/v1/content-documents/${doc.id}`, {
        method: "PATCH",
        body: { targetPath: value.trim() },
      });
      toast.success(
        value.trim() ? `“${doc.filename}” is mapped to ${value.trim()}.` : "Page mapping removed.",
      );
      router.refresh();
    } catch (err) {
      setError(
        err instanceof ApiError ? (err.fieldErrors.targetPath ?? err.message) : "Could not save.",
      );
    } finally {
      setSaving(false);
    }
  }
  return (
    <form
      className="flex items-start gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="min-w-0">
        <input
          aria-label={`Website page for ${doc.filename}`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Automatic"
          aria-invalid={Boolean(error)}
          className={cn(inputClasses, "h-8 w-36 px-2 font-mono text-sm")}
        />
        {error && <p className="mt-1 text-xs font-medium text-danger">{error}</p>}
      </div>
      {dirty && (
        <Button type="submit" size="sm" variant="secondary" disabled={saving}>
          Save<span className="sr-only"> page mapping for {doc.filename}</span>
        </Button>
      )}
    </form>
  );
}

export function ContentDocumentsPanel({
  projectId,
  state,
}: {
  projectId: string;
  state: ReferenceState;
}) {
  const router = useRouter();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadErrors, setUploadErrors] = useState<string[]>([]);
  const [targetPath, setTargetPath] = useState("");
  const [open, setOpen] = useState<{ id: string; blocks: Block[] | null; error?: string } | null>(
    null,
  );
  const [remove, setRemove] = useState<Doc | null>(null);
  const [busy, setBusy] = useState(false);
  const docs = state.documents;
  useRefreshWhile(docs.some((d) => isProcessing(d.parseStatus)));

  async function upload() {
    const files = [...(input.current?.files ?? [])];
    if (!files.length) return setUploadErrors(["Choose one or more files."]);
    const problems: string[] = [];
    const maxBytes = state.limits.maxUploadMb * 1024 * 1024;
    const valid = files.filter((f) => {
      if (!contentKindForFilename(f.name))
        problems.push(`${f.name}: only PDF, DOCX, TXT and Markdown files are supported.`);
      else if (f.size > maxBytes)
        problems.push(`${f.name}: larger than ${state.limits.maxUploadMb} MB.`);
      else return true;
      return false;
    });
    setUploading(true);
    let ok = 0;
    for (const f of valid) {
      try {
        await apiUpload(
          `/api/v1/projects/${projectId}/content-documents`,
          f,
          targetPath.trim() ? { targetPath: targetPath.trim() } : {},
        );
        ok += 1;
      } catch (err) {
        problems.push(`${f.name}: ${err instanceof ApiError ? err.message : "upload failed"}`);
      }
    }
    setUploading(false);
    setUploadErrors(problems);
    if (ok) {
      toast.success(
        `${ok} document${ok === 1 ? "" : "s"} uploaded. Text is extracted in the background.`,
      );
      if (input.current) input.current.value = "";
      setTargetPath("");
      router.refresh();
    }
  }

  async function toggleBlocks(doc: Doc) {
    if (open?.id === doc.id) return setOpen(null);
    setOpen({ id: doc.id, blocks: null });
    try {
      const r = await apiFetch<{ blocks: Block[] }>(`/api/v1/content-documents/${doc.id}/blocks`);
      setOpen({ id: doc.id, blocks: r.blocks });
    } catch (err) {
      setOpen({
        id: doc.id,
        blocks: [],
        error: err instanceof ApiError ? err.message : "Could not load blocks.",
      });
    }
  }

  async function act(fn: () => Promise<unknown>, success: string) {
    setBusy(true);
    try {
      await fn();
      toast.success(success);
      router.refresh();
      return true;
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "The request failed.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-labelledby="content-heading"
      className="space-y-4 rounded-lg border border-border bg-surface p-5"
    >
      <div>
        <h2 id="content-heading" className="text-base font-semibold">
          Approved content
        </h2>
        <p className="mt-1 text-sm text-muted">
          Documents with the approved website copy. Each one is matched to a page by its page
          mapping, by “Page: …” / “URL: /…” markers inside the document, or by its headings. Text
          that cannot be tied to a crawled page is reported as “Unable to verify”.
        </p>
      </div>

      {docs.length === 0 ? (
        <p className="text-sm text-muted">
          No documents uploaded. Scans skip the content comparison.
        </p>
      ) : (
        <div
          role="region"
          aria-label="Content documents"
          tabIndex={0}
          className="relative overflow-x-auto rounded-md border border-border"
        >
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="border-b border-border bg-surface-muted text-xs uppercase tracking-wide text-muted">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  Document
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Status
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Blocks
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Website page
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {docs.map((d) => {
                const meta = (d.meta ?? {}) as { pages?: number; warnings?: string[] };
                return (
                  <Fragment key={d.id}>
                    <tr className="align-top">
                      <td className="px-3 py-2">
                        <span className="break-all font-medium">{d.filename}</span>
                        <span className="block text-xs text-subtle">
                          {formatBytes(d.sizeBytes)}
                          {meta.pages ? ` · ${meta.pages} page${meta.pages === 1 ? "" : "s"}` : ""}
                        </span>
                        {meta.warnings?.map((w) => (
                          <span key={w} className="block text-xs text-warning">
                            {w}
                          </span>
                        ))}
                      </td>
                      <td className="px-3 py-2">
                        <ProcessingStatus status={d.parseStatus} />
                        {d.parseError && (
                          <span className="mt-1 block max-w-xs text-xs text-danger">
                            {d.parseError}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {d.parseStatus === "parsed" ? d.blockCount : "—"}
                      </td>
                      <td className="px-3 py-2">
                        <Mapping doc={d} />
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex justify-end gap-1">
                          {d.parseStatus === "parsed" && (
                            <Button
                              variant="secondary"
                              size="sm"
                              aria-expanded={open?.id === d.id}
                              onClick={() => toggleBlocks(d)}
                            >
                              {open?.id === d.id ? "Hide text" : "View text"}
                              <span className="sr-only"> of {d.filename}</span>
                            </Button>
                          )}
                          {d.parseStatus === "failed" && (
                            <Button
                              variant="secondary"
                              size="sm"
                              disabled={busy}
                              onClick={() =>
                                act(
                                  () =>
                                    apiFetch(`/api/v1/content-documents/${d.id}/retry`, {
                                      method: "POST",
                                    }),
                                  `“${d.filename}” queued again.`,
                                )
                              }
                            >
                              Retry<span className="sr-only"> {d.filename}</span>
                            </Button>
                          )}
                          <Button variant="ghost" size="sm" onClick={() => setRemove(d)}>
                            Delete<span className="sr-only"> {d.filename}</span>
                          </Button>
                        </div>
                      </td>
                    </tr>
                    {open?.id === d.id && (
                      <tr>
                        <td colSpan={5} className="bg-surface-muted/50 px-3 py-3">
                          {open.error && <Alert tone="error">{open.error}</Alert>}
                          {!open.blocks ? (
                            <p className="text-sm text-muted">Loading…</p>
                          ) : (
                            <ol
                              tabIndex={0}
                              aria-label={`Extracted text of ${d.filename}`}
                              className="max-h-96 space-y-1 overflow-auto text-sm"
                            >
                              {open.blocks.map((b) => (
                                <li key={b.id} className="flex gap-2">
                                  <span className="w-28 shrink-0 text-xs font-medium text-muted">
                                    {BLOCK_LABELS[b.type] ?? b.type}
                                    {b.level ? ` ${b.level}` : ""}
                                  </span>
                                  <span className="min-w-0">
                                    <span
                                      className={b.type === "heading" ? "font-semibold" : undefined}
                                    >
                                      {b.text}
                                    </span>
                                    {b.href && (
                                      <span className="ml-1 font-mono text-xs text-muted">
                                        → {b.href}
                                      </span>
                                    )}
                                    <span className="block text-xs text-subtle">
                                      {[
                                        b.pageHint ? `page: ${b.pageHint}` : null,
                                        b.location?.page ? `PDF page ${b.location.page}` : null,
                                        b.location?.line ? `line ${b.location.line}` : null,
                                      ]
                                        .filter(Boolean)
                                        .join(" · ")}
                                    </span>
                                  </span>
                                </li>
                              ))}
                            </ol>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-[1fr_12rem_auto] sm:items-end">
        <Field
          label="Upload documents"
          hint={`PDF, DOCX, TXT or Markdown, up to ${state.limits.maxUploadMb} MB each. Scanned (image-only) PDFs are not supported.`}
        >
          {({ id, describedBy }) => (
            <input
              id={id}
              ref={input}
              type="file"
              multiple
              accept={CONTENT_ACCEPT}
              aria-describedby={describedBy}
              className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-border-strong file:bg-surface file:px-3 file:py-1.5 file:text-sm file:font-medium"
            />
          )}
        </Field>
        <Field label="Website page (optional)" hint="e.g. /about">
          {({ id, describedBy }) => (
            <input
              id={id}
              value={targetPath}
              onChange={(e) => setTargetPath(e.target.value)}
              placeholder="Automatic"
              aria-describedby={describedBy}
              className={cn(inputClasses, "font-mono")}
            />
          )}
        </Field>
        <Button onClick={upload} disabled={uploading} className="sm:mb-5">
          {uploading ? "Uploading…" : "Upload"}
        </Button>
      </div>
      {uploadErrors.length > 0 && (
        <Alert tone="error">
          <ul className="list-disc pl-4">
            {uploadErrors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </Alert>
      )}

      <ConfirmDialog
        open={remove !== null}
        title={`Delete “${remove?.filename ?? ""}”?`}
        description="The document and its extracted text are deleted. Completed scans keep their results."
        confirmLabel={busy ? "Deleting…" : "Delete document"}
        pending={busy}
        onClose={() => setRemove(null)}
        onConfirm={async () => {
          if (
            remove &&
            (await act(
              () => apiFetch(`/api/v1/content-documents/${remove.id}`, { method: "DELETE" }),
              "Document deleted.",
            ))
          )
            setRemove(null);
        }}
      />
    </section>
  );
}
