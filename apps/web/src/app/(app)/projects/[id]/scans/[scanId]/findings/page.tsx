import { AppError, FINDING_SOURCE_LABELS, FINDING_SOURCES, SEVERITIES } from "@qa/core";
import { getDb, pipelineRepo, scanIssuesRepo } from "@qa/db";
import { ChevronRight, SearchCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EvidenceView, type EvidenceItem } from "@/components/findings/evidence-view";
import { LazyFindingGuide } from "@/components/issues/lazy-finding-guide";
import type { ExplainedFinding } from "@/components/issues/plain-explanation";
import { SEVERITY_LABELS, SeverityBadge } from "@/components/ui/badges";
import { buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { inputClasses } from "@/components/ui/field-styles";
import { Pagination } from "@/components/ui/pagination";
import { loadProjectForPage } from "@/server/loaders";
import { getScan } from "@/server/scans";

export const metadata: Metadata = { title: "Scan findings" };

/** Findings per page: each one carries its evidence (a 6,600-finding scan was a 64 MB page). */
const PAGE_SIZE = 100;

const VERDICT_LABELS: Record<string, string> = {
  confirmed: "Confirmed",
  potential: "Potential (needs review)",
  inconclusive: "Inconclusive",
  unable_to_verify: "Unable to verify",
};

interface Checks {
  evaluated?: number;
  inconclusive?: Array<{ check: string; reason: string; pageUrl?: string | null }>;
  inconclusiveTotal?: number;
  notes?: string[];
}

export default async function FindingsPage({
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

  const scanner =
    typeof q.scanner === "string" && (FINDING_SOURCES as readonly string[]).includes(q.scanner)
      ? q.scanner
      : "";
  const severity = (Array.isArray(q.severity) ? q.severity : q.severity ? [q.severity] : []).filter(
    (s) => (SEVERITIES as readonly string[]).includes(s),
  );
  const filter = { scanner: scanner || undefined, severity };
  const order = await pipelineRepo.listFindingDisplayIds(getDb(), user.id, scanId, filter);
  // `?finding=SEO-004` (links from issues) opens the page that contains that finding.
  const linked = typeof q.finding === "string" ? (order?.indexOf(q.finding) ?? -1) : -1;
  const requested = Number.parseInt(typeof q.page === "string" ? q.page : "1", 10) || 1;
  const pageCount = Math.max(1, Math.ceil((order?.length ?? 0) / PAGE_SIZE));
  const page =
    linked >= 0 ? Math.floor(linked / PAGE_SIZE) + 1 : Math.min(Math.max(1, requested), pageCount);
  const [findings, counts, issueOf] = await Promise.all([
    pipelineRepo.listFindingsForScan(getDb(), user.id, scanId, filter, {
      offset: (page - 1) * PAGE_SIZE,
      limit: PAGE_SIZE,
    }),
    pipelineRepo.findingCounts(getDb(), scanId),
    scanIssuesRepo.findingIssueLinks(getDb(), scanId),
  ]);
  const matching = order?.length ?? 0;
  const totalAll = counts.reduce((s, c) => s + c.n, 0);
  const base = `/projects/${project.id}/scans/${scanId}/findings`;
  const scannerRuns = scan.runs.filter((r) =>
    (FINDING_SOURCES as readonly string[]).includes(r.stepKey),
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">
          Findings · Scan #{scan.number}{" "}
          <span className="text-sm font-normal text-muted">({totalAll} in total)</span>
        </h2>
        <Link
          href={`/projects/${project.id}/scans/${scanId}`}
          className="text-sm text-primary hover:underline"
        >
          Back to scan progress
        </Link>
      </div>
      <p className="text-sm text-muted">
        Raw scanner findings with their evidence, exactly as the scanners reported them; nothing
        here is AI-generated. Each finding belongs to one{" "}
        <Link
          href={`/projects/${project.id}/scans/${scanId}/issues`}
          className="text-primary underline"
        >
          issue of this scan
        </Link>
        .
      </p>

      <form
        role="search"
        action={base}
        className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface p-4"
      >
        <div>
          <label htmlFor="f-scanner" className="mb-1 block text-xs font-medium text-muted">
            Scanner
          </label>
          <select id="f-scanner" name="scanner" defaultValue={scanner} className={inputClasses}>
            <option value="">All scanners</option>
            {FINDING_SOURCES.map((k) => (
              <option key={k} value={k}>
                {FINDING_SOURCE_LABELS[k]}
              </option>
            ))}
          </select>
        </div>
        <fieldset>
          <legend className="mb-1 text-xs font-medium text-muted">Severity</legend>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {SEVERITIES.map((s) => (
              <label key={s} className="flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  name="severity"
                  value={s}
                  defaultChecked={severity.includes(s)}
                  className="size-4 accent-[var(--primary)]"
                />
                {SEVERITY_LABELS[s]}
              </label>
            ))}
          </div>
        </fieldset>
        <button type="submit" className={buttonClasses("primary", "sm")}>
          Apply
        </button>
        {(scanner || severity.length > 0) && (
          <Link href={base} className={buttonClasses("ghost", "sm")}>
            Clear
          </Link>
        )}
      </form>

      {!findings || findings.length === 0 ? (
        <EmptyState
          icon={SearchCheck}
          title={totalAll === 0 ? "No findings in this scan" : "No findings match these filters"}
          description={
            totalAll === 0
              ? "The scanners that ran reported no problems. See the inconclusive checks below for anything that could not be verified."
              : "Change or clear the filters."
          }
        />
      ) : (
        <>
          <p className="text-sm text-muted" aria-live="polite">
            {matching > PAGE_SIZE
              ? `Showing ${(page - 1) * PAGE_SIZE + 1}–${(page - 1) * PAGE_SIZE + findings.length} of ${matching} findings`
              : `${matching} finding${matching === 1 ? "" : "s"}`}
            {scanner || severity.length ? " matching these filters" : ""}
          </p>
          <ul className="space-y-2">
            {findings.map((f) => (
              <li
                key={f.id}
                id={f.displayId}
                className="scroll-mt-4 rounded-lg border border-border bg-surface"
              >
                <details open={f.displayId === q.finding}>
                  <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
                    <span className="font-mono text-xs text-subtle">{f.displayId}</span>
                    <SeverityBadge severity={f.severity} />
                    <span className="min-w-0 flex-1 font-medium">{f.title}</span>
                    <span className="text-xs text-muted">
                      {VERDICT_LABELS[f.verdict] ?? f.verdict}
                    </span>
                  </summary>
                  <div className="space-y-4 border-t border-border px-4 py-4 text-sm">
                    <LazyFindingGuide
                      initiallyOpen={f.displayId === q.finding}
                      finding={{
                        displayId: f.displayId,
                        scanner: f.scanner,
                        ruleId: f.ruleId,
                        verdict: f.verdict,
                        viewport: f.viewport,
                        selector: f.selector,
                        pageUrl: f.pageUrl,
                        expected: f.expected,
                        actual: f.actual,
                        // Screenshots are not used by the guide (keeps the page payload small).
                        evidence: (f.evidence as ExplainedFinding["evidence"]).filter(
                          (e) => e.kind !== "screenshot",
                        ),
                      }}
                      issueHref={
                        issueOf.get(f.id)
                          ? `/projects/${project.id}/issues/${issueOf.get(f.id)!.displayNo}?scan=${scanId}`
                          : undefined
                      }
                      issueLabel={
                        issueOf.get(f.id) ? `ISSUE-${issueOf.get(f.id)!.displayNo}` : undefined
                      }
                    />
                    <details className="group/tech rounded-md border border-border">
                      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-2 font-semibold hover:bg-surface-muted [&::-webkit-details-marker]:hidden">
                        <ChevronRight
                          aria-hidden
                          className="size-4 shrink-0 text-muted transition-transform group-open/tech:rotate-90"
                        />
                        Technical details and evidence
                        <span className="font-normal text-muted">
                          (scanner message, rule, element, raw evidence)
                        </span>
                      </summary>
                      <div className="space-y-4 border-t border-border px-3 py-3">
                        <p>{f.message}</p>
                        <dl className="grid gap-2 sm:grid-cols-[9rem_1fr]">
                          <dt className="text-muted">Scanner / rule</dt>
                          <dd>
                            {FINDING_SOURCE_LABELS[f.scanner] ?? f.scanner} ·{" "}
                            <code className="font-mono text-xs">{f.ruleId}</code>
                          </dd>
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
                          {issueOf.get(f.id) && (
                            <>
                              <dt className="text-muted">Issue</dt>
                              <dd>
                                <Link
                                  href={`/projects/${project.id}/issues/${issueOf.get(f.id)!.displayNo}?scan=${scanId}`}
                                  className="text-primary hover:underline"
                                >
                                  ISSUE-{issueOf.get(f.id)!.displayNo}
                                </Link>
                              </dd>
                            </>
                          )}
                        </dl>
                        <div>
                          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
                            Evidence
                          </h3>
                          <EvidenceView items={f.evidence as EvidenceItem[]} />
                        </div>
                      </div>
                    </details>
                  </div>
                </details>
              </li>
            ))}
          </ul>
          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={matching}
            basePath={base}
            params={{ scanner: scanner || undefined, severity }}
            noun="findings"
          />
        </>
      )}

      <section
        aria-labelledby="inconclusive-heading"
        className="rounded-lg border border-border bg-surface p-4"
      >
        <h2 id="inconclusive-heading" className="text-sm font-semibold">
          Checks that could not be verified
        </h2>
        <p className="mt-1 text-xs text-muted">
          Reported separately so that nothing unverified is presented as a confirmed problem or as a
          pass.
        </p>
        <div className="mt-3 space-y-4">
          {scannerRuns.map((r) => {
            const c = (r.checks ?? {}) as Checks;
            const list = c.inconclusive ?? [];
            return (
              <div key={r.id}>
                <h3 className="text-sm font-medium">
                  {FINDING_SOURCE_LABELS[r.stepKey]}{" "}
                  <span className="font-normal text-muted">
                    · {r.status}
                    {typeof c.evaluated === "number" ? ` · ${c.evaluated} checks evaluated` : ""}
                  </span>
                </h3>
                {list.length === 0 ? (
                  <p className="text-xs text-subtle">
                    {r.status === "skipped" ? r.statusReason : "None."}
                  </p>
                ) : (
                  <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-muted">
                    {list.map((x, i) => (
                      <li key={i}>
                        <span className="font-medium text-foreground">{x.check}</span>: {x.reason}
                        {x.pageUrl ? <span className="break-all"> ({x.pageUrl})</span> : null}
                      </li>
                    ))}
                    {(c.inconclusiveTotal ?? 0) > list.length && (
                      <li>…and {(c.inconclusiveTotal ?? 0) - list.length} more</li>
                    )}
                  </ul>
                )}
                {c.notes?.map((n, i) => (
                  <p key={i} className="mt-1 text-xs text-subtle">
                    {n}
                  </p>
                ))}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
