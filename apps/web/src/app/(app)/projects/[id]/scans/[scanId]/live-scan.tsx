"use client";

import { stepLabel } from "@qa/core/domain";
import { Square } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { StepStatus } from "@/components/ui/badges";
import { Button, buttonClasses } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Card } from "@/components/ui/stat";
import { StatusPill } from "@/components/ui/status-pill";
import { useToast } from "@/components/ui/toast";
import { ApiError, apiFetch } from "@/lib/api-client";
import { formatDateTime, formatDuration, scanStatusLabel, scanStatusTone } from "@/lib/format";

interface RunJson {
  id: string;
  stepKey: string;
  status: string;
  statusReason: string | null;
  error: string | null;
  findingCount: number;
  toolName: string | null;
  toolVersion: string | null;
  durationMs: number | null;
  startedAt: string | null;
  checks?: Record<string, unknown> | null;
}

interface Technology {
  name: string;
  category: string;
  confidence: string;
  signals: string[];
}

export interface ScanJson {
  id: string;
  number: number;
  status: string;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  cancelRequestedAt: string | null;
  technology: { detected?: Technology[]; note?: string | null } | null;
  configSnapshot: { websiteUrl?: string; maxPages?: number; viewports?: Array<{ name: string }> };
  runs: RunJson[];
  pageCount: number;
  captureCount: number;
}

interface Capture {
  pageId: string;
  url: string;
  viewport: string;
  screenshotKey: string | null;
  error: string | null;
}

const TERMINAL = new Set(["completed", "completed_with_failures", "failed", "cancelled"]);
const POLL_MS = 3_000;

export function LiveScan({
  projectId,
  initial,
  initialCaptures,
}: {
  projectId: string;
  initial: ScanJson;
  initialCaptures: Capture[];
}) {
  const toast = useToast();
  const [scan, setScan] = useState(initial);
  const [captures, setCaptures] = useState(initialCaptures);
  const [transport, setTransport] = useState<"live" | "polling" | "done">(
    TERMINAL.has(initial.status) ? "done" : "live",
  );
  const [announcement, setAnnouncement] = useState("");
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);
  const previous = useRef(initial);

  // Announce step transitions for screen-reader users (only changes, not every update).
  useEffect(() => {
    const before = new Map(previous.current.runs.map((r) => [r.stepKey, r.status]));
    const changed = scan.runs.filter(
      (r) => before.get(r.stepKey) !== r.status && r.status !== "pending",
    );
    if (changed.length)
      setAnnouncement(changed.map((r) => `${stepLabel(r.stepKey)}: ${r.status}`).join(". "));
    if (previous.current.status !== scan.status && TERMINAL.has(scan.status))
      setAnnouncement(`Scan ${scanStatusLabel(scan.status).toLowerCase()}`);
    previous.current = scan;
  }, [scan]);

  useEffect(() => {
    if (TERMINAL.has(initial.status)) return;
    let stopped = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (stopped) return;
      try {
        const next = await apiFetch<ScanJson>(`/api/v1/scans/${initial.id}`);
        setScan(next);
        if (TERMINAL.has(next.status)) return finish();
      } catch {
        // keep polling; the page shows the last known state
      }
      pollTimer = setTimeout(poll, POLL_MS);
    };
    const source = new EventSource(`/api/v1/scans/${initial.id}/events`);
    source.addEventListener("scan", (e) => {
      const next = JSON.parse((e as MessageEvent).data) as ScanJson;
      setScan(next);
      if (TERMINAL.has(next.status)) finish();
    });
    source.onerror = () => {
      // The server closes the stream at the end; otherwise fall back to polling.
      source.close();
      if (!stopped) {
        setTransport("polling");
        void poll();
      }
    };
    function finish() {
      stopped = true;
      source.close();
      if (pollTimer) clearTimeout(pollTimer);
      setTransport("done");
      apiFetch<{ items: Capture[] }>(`/api/v1/scans/${initial.id}/captures`)
        .then((r) => setCaptures(r.items))
        .catch(() => {});
    }
    return () => {
      stopped = true;
      source.close();
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [initial.id, initial.status]);

  async function cancel() {
    setCancelPending(true);
    try {
      await apiFetch(`/api/v1/scans/${scan.id}/cancel`, { method: "POST" });
      toast.info("Cancellation requested. The scan stops after the current page.");
      setCancelOpen(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "The scan could not be cancelled.");
    } finally {
      setCancelPending(false);
    }
  }

  const running = !TERMINAL.has(scan.status);
  const totalFindings = scan.runs.reduce((sum, r) => sum + (r.findingCount ?? 0), 0);
  const groundingRun = scan.runs.find((r) => r.stepKey === "grounding");
  const issueCount =
    groundingRun?.status === "completed" ? Number(groundingRun.checks?.issues ?? 0) : 0;
  const issuesHref = `/projects/${projectId}/scans/${scan.id}/issues`;
  const elapsed = scan.startedAt
    ? (scan.finishedAt ? new Date(scan.finishedAt) : new Date()).getTime() -
      new Date(scan.startedAt).getTime()
    : null;
  const tech = scan.technology?.detected?.filter((t) => t.category !== "server") ?? [];
  const server = scan.technology?.detected?.find((t) => t.category === "server");

  // Group captures by page for the gallery.
  const byPage = new Map<string, { url: string; shots: Capture[] }>();
  for (const c of captures) {
    const entry = byPage.get(c.pageId) ?? { url: c.url, shots: [] };
    entry.shots.push(c);
    byPage.set(c.pageId, entry);
  }

  return (
    <div className="space-y-6">
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold">
            Scan #{scan.number}
            <StatusPill tone={scanStatusTone(scan.status)}>
              {scanStatusLabel(scan.status)}
            </StatusPill>
            {scan.cancelRequestedAt && running && (
              <StatusPill tone="warning">Cancelling…</StatusPill>
            )}
          </h2>
          <p className="mt-1 text-sm text-muted">
            Created {formatDateTime(scan.createdAt)}
            {elapsed !== null &&
              ` · ${running ? "running for" : "took"} ${formatDuration(elapsed)}`}{" "}
            · {scan.pageCount} page{scan.pageCount === 1 ? "" : "s"} crawled · {scan.captureCount}{" "}
            capture{scan.captureCount === 1 ? "" : "s"}
          </p>
          <p className="mt-1 text-xs text-subtle">
            {transport === "live" && "Live updates from the worker."}
            {transport === "polling" && "Live connection unavailable; refreshing every 3 seconds."}
            {transport === "done" && "Final results."}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {issueCount > 0 && (
            <Link href={issuesHref} className={buttonClasses("primary")}>
              View {issueCount} issue{issueCount === 1 ? "" : "s"}
            </Link>
          )}
          {totalFindings > 0 && (
            <Link
              href={`/projects/${projectId}/scans/${scan.id}/findings`}
              className={buttonClasses(running || issueCount > 0 ? "secondary" : "primary")}
            >
              View {totalFindings} finding{totalFindings === 1 ? "" : "s"}
            </Link>
          )}
          {!running && (
            <Link
              href={`/projects/${projectId}/reports?scan=${scan.id}`}
              className={buttonClasses("secondary")}
            >
              Generate report
            </Link>
          )}
          {running && !scan.cancelRequestedAt && (
            <Button variant="secondary" onClick={() => setCancelOpen(true)}>
              <Square aria-hidden className="size-4" />
              Cancel scan
            </Button>
          )}
        </div>
      </div>

      {scan.error && (
        <div
          role="alert"
          className="rounded-lg border border-danger/40 bg-danger-bg px-4 py-3 text-sm"
        >
          <span className="font-semibold text-danger">Scan failed:</span> {scan.error}
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-[1fr_20rem]">
        <Card title="Progress" className="min-w-0">
          <ol className="divide-y divide-border">
            {scan.runs.map((r) => (
              <li
                key={r.id}
                className="grid gap-1 py-2.5 sm:grid-cols-[12rem_9rem_1fr] sm:items-start"
              >
                <span className="text-sm font-medium">{stepLabel(r.stepKey)}</span>
                <StepStatus status={r.status} />
                <span className="min-w-0 break-words text-sm text-muted">
                  {r.error ? <span className="text-danger">{r.error}</span> : r.statusReason}
                  {r.durationMs !== null && r.status !== "skipped" && (
                    <span className="text-subtle"> · {formatDuration(r.durationMs)}</span>
                  )}
                  {r.findingCount > 0 && (
                    <Link
                      href={`/projects/${projectId}/scans/${scan.id}/findings?scanner=${r.stepKey}`}
                      className="block text-xs font-medium text-primary hover:underline"
                    >
                      {r.findingCount} finding{r.findingCount === 1 ? "" : "s"}
                    </Link>
                  )}
                  {(r.stepKey === "design" || r.stepKey === "content") &&
                    r.status === "completed" && (
                      <Link
                        href={`/projects/${projectId}/scans/${scan.id}/comparisons`}
                        className="block text-xs font-medium text-primary hover:underline"
                      >
                        View comparison (matches and mismatches)
                      </Link>
                    )}
                  {((r.stepKey === "grounding" && r.status === "completed" && issueCount > 0) ||
                    (r.stepKey === "ai" &&
                      (r.status === "completed" || r.status === "failed"))) && (
                    <Link
                      href={issuesHref}
                      className="block text-xs font-medium text-primary hover:underline"
                    >
                      {r.stepKey === "ai"
                        ? "View AI requests and evidence checks"
                        : `View ${issueCount} issue${issueCount === 1 ? "" : "s"}`}
                    </Link>
                  )}
                  {r.toolName && (
                    <span className="block text-xs text-subtle">
                      {r.toolName}
                      {r.toolVersion ? ` · ${r.toolVersion}` : ""}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ol>
        </Card>

        <Card title="Website" className="min-w-0">
          <dl className="space-y-3 text-sm">
            <div>
              <dt className="text-muted">Target</dt>
              <dd className="break-all">{scan.configSnapshot.websiteUrl}</dd>
            </div>
            <div>
              <dt className="text-muted">Detected technology</dt>
              <dd>
                {scan.technology === null ? (
                  "Not determined yet"
                ) : tech.length ? (
                  <ul className="space-y-1">
                    {tech.map((t) => (
                      <li key={t.name}>
                        {t.name} <span className="text-subtle">({t.confidence} confidence)</span>
                        <span className="block text-xs text-subtle">{t.signals.join("; ")}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  "Could not determine"
                )}
              </dd>
            </div>
            {server && (
              <div>
                <dt className="text-muted">Server header</dt>
                <dd>{server.signals[0]?.replace(/^server:\s*/, "")}</dd>
              </div>
            )}
          </dl>
          <p className="mt-3 text-xs text-subtle">
            Technology detection is heuristic and based on the signals listed.
          </p>
        </Card>
      </div>

      {byPage.size > 0 && (
        <Card
          title="Captured pages"
          action={
            <Link
              href={`/projects/${projectId}/pages`}
              className="text-sm text-primary hover:underline"
            >
              Page details
            </Link>
          }
        >
          <ul className="space-y-6">
            {[...byPage.entries()].slice(0, 30).map(([pageId, p]) => (
              <li key={pageId}>
                <p className="mb-2 truncate text-sm font-medium" title={p.url}>
                  {p.url}
                </p>
                <div
                  className="flex gap-3 overflow-x-auto pb-1"
                  role="region"
                  aria-label={`Screenshots of ${p.url}`}
                  tabIndex={0}
                >
                  {p.shots.map((c) => (
                    <figure key={c.viewport} className="w-40 shrink-0">
                      {c.screenshotKey ? (
                        <a
                          href={`/api/v1/artifacts/${c.screenshotKey}`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element -- authenticated artifact stream */}
                          <img
                            src={`/api/v1/artifacts/${c.screenshotKey}`}
                            alt={`${c.viewport} screenshot of ${p.url}`}
                            loading="lazy"
                            className="h-28 w-40 rounded border border-border object-cover object-top"
                          />
                        </a>
                      ) : (
                        <div className="flex h-28 w-40 items-center justify-center rounded border border-dashed border-border-strong p-2 text-center text-xs text-danger">
                          {c.error ?? "No screenshot"}
                        </div>
                      )}
                      <figcaption className="mt-1 text-xs capitalize text-muted">
                        {c.viewport}
                      </figcaption>
                    </figure>
                  ))}
                </div>
              </li>
            ))}
          </ul>
          {byPage.size > 30 && (
            <p className="mt-4 text-xs text-muted">Showing the first 30 of {byPage.size} pages.</p>
          )}
        </Card>
      )}

      <ConfirmDialog
        open={cancelOpen}
        title={`Cancel scan #${scan.number}?`}
        description="The scan stops after the page currently being processed. Results collected so far are kept."
        confirmLabel={cancelPending ? "Cancelling…" : "Cancel scan"}
        pending={cancelPending}
        onConfirm={cancel}
        onClose={() => setCancelOpen(false)}
      />
    </div>
  );
}
