import { SCANNER_KEYS, SEVERITIES, stepLabel } from "@qa/core";
import { dashboardRepo, getDb } from "@qa/db";
import { FolderKanban, Plus, Radar } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { SEVERITY_LABELS, StepStatus } from "@/components/ui/badges";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { InfoTip } from "@/components/ui/info-tip";
import { PageHeader } from "@/components/ui/page-header";
import { Card, SEVERITY_MARKERS, StatTile } from "@/components/ui/stat";
import { StatusPill } from "@/components/ui/status-pill";
import { formatDateTime, scanStatusLabel, scanStatusTone } from "@/lib/format";
import { requirePageUser } from "@/server/session";

export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const user = await requirePageUser();
  const d = await dashboardRepo.getDashboardSummary(getDb(), user.id);
  const c = d.issueCounts;

  const header = (
    <PageHeader
      title="Dashboard"
      description="Figures across all your projects, calculated from stored scan results."
      actions={
        <ButtonLink href="/projects/new">
          <Plus aria-hidden className="size-4" />
          New project
        </ButtonLink>
      }
    />
  );

  if (d.projectCount === 0) {
    return (
      <>
        {header}
        <EmptyState
          icon={FolderKanban}
          title="No projects yet"
          description="Create a project for the website you want to QA. The dashboard only shows figures from real scans."
          action={<ButtonLink href="/projects/new">Create project</ButtonLink>}
        />
      </>
    );
  }

  const latestRuns = new Map(d.latestScan?.runs.map((r) => [r.stepKey, r]) ?? []);

  return (
    <>
      {header}
      <div className="space-y-6">
        <section aria-labelledby="totals-heading">
          <h2 id="totals-heading" className="sr-only">
            Totals
          </h2>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <StatTile label="Projects" value={d.projectCount} href="/projects" />
            <StatTile label="Total issues" value={c.total} href="/issues" />
            <StatTile label="Open" value={c.open} href="/issues?status=open" />
            <StatTile label="Reopened" value={c.reopened} href="/issues?status=reopened" />
            <StatTile label="In progress" value={c.inProgress} href="/issues?status=in_progress" />
            <StatTile label="Resolved" value={c.resolved} href="/issues?status=resolved" />
          </div>
        </section>

        <section aria-labelledby="severity-heading">
          <h2 id="severity-heading" className="mb-2 flex items-center gap-1 text-sm font-semibold">
            Outstanding issues by severity
            <InfoTip label="About severity counts">
              Counts open, in-progress and reopened issues. Resolved, ignored and inconclusive
              issues are not included.
            </InfoTip>
          </h2>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            {SEVERITIES.map((s) => (
              <StatTile
                key={s}
                label={SEVERITY_LABELS[s]!}
                value={c[s]}
                marker={SEVERITY_MARKERS[s]}
                href={`/issues?severity=${s}&status=open&status=in_progress&status=reopened`}
              />
            ))}
          </div>
          {c.inconclusive > 0 && (
            <p className="mt-2 text-xs text-muted">
              {c.inconclusive} inconclusive check{c.inconclusive === 1 ? "" : "s"} could not be
              verified from the available evidence.
            </p>
          )}
        </section>

        <div className="grid gap-6 xl:grid-cols-2">
          <Card
            title="Scanner status (latest scan)"
            action={
              d.latestScan && (
                <Link
                  href={`/projects/${d.latestScan.projectId}/scanners`}
                  className="text-sm text-primary hover:underline"
                >
                  Details
                </Link>
              )
            }
          >
            {d.latestScan ? (
              <>
                <p className="mb-3 text-sm text-muted">
                  {d.latestScan.projectName} · Scan #{d.latestScan.number} ·{" "}
                  {formatDateTime(d.latestScan.createdAt)}
                </p>
                <ul className="divide-y divide-border">
                  {SCANNER_KEYS.map((key) => {
                    const run = latestRuns.get(key);
                    return (
                      <li
                        key={key}
                        className="flex items-center justify-between gap-3 py-2 text-sm"
                      >
                        <span>{stepLabel(key)}</span>
                        {run ? (
                          <StepStatus status={run.status} />
                        ) : (
                          <span className="text-subtle">Not run in this scan</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </>
            ) : (
              <p className="text-sm text-muted">
                No scans have run yet, so there is no scanner status to show.
              </p>
            )}
          </Card>

          <Card title="Recent scans">
            {d.recentScans.length ? (
              <ul className="divide-y divide-border">
                {d.recentScans.map((s) => (
                  <li
                    key={s.id}
                    className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
                  >
                    <div>
                      <Link
                        href={`/projects/${s.projectId}/history`}
                        className="font-medium hover:underline"
                      >
                        {s.projectName}
                      </Link>{" "}
                      <span className="text-muted">· Scan #{s.number}</span>
                      <div className="text-xs text-subtle">{formatDateTime(s.createdAt)}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      {s.failedSteps > 0 && (
                        <span className="text-xs text-danger">{s.failedSteps} failed</span>
                      )}
                      <StatusPill tone={scanStatusTone(s.status)}>
                        {scanStatusLabel(s.status)}
                      </StatusPill>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="flex flex-col items-center py-6 text-center">
                <Radar aria-hidden className="mb-2 size-6 text-subtle" />
                <p className="text-sm text-muted">No scans yet.</p>
                <p className="mt-1 text-xs text-subtle">
                  Scans start from a project&apos;s Scan tab once the scan engine is available
                  (Phase 4).
                </p>
              </div>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
