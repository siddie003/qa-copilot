import { FINDING_SOURCE_LABELS } from "@qa/core";
import { getDb, issuesRepo } from "@qa/db";
import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EvidenceView, type EvidenceItem } from "@/components/findings/evidence-view";
import {
  GROUNDING_LABELS,
  GroundingBadge,
  GroundingChecks,
  VerdictNote,
} from "@/components/issues/grounding";
import { PlainExplanation, Reliability } from "@/components/issues/plain-explanation";
import { StatusControl } from "@/components/issues/status-control";
import { TechnicalDisclosure } from "@/components/issues/technical-disclosure";
import { ISSUE_STATUS_LABELS, IssueStatusBadge, SeverityBadge } from "@/components/ui/badges";
import { Card } from "@/components/ui/stat";
import { cn } from "@/lib/cn";
import { formatDateTime, scanStatusLabel } from "@/lib/format";
import { loadProjectForPage } from "@/server/loaders";

export const metadata: Metadata = { title: "Issue" };

const FINDING_VERDICTS: Record<string, string> = {
  confirmed: "Confirmed",
  potential: "Potential (needs review)",
  inconclusive: "Inconclusive",
  unable_to_verify: "Unable to verify",
};

/** Statuses only the system sets; the user sees why and can still choose a workflow status. */
const SYSTEM_STATUS_HELP: Record<string, string> = {
  inconclusive:
    "Set automatically: the evidence could not confirm this issue. Review the findings below, then mark it Open, Resolved or Ignored.",
  reopened: "Set automatically: a scan found this issue again after it was marked resolved.",
};

const MAX_PAGES_SHOWN = 20;

export default async function IssueDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; issueNo: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id, issueNo } = await params;
  const q = await searchParams;
  const { user, project } = await loadProjectForPage(id);
  const displayNo = /^\d{1,9}$/.test(issueNo) ? Number(issueNo) : NaN;
  if (!Number.isSafeInteger(displayNo)) notFound();
  const trackId = await issuesRepo.findIssueIdByNumber(getDb(), user.id, project.id, displayNo);
  if (!trackId) notFound();
  const issue = await issuesRepo.getIssueDetail(getDb(), user.id, trackId, {
    scanId: typeof q.scan === "string" ? q.scan : undefined,
  });
  if (!issue) notFound();

  const o = issue.occurrence;
  const latest = issue.occurrences[0];
  const base = `/projects/${project.id}/issues/${issue.displayNo}`;
  const claims = o?.checks.filter((c) => c.checkType === "claim" && c.passed) ?? [];

  return (
    <div className="space-y-6">
      <Link
        href={`/projects/${project.id}/issues`}
        className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
      >
        <ArrowLeft aria-hidden className="size-4" />
        All issues of this project
      </Link>

      <header className="space-y-2">
        <p className="font-mono text-xs text-subtle">ISSUE-{issue.displayNo}</p>
        <h2 className="text-xl font-semibold break-words">{o?.title ?? issue.title}</h2>
        <div className="flex flex-wrap items-center gap-2">
          <SeverityBadge severity={o?.severity ?? issue.severity} />
          <IssueStatusBadge status={issue.status} />
          {o && <VerdictNote verdict={o.verdict} />}
          {o && <GroundingBadge status={o.groundingStatus} />}
          <span className="text-sm text-muted">
            {FINDING_SOURCE_LABELS[issue.category] ?? issue.category}
          </span>
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-6">
          {!o ? (
            <Card title="Details">
              <p className="text-sm text-muted">
                The scans that found this issue have been deleted, so its findings and evidence are
                no longer available. Its status history is kept.
              </p>
            </Card>
          ) : (
            <>
              {latest && o.id !== latest.issueId && (
                <p
                  role="note"
                  className="rounded-md border border-warning/40 bg-warning-bg px-3 py-2 text-sm"
                >
                  You are viewing the occurrence from scan #{o.scanNumber}.{" "}
                  <Link href={base} className="font-medium underline">
                    Show the latest (scan #{latest.scanNumber})
                  </Link>
                </p>
              )}
              <PlainExplanation
                occurrence={o}
                status={issue.status}
                scanLabel={`Scan #${o.scanNumber} · ${formatDateTime(o.scanCreatedAt)}`}
              />

              <TechnicalDisclosure
                title="Technical details and evidence"
                hint={`Rule, elements, raw scanner evidence (${o.findings.length} finding${o.findings.length === 1 ? "" : "s"}), HTML, measurements, screenshots and the evidence check`}
              >
                <Card title="How reliable">
                  <Reliability verdict={o.verdict} confidence={o.confidence} />
                </Card>

                <Card title="Technical details (for developers)">
                  <div className="space-y-4 text-sm">
                    <p className="text-xs text-muted">
                      From scan #{o.scanNumber} ({formatDateTime(o.scanCreatedAt)}) ·{" "}
                      <Link
                        href={`/projects/${project.id}/scans/${o.scanId}/issues#issue-${issue.displayNo}`}
                        className="text-primary underline"
                      >
                        all issues of that scan
                      </Link>
                    </p>
                    <p className="whitespace-pre-line break-words">{o.description}</p>
                    <dl className="grid gap-2 sm:grid-cols-[9rem_minmax(0,1fr)]">
                      <dt className="text-muted">Category / rule</dt>
                      <dd>
                        {FINDING_SOURCE_LABELS[o.category] ?? o.category}
                        {o.ruleId && (
                          <>
                            {" · "}
                            <code className="font-mono text-xs">{o.ruleId}</code>
                          </>
                        )}
                      </dd>
                      <dt className="text-muted">Affected pages</dt>
                      <dd className="min-w-0">
                        {o.affectedUrls.length === 0 ? (
                          "Site-wide"
                        ) : (
                          <ul className="space-y-0.5">
                            {o.affectedUrls.slice(0, MAX_PAGES_SHOWN).map((u) => (
                              <li key={u} className="break-all">
                                {u}
                              </li>
                            ))}
                            {o.affectedUrls.length > MAX_PAGES_SHOWN && (
                              <li className="text-xs text-subtle">
                                and {o.affectedUrls.length - MAX_PAGES_SHOWN} more
                              </li>
                            )}
                          </ul>
                        )}
                      </dd>
                      {o.affectedElement && (
                        <>
                          <dt className="text-muted">Element</dt>
                          <dd className="break-all font-mono text-xs">{o.affectedElement}</dd>
                        </>
                      )}
                      {o.expected && (
                        <>
                          <dt className="text-muted">Expected</dt>
                          <dd className="break-words">{o.expected}</dd>
                        </>
                      )}
                      {o.actual && (
                        <>
                          <dt className="text-muted">Actual</dt>
                          <dd className="break-words">{o.actual}</dd>
                        </>
                      )}
                      {o.recommendation && (
                        <>
                          <dt className="text-muted">Recommendation</dt>
                          <dd className="whitespace-pre-line break-words">{o.recommendation}</dd>
                        </>
                      )}
                      <dt className="text-muted">Text</dt>
                      <dd>
                        {GROUNDING_LABELS[o.groundingStatus]?.help}
                        {o.aiModel ? ` AI model: ${o.aiModel}.` : ""}
                      </dd>
                    </dl>
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
                  </div>
                </Card>

                <Card
                  anchor="evidence"
                  title={`Source findings and evidence (${o.findings.length})`}
                >
                  <ul className="space-y-2">
                    {o.findings.map((f, k) => (
                      <li key={f.id} className="rounded-md border border-border">
                        <details open={k === 0 && o.findings.length <= 3}>
                          <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                            <span className="font-mono text-xs text-subtle">{f.displayId}</span>
                            <SeverityBadge severity={f.severity} />
                            <span className="min-w-0 flex-1 font-medium break-words">
                              {f.title}
                            </span>
                            <span className="text-xs text-muted">
                              {FINDING_VERDICTS[f.verdict] ?? f.verdict}
                            </span>
                          </summary>
                          <div className="space-y-3 border-t border-border px-3 py-3 text-sm">
                            <p className="break-words">{f.message}</p>
                            <dl className="grid gap-2 sm:grid-cols-[8rem_minmax(0,1fr)]">
                              <dt className="text-muted">Page</dt>
                              <dd className="break-all">{f.pageUrl ?? "Site-wide"}</dd>
                              {f.selector && (
                                <>
                                  <dt className="text-muted">Element</dt>
                                  <dd className="break-all font-mono text-xs">{f.selector}</dd>
                                </>
                              )}
                              <dt className="text-muted">Viewport</dt>
                              <dd>{f.viewport ?? "All / not viewport-specific"}</dd>
                              {f.expected && (
                                <>
                                  <dt className="text-muted">Expected</dt>
                                  <dd className="break-words">{f.expected}</dd>
                                </>
                              )}
                              {f.actual && (
                                <>
                                  <dt className="text-muted">Actual</dt>
                                  <dd className="break-words">{f.actual}</dd>
                                </>
                              )}
                              <dt className="text-muted">Confidence</dt>
                              <dd>{Math.round(f.confidence * 100)}%</dd>
                            </dl>
                            <EvidenceView items={f.evidence as EvidenceItem[]} />
                            <Link
                              href={`/projects/${project.id}/scans/${o.scanId}/findings?scanner=${f.scanner}&finding=${f.displayId}#${f.displayId}`}
                              className="inline-block text-xs text-primary underline"
                            >
                              {f.displayId} in the scan&apos;s findings
                            </Link>
                          </div>
                        </details>
                      </li>
                    ))}
                  </ul>
                </Card>

                <Card title="Evidence validation">
                  <p className="mb-2 text-xs text-muted">
                    {GROUNDING_LABELS[o.groundingStatus]?.help}
                  </p>
                  <GroundingChecks checks={o.checks} />
                </Card>
              </TechnicalDisclosure>
            </>
          )}
        </div>

        <aside className="min-w-0 space-y-6" aria-label="Issue workflow">
          <Card title="Status">
            <div className="mb-3 flex items-center gap-2 text-sm">
              Current: <IssueStatusBadge status={issue.status} />
            </div>
            {SYSTEM_STATUS_HELP[issue.status] && (
              <p className="mb-3 text-xs text-muted">{SYSTEM_STATUS_HELP[issue.status]}</p>
            )}
            <StatusControl issueId={issue.id} displayNo={issue.displayNo} status={issue.status} />
          </Card>

          <Card title="History">
            {issue.history.length === 0 ? (
              <p className="text-sm text-muted">No status changes recorded.</p>
            ) : (
              <ol className="space-y-3">
                {issue.history.map((e) => (
                  <li key={e.id} className="text-sm">
                    <p>
                      {e.fromStatus ? (
                        <>
                          {ISSUE_STATUS_LABELS[e.fromStatus] ?? e.fromStatus} →{" "}
                          <span className="font-medium">
                            {ISSUE_STATUS_LABELS[e.toStatus] ?? e.toStatus}
                          </span>
                        </>
                      ) : (
                        <>
                          Detected as{" "}
                          <span className="font-medium">
                            {ISSUE_STATUS_LABELS[e.toStatus] ?? e.toStatus}
                          </span>
                        </>
                      )}
                    </p>
                    <p className="text-xs text-muted">
                      {e.userId ? (e.userName ?? "Deleted user") : "System"}
                      {e.scanNumber !== null ? ` · scan #${e.scanNumber}` : ""} ·{" "}
                      <time dateTime={new Date(e.createdAt).toISOString()}>
                        {formatDateTime(e.createdAt)}
                      </time>
                    </p>
                    {e.note && (
                      <p className="mt-1 whitespace-pre-line break-words rounded bg-surface-muted px-2 py-1 text-xs">
                        {e.note}
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </Card>

          <Card title={`Found in ${issue.occurrences.length} scan(s)`}>
            {issue.occurrences.length === 0 ? (
              <p className="text-sm text-muted">No stored occurrences.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {issue.occurrences.map((x) => (
                  <li key={x.issueId} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <Link
                      href={x === latest ? base : `${base}?scan=${x.scanId}`}
                      aria-current={o?.id === x.issueId ? "true" : undefined}
                      className={cn("hover:underline", o?.id === x.issueId && "font-semibold")}
                    >
                      Scan #{x.scanNumber}
                    </Link>
                    <SeverityBadge severity={x.severity} />
                    <span className="text-xs text-muted">
                      {x.findingCount} finding(s) · {formatDateTime(x.scanCreatedAt)} ·{" "}
                      {scanStatusLabel(x.scanStatus)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </aside>
      </div>
    </div>
  );
}
