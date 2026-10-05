"use client";

import { USER_ISSUE_STATUSES, type UserIssueStatus } from "@qa/core/domain";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ISSUE_STATUS_LABELS } from "@/components/ui/badges";
import { Button } from "@/components/ui/button";
import { inputClasses } from "@/components/ui/field-styles";
import { useToast } from "@/components/ui/toast";
import { ApiError, apiFetch } from "@/lib/api-client";

const HELP: Record<string, string> = {
  open: "Confirmed problem that nobody is working on yet.",
  in_progress: "Someone is fixing it.",
  resolved: "Fixed. A later scan shows whether the problem is really gone.",
  ignored: "Accepted or not applicable; kept for the record.",
};

/** Changes an issue's status (PATCH /api/v1/issues/:id/status); every change is audited. */
export function StatusControl({
  issueId,
  displayNo,
  status,
}: {
  issueId: string;
  displayNo: number;
  status: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const initial = (USER_ISSUE_STATUSES as readonly string[]).includes(status)
    ? (status as UserIssueStatus)
    : "open";
  const [next, setNext] = useState<UserIssueStatus>(initial);
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unchanged = next === status;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      await apiFetch(`/api/v1/issues/${issueId}/status`, {
        method: "PATCH",
        body: { status: next, note: note || undefined },
      });
      toast.success(`ISSUE-${displayNo} set to ${ISSUE_STATUS_LABELS[next]}.`);
      setNote("");
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "The status could not be changed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-3" aria-label={`Change status of ISSUE-${displayNo}`}>
      <div>
        <label htmlFor="issue-status" className="mb-1 block text-xs font-medium text-muted">
          Status
        </label>
        <select
          id="issue-status"
          value={next}
          onChange={(e) => setNext(e.target.value as UserIssueStatus)}
          aria-describedby="issue-status-help"
          className={inputClasses}
        >
          {USER_ISSUE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {ISSUE_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        <p id="issue-status-help" className="mt-1 text-xs text-muted">
          {HELP[next]}
        </p>
      </div>
      <div>
        <label htmlFor="issue-note" className="mb-1 block text-xs font-medium text-muted">
          Note (optional)
        </label>
        <textarea
          id="issue-note"
          value={note}
          maxLength={2000}
          rows={3}
          onChange={(e) => setNote(e.target.value)}
          className={inputClasses}
          placeholder="e.g. fixed in release 2.4"
        />
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <Button type="submit" size="sm" disabled={pending || unchanged}>
        {pending ? "Saving…" : unchanged ? "Current status" : "Save status"}
      </Button>
    </form>
  );
}
