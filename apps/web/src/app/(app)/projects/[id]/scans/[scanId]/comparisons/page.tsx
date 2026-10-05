import { AppError, COMPARISON_KEYS, COMPARISON_LABELS } from "@qa/core";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  COMPARISON_VERDICTS,
  ComparisonVerdict,
  type ComparisonVerdictKey,
} from "@/components/references/comparison-verdict";
import { StepStatus } from "@/components/ui/badges";
import { cn } from "@/lib/cn";
import { loadProjectForPage } from "@/server/loaders";
import { getScan } from "@/server/scans";

export const metadata: Metadata = { title: "Reference comparison" };

interface Item {
  key: string;
  label: string;
  verdict: string;
  expected?: string | null;
  actual?: string | null;
  pageUrl?: string | null;
  reference?: string | null;
  detail?: string | null;
}
interface Comparison {
  matched: number;
  confirmedMismatch: number;
  potentialMismatch: number;
  unableToVerify: number;
  items: Item[];
}

const COUNTS: Array<[ComparisonVerdictKey, keyof Comparison]> = [
  ["match", "matched"],
  ["confirmed_mismatch", "confirmedMismatch"],
  ["potential_mismatch", "potentialMismatch"],
  ["unable_to_verify", "unableToVerify"],
];

export default async function ComparisonsPage({
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
  const verdict =
    typeof q.verdict === "string" && q.verdict in COMPARISON_VERDICTS ? q.verdict : "";
  const base = `/projects/${project.id}/scans/${scanId}/comparisons`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Reference comparison · Scan #{scan.number}</h2>
        <div className="flex gap-3 text-sm">
          <Link
            href={`/projects/${project.id}/scans/${scanId}/findings`}
            className="text-primary hover:underline"
          >
            Findings
          </Link>
          <Link
            href={`/projects/${project.id}/references`}
            className="text-primary hover:underline"
          >
            References
          </Link>
        </div>
      </div>
      <nav aria-label="Filter by verdict" className="flex flex-wrap gap-2 text-sm">
        {[["", "All"], ...Object.entries(COMPARISON_VERDICTS).map(([k, v]) => [k, v.label])].map(
          ([k, label]) => (
            <Link
              key={k}
              href={k ? `${base}?verdict=${k}` : base}
              aria-current={verdict === k ? "page" : undefined}
              className={cn(
                "rounded-full border px-3 py-1",
                verdict === k
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border hover:bg-surface-muted",
              )}
            >
              {label}
            </Link>
          ),
        )}
      </nav>

      {COMPARISON_KEYS.map((key) => {
        const run = scan.runs.find((r) => r.stepKey === key);
        const cmp = (run?.checks as { comparison?: Comparison } | null)?.comparison;
        const items = (cmp?.items ?? []).filter((i) => !verdict || i.verdict === verdict);
        return (
          <section
            key={key}
            aria-labelledby={`cmp-${key}`}
            className="rounded-lg border border-border bg-surface"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
              <h3 id={`cmp-${key}`} className="text-sm font-semibold">
                {COMPARISON_LABELS[key]}
              </h3>
              {run && <StepStatus status={run.status} />}
            </div>
            <div className="space-y-4 p-4">
              {!run ? (
                <p className="text-sm text-muted">Not part of this scan.</p>
              ) : !cmp ? (
                <p className="text-sm text-muted">
                  {run.error ?? run.statusReason ?? "No comparison results."}
                </p>
              ) : (
                <>
                  <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    {COUNTS.map(([v, field]) => (
                      <div key={v} className="rounded-md border border-border px-3 py-2">
                        <dt>
                          <ComparisonVerdict verdict={v} />
                        </dt>
                        <dd className="mt-1 text-xl font-semibold tabular-nums">
                          {cmp[field] as number}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  {items.length === 0 ? (
                    <p className="text-sm text-muted">No items with this verdict.</p>
                  ) : (
                    <div
                      role="region"
                      aria-label={`${COMPARISON_LABELS[key]} items`}
                      tabIndex={0}
                      className="relative overflow-x-auto rounded-md border border-border"
                    >
                      <table className="w-full min-w-[900px] text-left text-sm">
                        <caption className="sr-only">
                          {COMPARISON_LABELS[key]} of scan #{scan.number}
                        </caption>
                        <thead className="border-b border-border bg-surface-muted text-xs uppercase tracking-wide text-muted">
                          <tr>
                            <th scope="col" className="px-3 py-2 font-medium">
                              {key === "design" ? "Value" : "Approved text"}
                            </th>
                            <th scope="col" className="px-3 py-2 font-medium">
                              Verdict
                            </th>
                            {key === "design" && (
                              <th scope="col" className="px-3 py-2 font-medium">
                                Expected
                              </th>
                            )}
                            <th scope="col" className="px-3 py-2 font-medium">
                              {key === "design" ? "Found" : "Found on the website"}
                            </th>
                            <th scope="col" className="px-3 py-2 font-medium">
                              Details
                            </th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {items.map((i) => (
                            <tr key={i.key} className="align-top">
                              <td className="max-w-xs px-3 py-2">
                                <span className="break-words font-medium">{i.label}</span>
                                {i.reference && (
                                  <span className="block text-xs text-subtle">{i.reference}</span>
                                )}
                              </td>
                              <td className="px-3 py-2">
                                <ComparisonVerdict verdict={i.verdict} />
                              </td>
                              {key === "design" && (
                                <td className="max-w-xs break-words px-3 py-2">
                                  {i.expected ?? "—"}
                                </td>
                              )}
                              <td className="max-w-xs break-words px-3 py-2">{i.actual ?? "—"}</td>
                              <td className="max-w-sm px-3 py-2 text-muted">
                                {i.detail ?? "—"}
                                {i.pageUrl && (
                                  <span className="block break-all text-xs text-subtle">
                                    {i.pageUrl}
                                  </span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {cmp.items.length <
                    cmp.matched +
                      cmp.confirmedMismatch +
                      cmp.potentialMismatch +
                      cmp.unableToVerify && (
                    <p className="text-xs text-subtle">
                      Only the first {cmp.items.length} items are listed.
                    </p>
                  )}
                </>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
