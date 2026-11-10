"use client";

import { CONTENT_ACCEPT, contentKindForFilename } from "@qa/core/content";
import { useRouter } from "next/navigation";
import { Fragment, useRef, useState } from "react";
import { CoverageSummary, DocumentStatus } from "@/components/references/document-status";
import { isProcessing, useRefreshWhile } from "@/components/references/processing-status";
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
                const meta = (d.meta ?? {}) as {
                  warnings?: string[];
                  reusedFrom?: { filename: string };
                };
                // The coverage summary shows page-level problems; other warnings (e.g. Word
                // conversion messages) are listed here.
                const otherWarnings = (meta.warnings ?? []).filter(
                  (w) => !d.coverage || !/page\(s\)|blocks? (longer|of the document)/.test(w),
                );
                const canContinue =
                  d.parseStatus === "cancelled" || (d.parseStatus === "parsed" && d.resumable);
                return (
                  <Fragment key={d.id}>
                    <tr className="align-top">
                      <td className="px-3 py-2">
                        <span className="break-all font-medium">{d.filename}</span>
                        <span className="block text-xs text-subtle">
                          {formatBytes(d.sizeBytes)}
                          {d.attempts > 1 && d.parseStatus === "parsing"
                            ? ` · attempt ${d.attempts}`
                            : ""}
                        </span>
                        <CoverageSummary doc={d} />
                        {meta.reusedFrom && (
                          <span className="block text-xs text-subtle">
                            Identical to “{meta.reusedFrom.filename}”: its results were reused
                            instead of reading the file again.
                          </span>
                        )}
                        {otherWarnings.map((w) => (
                          <span key={w} className="block text-xs text-warning">
                            {w}
                          </span>
                        ))}
                      </td>
                      <td className="px-3 py-2">
                        <DocumentStatus doc={d} />
                        {d.parseError && (
                          <span className="mt-1 block max-w-xs text-xs text-danger">
                            {d.parseError}
                          </span>
                        )}
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
                          {isProcessing(d.parseStatus) && !d.cancelRequestedAt && (
                            <Button
                              variant="secondary"
                              size="sm"
                              disabled={busy}
                              onClick={() =>
                                act(
                                  () =>
                                    apiFetch(`/api/v1/content-documents/${d.id}/cancel`, {
                                      method: "POST",
                                    }),
                                  d.parseStatus === "pending"
                                    ? `Processing of “${d.filename}” was cancelled.`
                                    : `Cancelling “${d.filename}”; pages already read are kept.`,
                                )
                              }
                            >
                              Cancel<span className="sr-only"> processing of {d.filename}</span>
                            </Button>
                          )}
                          {canContinue && (
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
                                  `“${d.filename}” queued to continue where it stopped.`,
                                )
                              }
                            >
                              Continue reading<span className="sr-only"> {d.filename}</span>
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
                        <td colSpan={4} className="bg-surface-muted/50 px-3 py-3">
                          {open.error && <Alert tone="error">{open.error}</Alert>}
                          {open.blocks && d.blockCount > open.blocks.length && (
                            <p className="mb-2 text-xs text-muted">
                              Showing the first {open.blocks.length.toLocaleString("en-US")} of{" "}
                              {d.blockCount.toLocaleString("en-US")} blocks. Search the approved
                              content below to find text anywhere in the document.
                            </p>
                          )}
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
          hint={`PDF, DOCX, TXT or Markdown, up to ${state.limits.maxUploadMb} MB each. PDFs are read page by page; pages that are only images (scans) cannot be read because OCR is not available, and are listed.`}
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

      {docs.some((d) => d.parseStatus === "parsed") && <ContentSearch projectId={projectId} />}

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

interface SearchResult {
  documentId: string;
  filename: string;
  section: string | null;
  pageHint: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  chunkIndex: number;
  excerpt: string;
}

/**
 * Full-text search over the indexed approved content (all parsed documents of the project).
 * Results show the document, section and pages each excerpt comes from.
 */
function ContentSearch({ projectId }: { projectId: string }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [searched, setSearched] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  async function search() {
    const query = q.trim();
    if (!query) return;
    setPending(true);
    setError(null);
    try {
      const r = await apiFetch<{ results: SearchResult[] }>(
        `/api/v1/projects/${projectId}/content-search?q=${encodeURIComponent(query)}`,
      );
      setResults(r.results);
      setSearched(query);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "The search failed.");
    } finally {
      setPending(false);
    }
  }
  const pages = (r: SearchResult) =>
    r.pageStart === null
      ? null
      : r.pageStart === r.pageEnd
        ? `PDF page ${r.pageStart}`
        : `PDF pages ${r.pageStart}–${r.pageEnd}`;
  return (
    <div className="space-y-3 border-t border-border pt-4">
      <form
        role="search"
        aria-label="Search approved content"
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <Field
          label="Search approved content"
          hint="Sections containing all the words come first; if there are none, sections with any of them."
          className="min-w-64 flex-1"
        >
          {({ id, describedBy }) => (
            <input
              id={id}
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              maxLength={500}
              placeholder="e.g. pricing plans"
              aria-describedby={describedBy}
              className={inputClasses}
            />
          )}
        </Field>
        <Button type="submit" variant="secondary" disabled={pending || !q.trim()} className="mb-5">
          {pending ? "Searching…" : "Search"}
        </Button>
      </form>
      {error && <Alert tone="error">{error}</Alert>}
      {results && (
        <div aria-live="polite">
          {results.length === 0 ? (
            <p className="text-sm text-muted">No indexed section contains “{searched}”.</p>
          ) : (
            <ol className="space-y-2" aria-label={`Search results for ${searched}`}>
              {results.map((r) => (
                <li
                  key={`${r.documentId}:${r.chunkIndex}`}
                  className="rounded-md border border-border p-3 text-sm"
                >
                  <p className="text-xs text-muted">
                    <span className="font-medium text-foreground">{r.filename}</span>
                    {[r.section, r.pageHint ? `page: ${r.pageHint}` : null, pages(r)]
                      .filter(Boolean)
                      .map((x) => ` · ${x}`)
                      .join("")}
                  </p>
                  <p className="mt-1 whitespace-pre-line break-words">{r.excerpt}</p>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}
