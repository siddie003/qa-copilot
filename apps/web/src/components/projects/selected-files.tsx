"use client";

import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/format";

/** Files chosen in a form but not uploaded yet: name, size and a remove button each. */
export function SelectedFiles({
  label,
  files,
  onRemove,
  children,
}: {
  label: string;
  files: Array<{ id: number; file: File }>;
  onRemove(id: number): void;
  /** Optional extra control per file (e.g. a page mapping input). */
  children?: (id: number) => React.ReactNode;
}) {
  if (!files.length) return null;
  return (
    <ul aria-label={label} className="divide-y divide-border rounded-md border border-border">
      {files.map((f) => (
        <li key={f.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
          <span className="min-w-0 flex-1 break-all">
            {f.file.name} <span className="text-xs text-subtle">({formatBytes(f.file.size)})</span>
          </span>
          {children?.(f.id)}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`Remove ${f.file.name}`}
            onClick={() => onRemove(f.id)}
          >
            <Trash2 aria-hidden className="size-4" />
          </Button>
        </li>
      ))}
    </ul>
  );
}

/** Upload states shown after the project is created (real progress from the browser). */
export interface UploadItem {
  id: number;
  kind: "guideline" | "font" | "content";
  file: File;
  targetPath?: string;
  status: "waiting" | "uploading" | "done" | "failed";
  progress: number;
  error?: string;
  /** What the server reported after a successful upload (e.g. the font family it read). */
  note?: string;
}

const KIND_LABEL: Record<UploadItem["kind"], string> = {
  guideline: "Brand guideline",
  font: "Font file",
  content: "Content document",
};

export function UploadList({ items, onRetry }: { items: UploadItem[]; onRetry(id: number): void }) {
  if (!items.length) return null;
  return (
    <ul aria-label="File uploads" className="space-y-2">
      {items.map((u) => (
        <li key={u.id} className="rounded-md border border-border px-3 py-2 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="min-w-0 break-all">
              <span className="text-xs text-muted">{KIND_LABEL[u.kind]} · </span>
              {u.file.name}
              {u.targetPath ? <span className="font-mono text-xs"> → {u.targetPath}</span> : null}
            </span>
            <span
              className={
                u.status === "failed"
                  ? "text-xs font-medium text-danger"
                  : u.status === "done"
                    ? "text-xs font-medium text-success"
                    : "text-xs text-muted"
              }
            >
              {u.status === "waiting"
                ? "Waiting"
                : u.status === "uploading"
                  ? `Uploading ${Math.round(u.progress * 100)}%`
                  : u.status === "done"
                    ? "Uploaded"
                    : "Failed"}
            </span>
          </div>
          {u.status === "uploading" && (
            <div
              role="progressbar"
              aria-label={`Upload progress of ${u.file.name}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(u.progress * 100)}
              className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-muted"
            >
              <div
                className="h-full bg-primary"
                style={{ width: `${Math.round(u.progress * 100)}%` }}
              />
            </div>
          )}
          {u.note && u.status === "done" && <p className="mt-1 text-xs text-muted">{u.note}</p>}
          {u.status === "failed" && (
            <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-danger">{u.error}</p>
              <Button type="button" variant="secondary" size="sm" onClick={() => onRetry(u.id)}>
                Retry
              </Button>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
