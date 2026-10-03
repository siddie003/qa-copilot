import { SCANNER_LABELS, SEVERITIES } from "@qa/core";
import type { Metadata } from "next";
import { StatusPill } from "@/components/ui/status-pill";
import { formatDateTime, scanStatusLabel } from "@/lib/format";
import { loadProjectForPage } from "@/server/loaders";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { project } = await loadProjectForPage((await params).id);
  return { title: project.name };
}

const SEVERITY_LABEL: Record<(typeof SEVERITIES)[number], string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  info: "Informational",
};

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-4 py-3">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

export default async function ProjectOverviewPage({ params }: Props) {
  const { project } = await loadProjectForPage((await params).id);
  const c = project.issueCounts;
  const d = project.scanDefaults;

  return (
    <div className="space-y-6">
      <section
        aria-labelledby="scan-heading"
        className="rounded-lg border border-border bg-surface p-4"
      >
        <h2 id="scan-heading" className="text-sm font-semibold">
          Last scan
        </h2>
        {project.lastScan ? (
          <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted">
            Scan #{project.lastScan.number}
            <StatusPill tone="neutral">{scanStatusLabel(project.lastScan.status)}</StatusPill>
            started {formatDateTime(project.lastScan.createdAt)}
          </p>
        ) : (
          <p className="mt-2 text-sm text-muted">
            This project has not been scanned yet. Scanning becomes available once the crawler and
            scanners are implemented (Phases 4–5).
          </p>
        )}
      </section>

      <section aria-labelledby="issues-heading">
        <h2 id="issues-heading" className="mb-2 text-sm font-semibold">
          Issues
        </h2>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Total" value={c.total} />
          <Stat label="Open" value={c.open + c.reopened} />
          <Stat label="In progress" value={c.inProgress} />
          <Stat label="Resolved" value={c.resolved} />
        </dl>
        <h3 className="mb-2 mt-4 text-xs font-medium uppercase tracking-wide text-muted">
          Outstanding by severity
        </h3>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {SEVERITIES.map((s) => (
            <Stat key={s} label={SEVERITY_LABEL[s]} value={c[s]} />
          ))}
        </dl>
        <p className="mt-2 text-xs text-subtle">
          Counts come from stored scan results. They are zero until a scan has produced findings.
        </p>
      </section>

      <section
        aria-labelledby="config-heading"
        className="rounded-lg border border-border bg-surface p-4"
      >
        <h2 id="config-heading" className="text-sm font-semibold">
          Scan configuration
        </h2>
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted">Scanners</dt>
            <dd>{d.scanners.map((s) => SCANNER_LABELS[s]).join(", ")}</dd>
          </div>
          <div>
            <dt className="text-muted">Viewports</dt>
            <dd>{d.viewports.map((v) => `${v.name} (${v.width}×${v.height})`).join(", ")}</dd>
          </div>
          <div>
            <dt className="text-muted">Crawl limits</dt>
            <dd>
              Up to {d.maxPages} pages, depth {d.maxDepth}
            </dd>
          </div>
          <div>
            <dt className="text-muted">robots.txt</dt>
            <dd>{d.respectRobots ? "Respected" : "Ignored (authorized testing)"}</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
