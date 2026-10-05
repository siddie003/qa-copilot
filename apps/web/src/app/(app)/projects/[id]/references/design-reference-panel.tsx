"use client";

import { parseFigmaUrl } from "@qa/core/figma";
import { describeSource, emptyDesignSpec, type TokenSource } from "@qa/core/design-spec";
import { FileText, PenTool } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { DesignSpecEditor } from "@/components/references/design-spec-editor";
import {
  isProcessing,
  ProcessingStatus,
  useRefreshWhile,
} from "@/components/references/processing-status";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field, inputClasses } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { ApiError, apiFetch, apiUpload } from "@/lib/api-client";
import { formatDateTime } from "@/lib/format";
import type { ReferenceState } from "@/server/references";

const ORIGIN_LABELS: Record<string, string> = {
  manual: "entered manually",
  figma: "from Figma",
  document: "from a brand guideline",
};

const fmtValue = (v: unknown) =>
  v === null || v === undefined ? "—" : Array.isArray(v) ? v.join(", ") : String(v);

/** Outcome of AI-assisted guideline reading (only present when an AI provider is configured). */
function aiSummary(ai: unknown): string | null {
  if (!ai || typeof ai !== "object") return null;
  const a = ai as Record<string, unknown>;
  if (a.status === "completed")
    return `AI-assisted reading (${String(a.model)}): ${Number(a.accepted ?? 0)} value(s) verified against the lines they cite; ${Number(a.rejected ?? 0)} discarded. Literally written values take precedence.`;
  if (a.status === "failed")
    return `AI-assisted reading failed: ${String(a.error)} Only literally written values were read.`;
  if (a.status === "skipped") return `AI-assisted reading skipped: ${String(a.reason)}.`;
  return null;
}

function List({ title, items }: { title: string; items: unknown }) {
  if (!Array.isArray(items) || !items.length) return null;
  return (
    <details className="mt-1 text-xs text-muted">
      <summary className="cursor-pointer">
        {title} ({items.length})
      </summary>
      <ul className="mt-1 list-disc space-y-0.5 pl-5">
        {items.slice(0, 50).map((x, i) => (
          <li key={i}>{String(x)}</li>
        ))}
      </ul>
    </details>
  );
}

export function DesignReferencePanel({
  projectId,
  state,
}: {
  projectId: string;
  state: ReferenceState;
}) {
  const router = useRouter();
  const toast = useToast();
  const { active, draft, history } = state.designSpec;
  const [pending, setPending] = useState<string | null>(null);
  const [figmaUrl, setFigmaUrl] = useState("");
  const [figmaError, setFigmaError] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [remove, setRemove] = useState<{ id: string; label: string } | null>(null);
  const guidelineInput = useRef<HTMLInputElement>(null);
  const [guidelineError, setGuidelineError] = useState<string | null>(null);
  useRefreshWhile(state.sources.some((s) => isProcessing(s.status)));

  async function run(label: string, fn: () => Promise<unknown>, success: string) {
    setPending(label);
    try {
      await fn();
      toast.success(success);
      router.refresh();
      return true;
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "The request failed.");
      return false;
    } finally {
      setPending(null);
    }
  }

  async function addFigma() {
    const parsed = parseFigmaUrl(figmaUrl);
    if (!parsed.ok) return setFigmaError(parsed.message);
    setFigmaError(null);
    if (
      await run(
        "figma",
        () =>
          apiFetch(`/api/v1/projects/${projectId}/references`, {
            method: "POST",
            body: { figmaUrl },
          }),
        "Figma link added. Its design values are read in the background.",
      )
    )
      setFigmaUrl("");
  }

  async function uploadGuideline() {
    const file = guidelineInput.current?.files?.[0];
    if (!file) return setGuidelineError("Choose a PDF, DOCX, TXT or Markdown file.");
    if (file.size > state.limits.maxUploadMb * 1024 * 1024)
      return setGuidelineError(`The file is larger than ${state.limits.maxUploadMb} MB.`);
    setGuidelineError(null);
    setPending("guideline");
    try {
      await apiUpload(`/api/v1/projects/${projectId}/guideline-documents`, file);
      toast.success(`“${file.name}” uploaded. Values are extracted in the background.`);
      if (guidelineInput.current) guidelineInput.current.value = "";
      router.refresh();
    } catch (err) {
      setGuidelineError(err instanceof ApiError ? err.message : "The upload failed.");
    } finally {
      setPending(null);
    }
  }

  async function saveToken() {
    if (token.trim().length < 10) return setTokenError("Enter the Figma personal access token.");
    setTokenError(null);
    if (
      await run(
        "token",
        () =>
          apiFetch(`/api/v1/projects/${projectId}/figma-token`, { method: "PUT", body: { token } }),
        "Figma token saved (encrypted).",
      )
    )
      setToken("");
  }

  const tokenAvailable = state.figma.serverTokenConfigured || state.figma.projectTokenConfigured;

  return (
    <section
      aria-labelledby="design-ref-heading"
      className="space-y-4 rounded-lg border border-border bg-surface p-5"
    >
      <div>
        <h2 id="design-ref-heading" className="text-base font-semibold">
          Design reference
        </h2>
        <p className="mt-1 text-sm text-muted">
          {active
            ? `Active: version ${active.version} (${ORIGIN_LABELS[active.origin] ?? active.origin}), ${active.valueCount} values${active.confirmedAt ? `, confirmed ${formatDateTime(active.confirmedAt)}` : ""}. New scans compare against this version.`
            : "No confirmed design reference yet. Scans skip the design comparison and report design values as “Unable to verify”."}
        </p>
      </div>

      {draft && (
        <div className="space-y-3 rounded-md border border-warning/40 bg-warning-bg/40 p-4">
          <p className="text-sm font-medium">
            Draft version {draft.version} {ORIGIN_LABELS[draft.origin] ?? ""} is waiting for review:{" "}
            {draft.changes.length} change{draft.changes.length === 1 ? "" : "s"}. Check each value
            against its source before confirming; nothing is used for scans until you confirm.
          </p>
          <div
            role="region"
            aria-label="Draft changes"
            tabIndex={0}
            className="relative max-h-96 overflow-auto rounded border border-border bg-surface"
          >
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="sticky top-0 border-b border-border bg-surface-muted text-xs text-muted">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Value
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Current
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Proposed
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Source
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {draft.changes.map((c) => (
                  <tr key={c.path}>
                    <td className="px-3 py-2 font-mono text-xs">{c.path}</td>
                    <td className="px-3 py-2">{fmtValue(c.before)}</td>
                    <td className="px-3 py-2 font-medium">{fmtValue(c.after)}</td>
                    <td className="px-3 py-2 text-xs text-muted">
                      {describeSource(c.source as TokenSource | null)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={pending !== null}
              onClick={() =>
                run(
                  "confirm",
                  () =>
                    apiFetch(`/api/v1/projects/${projectId}/design-spec/draft/confirm`, {
                      method: "POST",
                      body: { version: draft.version },
                    }),
                  `Design reference version ${draft.version} is now active.`,
                )
              }
            >
              {pending === "confirm" ? "Confirming…" : "Confirm draft"}
            </Button>
            <Button
              variant="secondary"
              disabled={pending !== null}
              onClick={() =>
                run(
                  "discard",
                  () =>
                    apiFetch(`/api/v1/projects/${projectId}/design-spec/draft`, {
                      method: "DELETE",
                    }),
                  "Draft discarded.",
                )
              }
            >
              Discard draft
            </Button>
          </div>
        </div>
      )}

      <div className="space-y-3">
        <h3 className="text-sm font-semibold">Sources</h3>
        {state.sources.length === 0 ? (
          <p className="text-sm text-muted">No Figma file or brand guideline added.</p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {state.sources.map((s) => {
              const meta = (s.meta ?? {}) as Record<string, unknown>;
              const label =
                s.kind === "figma"
                  ? (s.figmaUrl ?? "Figma file")
                  : String(meta.filename ?? "Guideline document");
              const Icon = s.kind === "figma" ? PenTool : FileText;
              return (
                <li key={s.id} className="space-y-1 px-4 py-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-2">
                      <Icon aria-hidden className="size-4 shrink-0 text-muted" />
                      <span className="break-all font-medium">{label}</span>
                    </span>
                    <span className="flex items-center gap-2">
                      <ProcessingStatus status={s.status} />
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={isProcessing(s.status) || pending !== null}
                        onClick={() =>
                          run(
                            `refresh-${s.id}`,
                            () =>
                              apiFetch(`/api/v1/projects/${projectId}/references/${s.id}/refresh`, {
                                method: "POST",
                              }),
                            "Queued again.",
                          )
                        }
                      >
                        {s.kind === "figma" ? "Fetch again" : "Extract again"}
                        <span className="sr-only"> {label}</span>
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setRemove({ id: s.id, label })}
                      >
                        Remove<span className="sr-only"> {label}</span>
                      </Button>
                    </span>
                  </div>
                  {s.error && <p className="text-danger">{s.error}</p>}
                  {s.status === "ready" && (
                    <p className="text-muted">
                      {typeof meta.fileName === "string" ? `“${meta.fileName}” · ` : ""}
                      {Number(meta.valuesFound ?? 0)} value
                      {Number(meta.valuesFound) === 1 ? "" : "s"} found
                      {meta.draftVersion ? ` → draft version ${String(meta.draftVersion)}` : ""}
                      {s.fetchedAt ? ` · ${formatDateTime(s.fetchedAt)}` : ""}
                      {typeof meta.note === "string" ? ` · ${meta.note}` : ""}
                    </p>
                  )}
                  {s.status === "ready" && aiSummary(meta.ai) && (
                    <p className="text-xs text-muted">{aiSummary(meta.ai)}</p>
                  )}
                  <List title="Values read" items={meta.extracted} />
                  <List title="Not used" items={meta.skipped} />
                </li>
              );
            })}
          </ul>
        )}

        <div className="grid gap-4 lg:grid-cols-2">
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              void addFigma();
            }}
          >
            <Field
              label="Add a Figma file or frame link"
              hint="Text styles, color styles, Button components and a “Container” frame are read."
              error={figmaError ?? undefined}
            >
              {({ id, describedBy, invalid }) => (
                <input
                  id={id}
                  value={figmaUrl}
                  onChange={(e) => setFigmaUrl(e.target.value)}
                  inputMode="url"
                  placeholder="https://www.figma.com/design/…"
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  className={inputClasses}
                />
              )}
            </Field>
            <Button
              type="submit"
              variant="secondary"
              disabled={!figmaUrl.trim() || pending !== null}
            >
              Add Figma link
            </Button>
          </form>
          <div className="space-y-2">
            <Field
              label="Upload a brand guideline"
              hint={`PDF, DOCX, TXT or Markdown, up to ${state.limits.maxUploadMb} MB. Only values written literally (e.g. “Primary — #1A56DB”) are read, with citations.`}
              error={guidelineError ?? undefined}
            >
              {({ id, describedBy, invalid }) => (
                <input
                  id={id}
                  ref={guidelineInput}
                  type="file"
                  accept=".pdf,.docx,.txt,.md,.markdown"
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-border-strong file:bg-surface file:px-3 file:py-1.5 file:text-sm file:font-medium"
                />
              )}
            </Field>
            <Button variant="secondary" onClick={uploadGuideline} disabled={pending !== null}>
              {pending === "guideline" ? "Uploading…" : "Upload guideline"}
            </Button>
          </div>
        </div>

        <div className="rounded-md border border-border p-3 text-sm">
          <p className="font-medium">Figma access</p>
          {state.figma.projectTokenConfigured ? (
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span className="text-muted">
                A personal access token is saved for this project (encrypted).
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={pending !== null}
                onClick={() =>
                  run(
                    "token-remove",
                    () =>
                      apiFetch(`/api/v1/projects/${projectId}/figma-token`, { method: "DELETE" }),
                    "Figma token removed.",
                  )
                }
              >
                Remove token
              </Button>
            </div>
          ) : (
            <p className="mt-1 text-muted">
              {state.figma.serverTokenConfigured
                ? "The server's Figma token (FIGMA_ACCESS_TOKEN) is used. You can save a token for this project instead."
                : "No Figma token is configured. Figma links stay “Unavailable” until a token is saved; you can enter values manually below."}
            </p>
          )}
          {!state.figma.projectTokenConfigured && (
            <form
              className="mt-2 flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void saveToken();
              }}
            >
              <Field
                label="Figma personal access token"
                error={tokenError ?? undefined}
                className="min-w-64 flex-1"
              >
                {({ id, describedBy, invalid }) => (
                  <input
                    id={id}
                    type="password"
                    autoComplete="off"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    className={inputClasses}
                    disabled={!state.figma.encryptionAvailable}
                  />
                )}
              </Field>
              <Button
                type="submit"
                variant="secondary"
                disabled={!state.figma.encryptionAvailable || pending !== null}
              >
                Save token
              </Button>
              {!state.figma.encryptionAvailable && (
                <p className="w-full text-xs text-muted">
                  Tokens can be stored only when ENCRYPTION_KEY is configured on the server.
                </p>
              )}
            </form>
          )}
          {!tokenAvailable && state.sources.some((s) => s.kind === "figma") && (
            <p className="mt-2 text-xs text-muted">
              After saving a token, use “Fetch again” on the Figma link.
            </p>
          )}
        </div>
      </div>

      <div className="space-y-3 border-t border-border pt-4">
        <h3 className="text-sm font-semibold">Values</h3>
        <DesignSpecEditor
          key={active?.version ?? 0}
          initial={active?.spec ?? emptyDesignSpec()}
          submitLabel={active ? "Save as new version" : "Save design reference"}
          pending={pending === "save"}
          disabled={Boolean(draft)}
          disabledReason="Confirm or discard the draft first."
          onSubmit={async (spec) => {
            await run(
              "save",
              () =>
                apiFetch(`/api/v1/projects/${projectId}/design-spec`, {
                  method: "PUT",
                  body: spec,
                }),
              "Design reference saved.",
            );
          }}
        />
        {history.length > 1 && (
          <p className="text-xs text-subtle">
            Earlier versions:{" "}
            {history
              .slice(1)
              .map((h) => `v${h.version} (${ORIGIN_LABELS[h.origin] ?? h.origin})`)
              .join(", ")}
            . Past scans keep the version they used.
          </p>
        )}
      </div>

      <ConfirmDialog
        open={remove !== null}
        title="Remove this source?"
        description="Values already confirmed in the design reference stay (with their citation). The uploaded file is deleted."
        confirmLabel={pending === "remove" ? "Removing…" : "Remove"}
        pending={pending === "remove"}
        onClose={() => setRemove(null)}
        onConfirm={async () => {
          if (!remove) return;
          if (
            await run(
              "remove",
              () =>
                apiFetch(`/api/v1/projects/${projectId}/references/${remove.id}`, {
                  method: "DELETE",
                }),
              "Source removed.",
            )
          )
            setRemove(null);
        }}
      />
    </section>
  );
}
