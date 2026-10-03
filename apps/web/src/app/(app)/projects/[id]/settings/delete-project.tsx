"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { inputClasses } from "@/components/ui/field";
import { ApiError, apiFetch } from "@/lib/api-client";

export function DeleteProject({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [confirmText, setConfirmText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function close() {
    dialogRef.current?.close();
    setConfirmText("");
    setError(null);
  }

  async function onDelete() {
    setPending(true);
    setError(null);
    try {
      await apiFetch(`/api/v1/projects/${projectId}`, { method: "DELETE" });
      router.push("/projects");
      router.refresh();
    } catch (err) {
      setPending(false);
      setError(err instanceof ApiError ? err.message : "Project could not be deleted.");
    }
  }

  return (
    <section
      aria-labelledby="danger-heading"
      className="rounded-lg border border-danger/40 bg-surface p-5"
    >
      <h2 id="danger-heading" className="text-base font-semibold text-danger">
        Delete project
      </h2>
      <p className="mt-1 text-sm text-muted">
        Removes the project and its scan history from all views. This cannot be undone from the
        application.
      </p>
      <Button variant="danger" className="mt-4" onClick={() => dialogRef.current?.showModal()}>
        Delete project…
      </Button>

      <dialog
        ref={dialogRef}
        aria-labelledby="delete-dialog-title"
        onClose={() => setConfirmText("")}
        className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-lg border border-border bg-surface p-6 text-foreground shadow-xl backdrop:bg-black/50"
      >
        <h3 id="delete-dialog-title" className="text-lg font-semibold">
          Delete “{projectName}”?
        </h3>
        <p className="mt-2 text-sm text-muted">Type the project name to confirm.</p>
        <label htmlFor="delete-confirm" className="sr-only">
          Project name
        </label>
        <input
          id="delete-confirm"
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          autoComplete="off"
          className={`${inputClasses} mt-3`}
        />
        {error && (
          <Alert tone="error" className="mt-3">
            {error}
          </Alert>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={close} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={onDelete}
            disabled={pending || confirmText !== projectName}
          >
            {pending ? "Deleting…" : "Delete project"}
          </Button>
        </div>
      </dialog>
    </section>
  );
}
