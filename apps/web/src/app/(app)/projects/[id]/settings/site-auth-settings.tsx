"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  EMPTY_AUTH,
  SiteAuthFields,
  toPayload,
  type SiteAuthDraft,
} from "@/components/projects/site-auth-fields";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { ApiError, apiFetch } from "@/lib/api-client";

export interface AuthSummary {
  type: "basic" | "header" | "cookies";
  username?: string;
  headerName?: string;
  cookieNames?: string[];
}

function describe(s: AuthSummary) {
  if (s.type === "basic") return `HTTP Basic authentication as “${s.username}”`;
  if (s.type === "header") return `Custom header “${s.headerName}”`;
  return `Session cookies: ${s.cookieNames?.join(", ")}`;
}

export function SiteAuthSettings({
  projectId,
  summary,
}: {
  projectId: string;
  summary: AuthSummary | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const [draft, setDraft] = useState<SiteAuthDraft>(EMPTY_AUTH);
  const [editing, setEditing] = useState(!summary);
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  async function save() {
    const payload = toPayload(draft);
    if (!payload) return;
    setPending(true);
    setErrors({});
    setFormError(null);
    try {
      await apiFetch(`/api/v1/projects/${projectId}/scan-auth`, { method: "PUT", body: payload });
      toast.success("Site credentials saved (encrypted).");
      setDraft(EMPTY_AUTH);
      setEditing(false);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(err.fieldErrors);
        setFormError(err.message);
      } else setFormError("Credentials could not be saved.");
    } finally {
      setPending(false);
    }
  }

  async function remove() {
    setPending(true);
    try {
      await apiFetch(`/api/v1/projects/${projectId}/scan-auth`, { method: "DELETE" });
      toast.success("Site credentials removed.");
      setConfirmRemove(false);
      setEditing(true);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Credentials could not be removed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section
      aria-labelledby="site-auth-heading"
      className="space-y-4 rounded-lg border border-border bg-surface p-5"
    >
      <div>
        <h2 id="site-auth-heading" className="text-base font-semibold">
          Site authentication
        </h2>
        <p className="mt-1 text-sm text-muted">
          Optional credentials for scanning pages behind a login.
        </p>
      </div>
      {summary && !editing ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border px-4 py-3">
          <p className="text-sm">
            <span className="font-medium">Configured:</span> {describe(summary)}
          </p>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
              Replace
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirmRemove(true)}>
              Remove
            </Button>
          </div>
        </div>
      ) : (
        <>
          <SiteAuthFields value={draft} onChange={setDraft} errors={errors} />
          {formError && <Alert tone="error">{formError}</Alert>}
          <div className="flex gap-2">
            <Button onClick={save} disabled={pending || draft.type === "none"}>
              {pending ? "Saving…" : "Save credentials"}
            </Button>
            {summary && (
              <Button variant="secondary" onClick={() => setEditing(false)} disabled={pending}>
                Cancel
              </Button>
            )}
          </div>
        </>
      )}
      <ConfirmDialog
        open={confirmRemove}
        title="Remove site credentials?"
        description="Future scans will only reach public pages."
        confirmLabel={pending ? "Removing…" : "Remove credentials"}
        pending={pending}
        onConfirm={remove}
        onClose={() => setConfirmRemove(false)}
      />
    </section>
  );
}
