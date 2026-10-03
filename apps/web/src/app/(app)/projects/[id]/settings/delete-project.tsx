"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { ApiError, apiFetch } from "@/lib/api-client";

export function DeleteProject({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onDelete() {
    setPending(true);
    setError(null);
    try {
      await apiFetch(`/api/v1/projects/${projectId}`, { method: "DELETE" });
      toast.success(`Project “${projectName}” deleted.`);
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
      <Button variant="danger" className="mt-4" onClick={() => setOpen(true)}>
        Delete project…
      </Button>
      <ConfirmDialog
        open={open}
        title={`Delete “${projectName}”?`}
        description="The project, its references and its scan history will no longer be accessible."
        confirmLabel={pending ? "Deleting…" : "Delete project"}
        confirmText={projectName}
        pending={pending}
        error={error}
        onConfirm={onDelete}
        onClose={() => {
          setOpen(false);
          setError(null);
        }}
      />
    </section>
  );
}
