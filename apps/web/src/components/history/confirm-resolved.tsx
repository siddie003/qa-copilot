"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { ApiError, apiFetch } from "@/lib/api-client";

/**
 * Sets the issues a comparison found resolved to "Resolved" in one audited bulk change
 * (POST /api/v1/issues/status). Scans never change user workflow statuses on their own; this is
 * the user confirming the fix, with the comparison named in the note.
 */
export function ConfirmResolved({
  trackIds,
  baseNumber,
  targetNumber,
}: {
  trackIds: string[];
  baseNumber: number;
  targetNumber: number;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!trackIds.length) return null;

  async function confirm() {
    setPending(true);
    setError(null);
    try {
      await apiFetch("/api/v1/issues/status", {
        method: "POST",
        body: {
          ids: trackIds,
          status: "resolved",
          note: `Not found by scan #${targetNumber}, which re-checked it (compared with scan #${baseNumber}).`,
        },
      });
      toast.success(`${trackIds.length} issue(s) set to Resolved.`);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "The statuses could not be changed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="secondary" size="sm" onClick={confirm} disabled={pending}>
        {pending ? "Saving…" : `Set ${trackIds.length} still-open issue(s) to Resolved`}
      </Button>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
