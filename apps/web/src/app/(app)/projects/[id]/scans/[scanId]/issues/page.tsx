import { AppError, FINDING_SOURCE_LABELS, stepLabel } from "@qa/core";
import { getDb, scanIssuesRepo } from "@qa/db";
import { ListChecks } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  GROUNDING_LABELS,
  GroundingBadge,
  GroundingChecks,
  VerdictNote,
} from "@/components/issues/grounding";
import { IssueStatusBadge, SeverityBadge, StepStatus } from "@/components/ui/badges";
import { EmptyState } from "@/components/ui/empty-state";
import { Card } from "@/components/ui/stat";
import { cn } from "@/lib/cn";
import { formatDuration } from "@/lib/format";
import { loadProjectForPage } from "@/server/loaders";
import { getScan } from "@/server/scans";

export const metadata: Metadata = { title: "Scan issues" };

const FILTERS = ["passed", "partial", "rejected", "not_applicable"] as const;
const MAX_PAGES_SHOWN = 10;

export default async function ScanIssuesPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; scanId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id, scanId } = await params;
  const q = await searchParams;
  const { user, project } = await loadProjectForPage(id);
  let scan;
  try {
    scan = await getScan(user.id, scanId);
  } catch (err) {
    if (err instanceof AppError && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  if (scan.projectId !== project.id) notFound();
  const result = await scanIssuesRepo.listScanIssues(getDb(), user.id, scanId);
  if (!result) notFound();

  const filter =
    typeof q.grounding === "string" && (FILTERS as readonly string[]).includes(q.grounding)
      ? q.grounding
      : "";
  const items = result.issues.filter((i) => !filter || i.groundingStatus === filter);
  const count = (s: string) => result.issues.filter((i) => i.groundingStatus === s).length;
  const steps = scan.runs.filter((r) => r.stepKey === "ai" || r.stepKey === "grounding");
  const runsById = new Map(result.aiRuns.map((r) => [r.id, r]));
  const base = `/projects/${project.id}/scans/${scanId}`;
  const hasComparison = scan.runs.some(
    (r) => (r.stepKey === "design" || r.stepKey === "content") && r.status === "completed",
  );
  const groundingRun = scan.runs.find((r) => r.stepKey === "grounding");
  const emptyText = !groundingRun
    ? "This scan ran before issues were created automatically. Start a new scan to group its findings into issues."
    : ["pending", "running"].includes(groundingRun.status)
      ? "Issues are created when the scan's findings have been validated. This page updates when you reload it."
      : groundingRun.status === "completed"
        ? "The scanners reported no findings, so there are no issues."
        : (groundingRun.error ?? groundingRun.statusReason ?? "Issues could not be created.");

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">
          Issues · Scan #{scan.number}{" "}
          <span className="text-sm font-normal text-muted">({result.issues.length} in total)</span>
        </h2>
        <div className="flex flex-wrap gap-3 text-sm">
          <Link href={base} className="text-primary hover:underline">
            Scan progress
          </Link>
          <Link href={`${base}/findings`} className="text-primary hover:underline">
            Findings
          </Link>
          {hasComparison && (
            <Link href={`${base}/comparisons`} className="text-primary hover:underline">
              Reference comparison
            </Link>
          )}
        </div>
      </div>
      <p className="text-sm text-muted">
        Each issue groups the findings of one scanner rule (design and content comparisons: one
        reference value each). Text marked as AI was written by the configured AI provider and
        checked against this scan&apos;s evidence; anything the evidence does not support is
        replaced with the scanner&apos;s own wording. Findings and evidence are never changed.
      </p>

      <Card title="AI analysis and evidence validation">
        {steps.length === 0 ? (
          <p className="text-sm text-muted">Not part of this scan.</p>
        ) : (
          <dl className="space-y-3">
            {steps.map((r) => (
              <div key={r.id} className="grid gap-1 sm:grid-cols-[12rem_9rem_1fr] sm:items-start">
                <dt className="text-sm font-medium">{stepLabel(r.stepKey)}</dt>
                <dd>
                  <StepStatus status={r.status} />
                </dd>
                <dd className="min-w-0 break-words text-sm text-muted">
                  {r.error ? <span className="text-danger">{r.error}</span> : r.statusReason}
                  {r.toolName && r.status !== "skipped" && (
                    <span className="block text-xs text-subtle">
                      {r.toolName}
                      {r.toolVersion ? ` · ${r.toolVersion}` : ""}
                    </span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        )}
        {result.issues.length > 0 && (
          <nav aria-label="Filter by text origin" className="mt-4 flex flex-wrap gap-2 text-sm">
            {[
              ["", `All (${result.issues.length})`] as const,
              ...FILTERS.map((f) => [f, `${GROUNDING_LABELS[f]!.label} (${count(f)})`] as const),
            ].map(([key, label]) => (
              <Link
                key={key}
                href={key ? `${base}/issues?grounding=${key}` : `${base}/issues`}
                aria-current={filter === key ? "page" : undefined}
                className={cn(
                  "rounded-full border px-3 py-1",
                  filter === key
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border hover:bg-surface-muted",
                )}
              >
                {label}
              </Link>
            ))}
          </nav>
        )}
      </Card>

      {result.aiRuns.length > 0 && (
        <Card title="AI requests">
          <div
            role="region"
            aria-label="AI requests table"
            tabIndex={0}
            className="relative overflow-x-auto"
          >
            <table className="w-full min-w-[720px] text-left text-sm">
              <caption className="sr-only">AI requests of scan #{scan.number}</caption>
              <thead className="border-b border-border text-xs uppercase tracking-wide text-muted">
                <tr>
                  {["Category", "Issues", "Result", "Model", "Tokens (in / out)", "Time"].map(
                    (h) => (
                      <th key={h} scope="col" className="py-2 pr-3 font-medium">
                        {h}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {result.aiRuns.map((r) => {
                  const d = (r.detail ?? {}) as {
                    category?: string;
                    groupIds?: string[];
                    fallbackUsed?: boolean;
                  };
                  return (
                    <tr key={r.id} className="align-top">
                      <td className="py-2 pr-3">
                        {FINDING_SOURCE_LABELS[d.category ?? ""] ?? d.category ?? "—"}
                      </td>
                      <td className="py-2 pr-3 tabular-nums">{d.groupIds?.length ?? "—"}</td>
                      <td className="max-w-sm py-2 pr-3">
                        <StepStatus status={r.status} />
                        {r.error && <span className="block text-xs text-danger">{r.error}</span>}
                      </td>
                      <td className="py-2 pr-3">
                        {r.model}
                        {d.fallbackUsed && (
                          <span className="block text-xs text-subtle">refusal fallback model</span>
                        )}
                      </td>
                      <td className="py-2 pr-3 tabular-nums">
                        {r.inputTokens ?? "—"} / {r.outputTokens ?? "—"}
                      </td>
                      <td className="py-2 pr-3">{formatDuration(r.latencyMs)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-subtle">
            Prompts and responses are not stored; the AI receives finding data only, never
            credentials.
          </p>
        </Card>
      )}

      {result.issues.length === 0 ? (
        <EmptyState icon={ListChecks} title="No issues for this scan" description={emptyText} />
      ) : items.length === 0 ? (
        <p className="rounded-lg border border-border bg-surface px-4 py-8 text-center text-sm text-muted">
          No issues match this filter.
        </p>
      ) : (
        <ul className="space-y-2">
          {items.map((i) => {
            const run = i.aiRunId ? runsById.get(i.aiRunId) : undefined;
            const claims = i.checks.filter((c) => c.checkType === "claim" && c.passed);
            return (
              <li
                key={i.id}
                id={`issue-${i.displayNo}`}
                className="scroll-mt-4 rounded-lg border border-border bg-surface"
              >
                <details>
                  <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
                    <span className="font-mono text-xs text-subtle">ISSUE-{i.displayNo}</span>
                    <SeverityBadge severity={i.severity} />
                    <span className="min-w-0 flex-1 font-medium">{i.title}</span>
                    <VerdictNote verdict={i.verdict} />
                    <GroundingBadge status={i.groundingStatus} />
                  </summary>
                  <div className="space-y-4 border-t border-border px-4 py-4 text-sm">
                    <p className="whitespace-pre-line break-words">{i.description}</p>
                    <dl className="grid gap-2 sm:grid-cols-[9rem_1fr]">
                      <dt className="text-muted">Category / rule</dt>
                      <dd>
                        {FINDING_SOURCE_LABELS[i.category] ?? i.category}
                        {i.ruleId && (
                          <>
                            {" · "}
                            <code className="font-mono text-xs">{i.ruleId}</code>
                          </>
                        )}
                      </dd>
                      <dt className="text-muted">Affected pages</dt>
                      <dd className="min-w-0">
                        {i.affectedUrls.length === 0 ? (
                          "Site-wide"
                        ) : (
                          <ul className="space-y-0.5">
                            {i.affectedUrls.slice(0, MAX_PAGES_SHOWN).map((u) => (
                              <li key={u} className="break-all">
                                {u}
                              </li>
                            ))}
                            {i.affectedUrls.length > MAX_PAGES_SHOWN && (
                              <li className="text-xs text-subtle">
                                and {i.affectedUrls.length - MAX_PAGES_SHOWN} more
                              </li>
                            )}
                          </ul>
                        )}
                      </dd>
                      {i.affectedElement && (
                        <>
                          <dt className="text-muted">Element</dt>
                          <dd className="break-all font-mono text-xs">{i.affectedElement}</dd>
                        </>
                      )}
                      {i.expected && (
                        <>
                          <dt className="text-muted">Expected</dt>
                          <dd className="break-words">{i.expected}</dd>
                        </>
                      )}
                      {i.actual && (
                        <>
                          <dt className="text-muted">Actual</dt>
                          <dd className="break-words">{i.actual}</dd>
                        </>
                      )}
                      <dt className="text-muted">Severity</dt>
                      <dd>
                        <SeverityBadge severity={i.severity} />
                        {i.severityRationale && (
                          <span className="ml-2 text-muted">{i.severityRationale}</span>
                        )}
                      </dd>
                      <dt className="text-muted">Confidence</dt>
                      <dd>{Math.round(i.confidence * 100)}%</dd>
                      <dt className="text-muted">Tracked as</dt>
                      <dd className="flex flex-wrap items-center gap-2">
                        <Link
                          href={`/projects/${project.id}/issues/${i.displayNo}?scan=${scanId}`}
                          className="text-primary underline"
                        >
                          ISSUE-{i.displayNo}
                        </Link>
                        <IssueStatusBadge status={i.trackStatus} />
                        <span className="text-xs text-muted">
                          status, history and every scan it was found in
                        </span>
                      </dd>
                    </dl>
                    {i.recommendation && (
                      <div>
                        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">
                          How to fix
                        </h3>
                        <p className="whitespace-pre-line break-words">{i.recommendation}</p>
                      </div>
                    )}
                    {claims.length > 0 && (
                      <div>
                        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">
                          Evidence-backed statements
                        </h3>
                        <ul className="list-disc space-y-1 pl-5">
                          {claims.map((c, k) => (
                            <li key={k}>
                              {String(c.detail.text)}{" "}
                              <span className="text-xs text-subtle">
                                ({String(c.detail.findingId)})
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    <div>
                      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">
                        Source findings ({i.findings.length})
                      </h3>
                      <ul className="flex flex-wrap gap-2">
                        {i.findings.map((f) => (
                          <li key={f.id}>
                            <Link
                              href={`${base}/findings?scanner=${i.category}#${f.displayId}`}
                              className="inline-flex items-center gap-1.5 rounded border border-border px-2 py-0.5 font-mono text-xs hover:bg-surface-muted"
                              title={f.title}
                            >
                              {f.displayId}
                            </Link>
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div>
                      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">
                        Evidence validation
                      </h3>
                      <p className="mb-2 text-xs text-muted">
                        {GROUNDING_LABELS[i.groundingStatus]?.help}
                        {run ? ` AI model: ${run.model}.` : ""}
                      </p>
                      <GroundingChecks checks={i.checks} />
                    </div>
                  </div>
                </details>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
