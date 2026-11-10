"use client";

import { FINDING_SOURCE_LABELS, USER_ISSUE_STATUSES, type UserIssueStatus } from "@qa/core/domain";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { VERDICT_NOTES } from "@/components/issues/grounding";
import { ISSUE_STATUS_LABELS, IssueStatusBadge, SeverityBadge } from "@/components/ui/badges";
import { Button } from "@/components/ui/button";
import { inputClasses } from "@/components/ui/field-styles";
import { StatusPill } from "@/components/ui/status-pill";
import { useToast } from "@/components/ui/toast";
import { ApiError, apiFetch } from "@/lib/api-client";
import { formatDate } from "@/lib/format";

export interface IssueRow {
  id: string;
  displayNo: number;
  projectId: string;
  projectName: string;
  title: string;
  severity: string;
  status: string;
  category: string;
  lastSeenScanNumber: number | null;
  lastSeenAt: Date | string | null;
  verdict: string | null;
  confidence: number | null;
  pageCount: number | null;
  occurrences: number;
}

export const issueHref = (i: { projectId: string; displayNo: number }) =>
  `/projects/${i.projectId}/issues/${i.displayNo}`;

/** Issue table with row selection and a bulk status action (POST /api/v1/issues/status). */
export function IssueTable({
  items,
  total,
  showProject,
}: {
  items: IssueRow[];
  total: number;
  showProject: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<UserIssueStatus>("in_progress");
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const allSelected = items.length > 0 && items.every((i) => selected.has(i.id));

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function apply() {
    setPending(true);
    try {
      const res = await apiFetch<{ changed: string[]; unchanged: string[] }>(
        "/api/v1/issues/status",
        { method: "POST", body: { ids: [...selected], status, note: note || undefined } },
      );
      const label = ISSUE_STATUS_LABELS[status];
      toast.success(
        res.changed.length
          ? `${res.changed.length} issue(s) set to ${label}${res.unchanged.length ? ` (${res.unchanged.length} already were)` : ""}.`
          : `All selected issues already were ${label}.`,
      );
      setSelected(new Set());
      setNote("");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "The status could not be changed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-2">
      {selected.size > 0 && (
        <div
          role="region"
          aria-label="Bulk status change"
          className="flex flex-wrap items-end gap-3 rounded-lg border border-primary/40 bg-surface p-3"
        >
          <p className="w-full text-sm font-medium sm:w-auto sm:self-center">
            {selected.size} selected
          </p>
          <div>
            <label htmlFor="bulk-status" className="mb-1 block text-xs font-medium text-muted">
              New status
            </label>
            <select
              id="bulk-status"
              value={status}
              onChange={(e) => setStatus(e.target.value as UserIssueStatus)}
              className={inputClasses}
            >
              {USER_ISSUE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {ISSUE_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
          <div className="min-w-0 flex-1 basis-48">
            <label htmlFor="bulk-note" className="mb-1 block text-xs font-medium text-muted">
              Note (optional, saved in each issue&apos;s history)
            </label>
            <input
              id="bulk-note"
              value={note}
              maxLength={2000}
              onChange={(e) => setNote(e.target.value)}
              className={inputClasses}
            />
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={apply} disabled={pending}>
              {pending ? "Saving…" : `Set status of ${selected.size}`}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setSelected(new Set())}
              disabled={pending}
            >
              Clear selection
            </Button>
          </div>
        </div>
      )}
      {/* Phones: one card per issue (the table needs ~960px). Same selection state. */}
      <ul
        aria-label={`Issues, ${total} matching`}
        className="divide-y divide-border rounded-lg border border-border bg-surface md:hidden"
      >
        {items.map((i) => {
          const note = i.verdict ? VERDICT_NOTES[i.verdict] : undefined;
          return (
            <li key={i.id} className={selected.has(i.id) ? "bg-primary/5 p-3" : "p-3"}>
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  aria-label={`Select ISSUE-${i.displayNo}`}
                  checked={selected.has(i.id)}
                  onChange={() => toggle(i.id)}
                  className="mt-1 size-5 shrink-0 accent-[var(--primary)]"
                />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="font-mono text-xs text-muted">ISSUE-{i.displayNo}</div>
                  <Link
                    href={issueHref(i)}
                    className="block font-medium break-words hover:underline"
                  >
                    {i.title}
                  </Link>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <SeverityBadge severity={i.severity} />
                    <IssueStatusBadge status={i.status} />
                    {note && <StatusPill tone={note.tone}>{note.label}</StatusPill>}
                  </div>
                  <p className="text-xs text-muted">
                    {FINDING_SOURCE_LABELS[i.category] ?? i.category}
                    {showProject && ` · ${i.projectName}`}
                    {i.pageCount !== null &&
                      ` · ${i.pageCount === 0 ? "site-wide" : `${i.pageCount} page${i.pageCount === 1 ? "" : "s"}`}`}
                    {i.lastSeenScanNumber !== null &&
                      ` · last seen in scan #${i.lastSeenScanNumber}`}
                  </p>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      <div
        role="region"
        aria-label="Issues table"
        tabIndex={0}
        className="relative hidden overflow-x-auto rounded-lg border border-border bg-surface md:block"
      >
        <table className="w-full min-w-[960px] text-left text-sm">
          <caption className="sr-only">Issues, {total} matching</caption>
          <thead className="border-b border-border bg-surface-muted text-xs uppercase tracking-wide text-muted">
            <tr>
              <th scope="col" className="w-10 px-4 py-3">
                <input
                  type="checkbox"
                  aria-label="Select all issues on this page"
                  checked={allSelected}
                  onChange={() =>
                    setSelected(allSelected ? new Set() : new Set(items.map((i) => i.id)))
                  }
                  className="size-4 accent-[var(--primary)]"
                />
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Issue
              </th>
              {showProject && (
                <th scope="col" className="px-4 py-3 font-medium">
                  Project
                </th>
              )}
              <th scope="col" className="px-4 py-3 font-medium">
                Severity
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Category
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Status
              </th>
              <th scope="col" className="px-4 py-3 text-right font-medium">
                Pages
              </th>
              <th scope="col" className="px-4 py-3 text-right font-medium">
                Confidence
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Last detected
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {items.map((i) => {
              const note = i.verdict ? VERDICT_NOTES[i.verdict] : undefined;
              return (
                <tr key={i.id} className={selected.has(i.id) ? "bg-primary/5" : undefined}>
                  <td className="px-4 py-3 align-top">
                    <input
                      type="checkbox"
                      aria-label={`Select ISSUE-${i.displayNo}`}
                      checked={selected.has(i.id)}
                      onChange={() => toggle(i.id)}
                      className="size-4 accent-[var(--primary)]"
                    />
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-mono text-xs text-muted">ISSUE-{i.displayNo}</div>
                    <Link href={issueHref(i)} className="font-medium hover:underline">
                      {i.title}
                    </Link>
                    {note && (
                      <div className="mt-1">
                        <StatusPill tone={note.tone}>{note.label}</StatusPill>
                      </div>
                    )}
                  </td>
                  {showProject && (
                    <td className="px-4 py-3">
                      <Link href={`/projects/${i.projectId}/issues`} className="hover:underline">
                        {i.projectName}
                      </Link>
                    </td>
                  )}
                  <td className="px-4 py-3">
                    <SeverityBadge severity={i.severity} />
                  </td>
                  <td className="px-4 py-3 text-muted">
                    {FINDING_SOURCE_LABELS[i.category] ?? i.category}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    <IssueStatusBadge status={i.status} />
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {i.pageCount === null ? "—" : i.pageCount === 0 ? "Site-wide" : i.pageCount}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {i.confidence === null ? "—" : `${Math.round(i.confidence * 100)}%`}
                  </td>
                  <td className="px-4 py-3 text-muted">
                    {i.lastSeenScanNumber !== null ? (
                      <>
                        Scan #{i.lastSeenScanNumber}
                        {i.lastSeenAt && (
                          <span className="block text-xs">{formatDate(i.lastSeenAt)}</span>
                        )}
                      </>
                    ) : (
                      "—"
                    )}
                    {i.occurrences > 1 && (
                      <span className="block text-xs">in {i.occurrences} scans</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
