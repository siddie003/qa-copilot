"use client";

import { FONT_ACCEPT, fontFormatForFilename, MAX_FONT_FILE_MB } from "@qa/core/fonts";
import { Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { UploadList, type UploadItem } from "@/components/projects/selected-files";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { ApiError, apiFetch, apiUploadWithProgress } from "@/lib/api-client";
import { formatBytes } from "@/lib/format";
import type { ProjectFont } from "@/server/project-assets";

let uploadId = 0;

const describeFont = (f: ProjectFont) =>
  [
    f.style,
    f.weight ? `weight ${f.weight}` : null,
    f.italic ? "italic" : null,
    f.variable ? "variable font" : null,
    f.glyphCount ? `${f.glyphCount} glyphs` : null,
  ]
    .filter(Boolean)
    .join(" · ");

/** Brand font files of a project: what was read from each file, upload and removal. */
export function BrandFontsPanel({
  projectId,
  fonts,
  maxUploadMb,
}: {
  projectId: string;
  fonts: ProjectFont[];
  maxUploadMb: number;
}) {
  const router = useRouter();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [problems, setProblems] = useState<string[]>([]);
  const [remove, setRemove] = useState<ProjectFont | null>(null);
  const [busy, setBusy] = useState(false);
  const maxMb = Math.min(MAX_FONT_FILE_MB, maxUploadMb);

  const patch = (id: number, p: Partial<UploadItem>) =>
    setUploads((list) => list.map((u) => (u.id === id ? { ...u, ...p } : u)));

  async function send(item: UploadItem) {
    patch(item.id, { status: "uploading", progress: 0, error: undefined });
    try {
      const font = await apiUploadWithProgress<ProjectFont>(
        `/api/v1/projects/${projectId}/fonts`,
        item.file,
        {},
        (progress) => patch(item.id, { progress }),
      );
      patch(item.id, {
        status: "done",
        progress: 1,
        note: `Font file read: “${font.family ?? "unnamed family"}”${font.style ? ` ${font.style}` : ""}.`,
      });
      router.refresh();
    } catch (err) {
      patch(item.id, {
        status: "failed",
        error: err instanceof ApiError ? err.message : "The upload failed.",
      });
    }
  }

  async function onPick() {
    const files = [...(input.current?.files ?? [])];
    if (input.current) input.current.value = "";
    const bad: string[] = [];
    const items: UploadItem[] = [];
    for (const f of files) {
      if (!fontFormatForFilename(f.name))
        bad.push(`${f.name}: only font files in WOFF2, WOFF, TTF or OTF format are supported.`);
      else if (f.size > maxMb * 1024 * 1024) bad.push(`${f.name}: larger than ${maxMb} MB.`);
      else items.push({ id: ++uploadId, kind: "font", file: f, status: "waiting", progress: 0 });
    }
    setProblems(bad);
    setUploads((list) => [...list.filter((u) => u.status !== "done"), ...items]);
    for (const item of items) await send(item);
  }

  return (
    <section
      aria-labelledby="fonts-heading"
      className="space-y-4 rounded-lg border border-border bg-surface p-5"
    >
      <div>
        <h2 id="fonts-heading" className="text-base font-semibold">
          Brand fonts
        </h2>
        <p className="mt-1 text-sm text-muted">
          The font files your brand uses. Each file&apos;s font names, weight and style are read
          from the file itself. The Design Quality &amp; Typography scanner checks whether the
          website&apos;s headings and text use these fonts and whether the browser really renders
          them. Files are stored privately for this project and never added to the website.
        </p>
      </div>
      {fonts.length === 0 ? (
        <p className="text-sm text-muted">
          No font files uploaded. Scans still check whether declared web fonts render, but not
          whether they are the brand fonts.
        </p>
      ) : (
        <ul
          aria-label="Brand font files"
          className="divide-y divide-border rounded-md border border-border"
        >
          {fonts.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{f.family ?? "Unnamed font family"}</span>
                <span className="block text-xs text-muted">
                  {describeFont(f)}
                  {f.postScriptName ? ` · PostScript name ${f.postScriptName}` : ""}
                </span>
                <span className="block break-all text-xs text-subtle">
                  {f.filename} · {f.format.toUpperCase()} · {formatBytes(f.sizeBytes)}
                  {f.embedding === "restricted"
                    ? " · licence marks it as restricted (not for embedding); it is only read here"
                    : ""}
                </span>
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Remove ${f.filename}`}
                onClick={() => setRemove(f)}
              >
                <Trash2 aria-hidden className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Field
        label="Upload font files"
        hint={`WOFF2, WOFF, TTF or OTF, up to ${maxMb} MB each. Font collections (.ttc) are not supported.`}
      >
        {({ id, describedBy }) => (
          <input
            id={id}
            ref={input}
            type="file"
            multiple
            accept={FONT_ACCEPT}
            onChange={() => void onPick()}
            aria-describedby={describedBy}
            className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-border-strong file:bg-surface file:px-3 file:py-1.5 file:text-sm file:font-medium"
          />
        )}
      </Field>
      {problems.length > 0 && (
        <Alert tone="error">
          <ul className="list-disc pl-4">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Alert>
      )}
      <UploadList
        items={uploads}
        onRetry={(id) => {
          const item = uploads.find((u) => u.id === id);
          if (item) void send(item);
        }}
      />
      <ConfirmDialog
        open={remove !== null}
        title={`Remove “${remove?.filename ?? ""}”?`}
        description="The font file is deleted from this project. Completed scans keep their results; the next scan no longer treats this font as a brand font."
        confirmLabel={busy ? "Removing…" : "Remove font"}
        pending={busy}
        onClose={() => setRemove(null)}
        onConfirm={async () => {
          if (!remove) return;
          setBusy(true);
          try {
            await apiFetch(`/api/v1/projects/${projectId}/fonts/${remove.id}`, {
              method: "DELETE",
            });
            toast.success("Font file removed.");
            setRemove(null);
            router.refresh();
          } catch (err) {
            toast.error(err instanceof ApiError ? err.message : "The font could not be removed.");
          } finally {
            setBusy(false);
          }
        }}
      />
    </section>
  );
}
