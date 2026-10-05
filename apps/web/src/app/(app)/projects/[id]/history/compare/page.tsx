import { AppError, MAX_BULK_ISSUES } from "@qa/core";
import { comparisonsRepo } from "@qa/db";
import {
  CHANGE_CATEGORIES,
  CHANGE_CATEGORY_DESCRIPTIONS,
  CHANGE_CATEGORY_LABELS,
  pageKey,
  sourceLabel,
  type ChangeCategory,
  type ComparisonFindingRef,
  type FieldChange,
  type FindingComparisonItem,
  type IssueComparisonItem,
  type ScanComparisonResult,
  type StepComparisonItem,
} from "@qa/core/comparison";
import { ArrowLeft, ArrowRight, GitCompareArrows } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChangeBadge, FindingChangeBadge } from "@/components/history/change-badge";
import { ConfirmResolved } from "@/components/history/confirm-resolved";
import { CompareForm } from "@/components/history/compare-form";
import { Alert } from "@/components/ui/alert";
import { IssueStatusBadge, SeverityBadge, StepStatus } from "@/components/ui/badges";
import { EmptyState } from "@/components/ui/empty-state";
import { Card, StatTile } from "@/components/ui/stat";
import { cn } from "@/lib/cn";
import { formatDateTime, scanStatusLabel } from "@/lib/format";
import { comparePair, resolvePair } from "@/server/comparisons";
import { loadProjectForPage } from "@/server/loaders";

export const metadata: Metadata = { title: "Compare scans" };

const VERDICT_LABELS: Record<string, string> = {
  confirmed: "Confirmed",
  potential: "Needs review",
  inconclusive: "Unable to verify",
  unable_to_verify: "Unable to verify",
};

const FIELD_LABELS: Record<FieldChange["field"], string> = {
  severity: "Severity",
  verdict: "Verdict",
  actual: "Observed value",
  expected: "Expected value",
  viewport: "Viewport",
  pages: "Affected pages",
};

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

function fieldValue(c: FieldChange, v: string | null) {
  if (v === null) return "—";
  if (c.field === "verdict") return VERDICT_LABELS[v] ?? v;
  if (c.field === "viewport") return v || "several";
  return v.length > 160 ? `${v.slice(0, 160)}…` : v;
}

function Changes({ changes }: { changes: FieldChange[] }) {
  if (!changes.length) return null;
  return (
    <ul className="space-y-0.5 text-xs">
      {changes.map((c) => (
        <li key={c.field} className="break-words">
          <span className="font-medium">{FIELD_LABELS[c.field]}:</span>{" "}
          <span className="text-muted">{fieldValue(c, c.from)}</span> →{" "}
          <span>{fieldValue(c, c.to)}</span>
          {c.measurement && (
            <span className="text-muted">
              {" "}
              (lab measurement; varies between page loads, not counted as a change)
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function FindingRow({
  item,
  projectId,
  baseScanId,
  targetScanId,
}: {
  item: FindingComparisonItem;
  projectId: string;
  baseScanId: string;
  targetScanId: string;
}) {
  const ref = (f: ComparisonFindingRef, scanId: string, label: string) => (
    <Link
      href={`/projects/${projectId}/scans/${scanId}/findings#${f.displayId}`}
      prefetch={false}
      className="font-mono text-xs text-primary underline"
    >
      {f.displayId}
      <span className="sr-only"> ({label} scan)</span>
    </Link>
  );
  const f = (item.target ?? item.base)!;
  const where = [
    f.pageUrl ? (pageKey(f.pageUrl) ?? f.pageUrl) : "Site-wide",
    f.viewport,
    f.selector ? `“${f.selector.length > 80 ? `${f.selector.slice(0, 80)}…` : f.selector}”` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <li className="space-y-1 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <FindingChangeBadge category={item.category} />
        {item.base && ref(item.base, baseScanId, "base")}
        {item.base && item.target && (
          <ArrowRight aria-label="then" className="size-3 text-subtle" />
        )}
        {item.target && ref(item.target, targetScanId, "target")}
        <span className="min-w-0 break-words text-xs text-muted">{where}</span>
      </div>
      {item.reason && <p className="text-xs text-muted">{item.reason}</p>}
      <Changes changes={item.changes} />
    </li>
  );
}

function IssueRow({
  item,
  projectId,
  result,
}: {
  item: IssueComparisonItem;
  projectId: string;
  result: ScanComparisonResult;
}) {
  const scanForLink = item.target ? result.target.id : result.base.id;
  const side = (item.target ?? item.base)!;
  const notable = item.findings.filter((f) => f.category !== "persistent");
  const unchanged = item.findings.length - notable.length;
  return (
    <li className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <ChangeBadge category={item.category} />
        {/* One link per issue (dozens): no prefetch of every issue page in view. */}
        <Link
          href={`/projects/${projectId}/issues/${item.displayNo}?scan=${scanForLink}`}
          prefetch={false}
          className="font-mono text-sm font-medium text-primary hover:underline"
        >
          ISSUE-{item.displayNo}
        </Link>
        <span className="min-w-0 break-words font-medium">{side.title}</span>
      </div>
      <dl className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        <div className="flex items-center gap-1">
          <dt>Source:</dt>
          <dd className="text-foreground">
            {sourceLabel(item.source)}
            {item.ruleId ? ` · ${item.ruleId}` : ""}
          </dd>
        </div>
        <div className="flex items-center gap-1">
          <dt>Severity:</dt>
          <dd className="flex items-center gap-1">
            {item.base && <SeverityBadge severity={item.base.severity} />}
            {item.base && item.target && item.base.severity !== item.target.severity && (
              <>
                <ArrowRight aria-label="changed to" className="size-3" />
                <SeverityBadge severity={item.target.severity} />
              </>
            )}
            {!item.base && item.target && <SeverityBadge severity={item.target.severity} />}
          </dd>
        </div>
        <div className="flex items-center gap-1">
          <dt>Verdict:</dt>
          <dd className="text-foreground">
            {item.base && item.target && item.base.verdict !== item.target.verdict
              ? `${VERDICT_LABELS[item.base.verdict]} → ${VERDICT_LABELS[item.target.verdict]}`
              : VERDICT_LABELS[side.verdict]}
          </dd>
        </div>
        <div className="flex items-center gap-1">
          <dt>Findings:</dt>
          <dd className="text-foreground tabular-nums">
            {item.base?.findingCount ?? 0} → {item.target?.findingCount ?? 0}
          </dd>
        </div>
        {item.trackStatus && (
          <div className="flex items-center gap-1">
            <dt>Current status:</dt>
            <dd>
              <IssueStatusBadge status={item.trackStatus} />
            </dd>
          </div>
        )}
      </dl>
      <p className="text-sm">{item.reason}</p>
      <Changes changes={item.changes} />
      {item.findings.length > 0 && (
        <details className="rounded-md border border-border px-3 py-1">
          <summary className="cursor-pointer py-1 text-xs font-medium">
            Findings: {notable.length} with a difference
            {unchanged ? `, ${unchanged} unchanged` : ""}
          </summary>
          <ul className="divide-y divide-border">
            {[...notable, ...item.findings.filter((f) => f.category === "persistent")].map(
              (f, k) => (
                <FindingRow
                  key={`${f.base?.id ?? ""}-${f.target?.id ?? ""}-${k}`}
                  item={f}
                  projectId={projectId}
                  baseScanId={result.base.id}
                  targetScanId={result.target.id}
                />
              ),
            )}
          </ul>
        </details>
      )}
    </li>
  );
}

function StepCell({ side }: { side: StepComparisonItem["base"] }) {
  if (!side) return <span className="text-xs text-subtle">Not part of this scan</span>;
  return (
    <div className="space-y-0.5">
      <StepStatus status={side.status} />
      <div className="text-xs text-muted">
        {side.findingCount} finding{side.findingCount === 1 ? "" : "s"}
        {side.inconclusiveChecks ? ` · ${side.inconclusiveChecks} inconclusive checks` : ""}
      </div>
      {side.reason && side.status !== "completed" && (
        <div className="max-w-xs break-words text-xs text-muted">{side.reason}</div>
      )}
    </div>
  );
}

const DIRECTION_LABELS: Record<StepComparisonItem["direction"], string> = {
  same: "Unchanged",
  better: "Now completes",
  worse: "No longer completes",
  different: "Status changed",
  added: "Only in the target scan",
  removed: "Only in the base scan",
};

function StepsTable({
  steps,
  base,
  target,
}: {
  steps: StepComparisonItem[];
  base: number;
  target: number;
}) {
  return (
    <div
      role="region"
      aria-label="Scanner and step status table"
      tabIndex={0}
      className="relative overflow-x-auto"
    >
      <table className="w-full min-w-[640px] text-left text-sm">
        <caption className="sr-only">
          Status of each scanner and pipeline step in scan #{base} and scan #{target}
        </caption>
        <thead className="border-b border-border text-xs uppercase tracking-wide text-muted">
          <tr>
            <th scope="col" className="py-2 pr-4 font-medium">
              Step
            </th>
            <th scope="col" className="py-2 pr-4 font-medium">
              Scan #{base}
            </th>
            <th scope="col" className="py-2 pr-4 font-medium">
              Scan #{target}
            </th>
            <th scope="col" className="py-2 font-medium">
              Change
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {steps.map((s) => (
            <tr key={s.stepKey}>
              <th scope="row" className="py-2 pr-4 align-top font-medium">
                {s.label}
              </th>
              <td className="py-2 pr-4 align-top">
                <StepCell side={s.base} />
              </td>
              <td className="py-2 pr-4 align-top">
                <StepCell side={s.target} />
              </td>
              <td
                className={cn(
                  "py-2 align-top text-xs font-medium",
                  s.direction === "worse"
                    ? "text-danger"
                    : s.direction === "better"
                      ? "text-success"
                      : "text-muted",
                )}
              >
                {DIRECTION_LABELS[s.direction]}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function CompareScansPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user, project } = await loadProjectForPage((await params).id);
  const q = await searchParams;
  let pair;
  try {
    pair = await resolvePair(user.id, project.id, { base: str(q.base), target: str(q.target) });
  } catch (err) {
    if (err instanceof AppError && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  const back = (
    <Link
      href={`/projects/${project.id}/history`}
      className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
    >
      <ArrowLeft aria-hidden className="size-4" />
      Scan history
    </Link>
  );
  if (!pair.base || !pair.target)
    return (
      <div className="space-y-4">
        {back}
        <EmptyState
          icon={GitCompareArrows}
          title="Nothing to compare yet"
          description={pair.missing ?? "Choose two finished scans."}
        />
      </div>
    );

  let result: ScanComparisonResult | null = null;
  let problem: string | null = null;
  try {
    result = await comparePair(project.id, pair);
  } catch (err) {
    if (err instanceof AppError && err.status < 500) problem = err.message;
    else throw err;
  }
  const show = CHANGE_CATEGORIES.includes(str(q.show) as ChangeCategory)
    ? (str(q.show) as ChangeCategory)
    : null;
  const base = `/projects/${project.id}/history/compare?base=${pair.base.id}&target=${pair.target.id}`;
  // Confirming fixes is offered only against the latest comparable scan: an older comparison
  // may be contradicted by a later scan that found the issue again.
  const targetIsLatest = pair.scans.find(comparisonsRepo.isComparable)?.id === pair.target.id;

  return (
    <div className="space-y-6">
      {back}
      <Card title="Scans compared">
        <CompareForm
          projectId={project.id}
          scans={pair.scans}
          baseId={pair.base.id}
          targetId={pair.target.id}
        />
      </Card>

      {problem && <Alert tone="error">{problem}</Alert>}

      {result && (
        <>
          <section aria-labelledby="comparison-heading" className="space-y-3">
            <h2
              id="comparison-heading"
              className="flex flex-wrap items-center gap-2 text-lg font-semibold"
            >
              <Link
                href={`/projects/${project.id}/scans/${result.base.id}`}
                className="hover:underline"
              >
                Scan #{result.base.number}
              </Link>
              <ArrowRight aria-label="compared with" className="size-4 text-subtle" />
              <Link
                href={`/projects/${project.id}/scans/${result.target.id}`}
                className="hover:underline"
              >
                Scan #{result.target.number}
              </Link>
            </h2>
            <p className="text-sm text-muted">
              Base: {scanStatusLabel(result.base.status)}
              {result.base.startedAt ? `, ${formatDateTime(result.base.startedAt)}` : ""},{" "}
              {result.base.issueCount} issues · Target: {scanStatusLabel(result.target.status)}
              {result.target.startedAt ? `, ${formatDateTime(result.target.startedAt)}` : ""},{" "}
              {result.target.issueCount} issues. Built from the stored records of both scans; an
              issue that disappeared counts as resolved only if the target scan re-checked it.
            </p>
            {result.notComparable.map((m) => (
              <Alert key={m} tone="error">
                Issues cannot be compared: {m}
              </Alert>
            ))}
            {result.warnings.length > 0 && (
              <Alert tone="info">
                <p className="font-medium">What limits this comparison</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5">
                  {result.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </Alert>
            )}
          </section>

          {result.comparable && (
            <>
              <nav aria-label="Change categories">
                <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
                  {CHANGE_CATEGORIES.map((k) => (
                    <li key={k} aria-current={show === k ? "true" : undefined}>
                      <StatTile
                        label={CHANGE_CATEGORY_LABELS[k]}
                        value={result.summary.counts[k]}
                        href={`${base}&show=${k}#issues`}
                      />
                    </li>
                  ))}
                </ul>
              </nav>
              <p className="text-xs text-muted">
                Target scan: {result.summary.targetNeedsReview} issue(s) need review and{" "}
                {result.summary.targetUnableToVerify} could not be verified from the available
                evidence (shown with their verdict below, never counted as resolved).
              </p>

              <section id="issues" aria-labelledby="issues-heading" className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 id="issues-heading" className="text-sm font-semibold">
                    {show ? `${CHANGE_CATEGORY_LABELS[show]} issues` : "All issues"}
                  </h2>
                  {show && (
                    <Link href={`${base}#issues`} className="text-sm text-primary hover:underline">
                      Show all categories
                    </Link>
                  )}
                </div>
                {(show ? [show] : CHANGE_CATEGORIES).map((k) => {
                  const items = result.issues.filter((i) => i.category === k);
                  if (!items.length && !show) return null;
                  return (
                    <section
                      key={k}
                      aria-labelledby={`cat-${k}`}
                      className="rounded-lg border border-border bg-surface"
                    >
                      <div className="border-b border-border px-4 py-3">
                        <h3
                          id={`cat-${k}`}
                          className="flex items-center gap-2 text-sm font-semibold"
                        >
                          {CHANGE_CATEGORY_LABELS[k]}
                          <span className="font-normal text-muted">({items.length})</span>
                        </h3>
                        <p className="mt-0.5 text-xs text-muted">
                          {CHANGE_CATEGORY_DESCRIPTIONS[k]}
                        </p>
                        {k === "resolved" && targetIsLatest && (
                          <div className="mt-2">
                            <ConfirmResolved
                              trackIds={items
                                .filter(
                                  (i) => !["resolved", "ignored"].includes(i.trackStatus ?? ""),
                                )
                                .map((i) => i.trackId)
                                .slice(0, MAX_BULK_ISSUES)}
                              baseNumber={result.base.number}
                              targetNumber={result.target.number}
                            />
                          </div>
                        )}
                      </div>
                      {items.length ? (
                        <ul className="divide-y divide-border">
                          {items.map((item) => (
                            <IssueRow
                              key={item.trackId}
                              item={item}
                              projectId={project.id}
                              result={result}
                            />
                          ))}
                        </ul>
                      ) : (
                        <p className="px-4 py-3 text-sm text-muted">No issues in this category.</p>
                      )}
                    </section>
                  );
                })}
              </section>
            </>
          )}

          <Card title="Scanner and step status">
            {result.steps.some((s) => s.direction !== "same") ? (
              <StepsTable
                steps={result.steps.filter((s) => s.direction !== "same")}
                base={result.base.number}
                target={result.target.number}
              />
            ) : (
              <p className="text-sm text-muted">Every step had the same status in both scans.</p>
            )}
            {result.steps.some((s) => s.direction === "same") && (
              <details className="mt-3">
                <summary className="cursor-pointer text-sm font-medium">
                  Steps with the same status (
                  {result.steps.filter((s) => s.direction === "same").length})
                </summary>
                <div className="mt-2">
                  <StepsTable
                    steps={result.steps.filter((s) => s.direction === "same")}
                    base={result.base.number}
                    target={result.target.number}
                  />
                </div>
              </details>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
