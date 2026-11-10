import { SCANNER_KEYS, SCANNER_LABELS, stepLabel } from "@qa/core";
import { contentRepo, designSpecsRepo, getDb, referencesRepo, scansRepo } from "@qa/db";
import { CheckCircle2, CircleDashed } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { StepStatus } from "@/components/ui/badges";
import { InfoTip } from "@/components/ui/info-tip";
import { Card } from "@/components/ui/stat";
import { formatDateTime } from "@/lib/format";
import { referencesNotReady } from "@/lib/scan-readiness";
import { loadProjectForPage } from "@/server/loaders";
import { StartScan } from "./start-scan";

export const metadata: Metadata = { title: "Scan" };

function Check({ ok, label, detail }: { ok: boolean; label: string; detail: React.ReactNode }) {
  const Icon = ok ? CheckCircle2 : CircleDashed;
  return (
    <li className="flex items-start gap-3 py-2">
      <Icon
        aria-hidden
        className={ok ? "mt-0.5 size-4 text-success" : "mt-0.5 size-4 text-subtle"}
      />
      <div className="min-w-0 text-sm">
        <div className="font-medium">
          {label} <span className="sr-only">{ok ? "(ready)" : "(not provided)"}</span>
        </div>
        <div className="break-words text-muted">{detail}</div>
      </div>
    </li>
  );
}

export default async function ProjectScanPage({ params }: { params: Promise<{ id: string }> }) {
  const { user, project } = await loadProjectForPage((await params).id);
  const db = getDb();
  const [references, specState, docCounts, latest] = await Promise.all([
    referencesRepo.listReferenceSources(db, project.id),
    designSpecsRepo.getDesignSpecState(db, project.id),
    contentRepo.documentStatusCounts(db, project.id),
    scansRepo.getLatestScan(db, user.id, project.id),
  ]);
  const referencesHref = `/projects/${project.id}/references`;
  const processingRefs = references.filter((r) =>
    ["pending", "processing"].includes(r.status),
  ).length;
  const parsedDocs = docCounts.parsed ?? 0;
  const waitingDocs = (docCounts.pending ?? 0) + (docCounts.parsing ?? 0);
  const failedDocs = docCounts.failed ?? 0;
  const active = latest && ["queued", "running"].includes(latest.status) ? latest : null;
  const d = project.scanDefaults;
  const settingsHref = `/projects/${project.id}/settings`;

  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_22rem]">
      <div className="min-w-0 space-y-6">
        <Card title="Scan readiness">
          <ul className="divide-y divide-border">
            <Check ok label="Website" detail={project.websiteUrl} />
            <Check
              ok={Boolean(specState.active)}
              label="Design reference"
              detail={
                <>
                  {specState.active
                    ? `Version ${specState.active.version} is confirmed; scans compare typography, colors and buttons against it.`
                    : "No confirmed design reference. The design comparison is skipped and reported as “Unable to verify”."}
                  {specState.draft && " A draft with extracted values is waiting for review."}
                  {processingRefs > 0 &&
                    ` ${processingRefs} source(s) are still being processed.`}{" "}
                  <Link href={referencesHref} className="text-primary underline">
                    Manage references
                  </Link>
                </>
              }
            />
            <Check
              ok={parsedDocs > 0}
              label="Approved content"
              detail={
                <>
                  {parsedDocs
                    ? `${parsedDocs} document${parsedDocs === 1 ? "" : "s"} ready for the content comparison.`
                    : "No processed content documents. The content comparison is skipped and reported as “Unable to verify”."}
                  {waitingDocs > 0 &&
                    ` ${waitingDocs} still processing (not included until parsed).`}
                  {failedDocs > 0 && ` ${failedDocs} failed to process.`}{" "}
                  <Link href={referencesHref} className="text-primary underline">
                    Manage content
                  </Link>
                </>
              }
            />
            <Check
              ok={d.scanners.length > 0}
              label="Scanners"
              detail={`${d.scanners.length} of ${SCANNER_KEYS.length} enabled: ${d.scanners.map((s) => SCANNER_LABELS[s]).join(", ")}`}
            />
          </ul>
        </Card>

        <Card
          title="Latest scan"
          action={
            latest && (
              <Link
                href={`/projects/${project.id}/scanners`}
                className="text-sm text-primary hover:underline"
              >
                Scanner results
              </Link>
            )
          }
        >
          {latest ? (
            <>
              <p className="mb-2 text-sm text-muted">
                <Link
                  href={`/projects/${project.id}/scans/${latest.id}`}
                  className="font-medium text-primary hover:underline"
                >
                  Scan #{latest.number}
                </Link>{" "}
                · {formatDateTime(latest.createdAt)}
              </p>
              <ul className="divide-y divide-border">
                {latest.runs.map((r) => (
                  <li key={r.id} className="flex items-center justify-between py-2 text-sm">
                    <span>{stepLabel(r.stepKey)}</span>
                    <StepStatus status={r.status} />
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-sm text-muted">This project has not been scanned yet.</p>
          )}
        </Card>
      </div>

      <aside className="min-w-0 space-y-4">
        <Card
          title="Configuration"
          action={
            <Link href={settingsHref} className="text-sm text-primary hover:underline">
              Edit
            </Link>
          }
        >
          <dl className="space-y-2 text-sm">
            <div>
              <dt className="text-muted">Viewports</dt>
              <dd>{d.viewports.map((v) => `${v.name} ${v.width}×${v.height}`).join(", ")}</dd>
            </div>
            <div>
              <dt className="text-muted">Crawl limits</dt>
              <dd>
                {d.maxPages} pages, depth {d.maxDepth}
              </dd>
            </div>
            <div>
              <dt className="text-muted">robots.txt</dt>
              <dd>{d.respectRobots ? "Respected" : "Ignored"}</dd>
            </div>
          </dl>
        </Card>
        <div className="rounded-lg border border-border bg-surface p-4">
          {active ? (
            <div className="space-y-2 text-sm">
              <p>
                Scan #{active.number} is {active.status === "queued" ? "queued" : "running"}.
              </p>
              <Link
                href={`/projects/${project.id}/scans/${active.id}`}
                className="font-medium text-primary hover:underline"
              >
                View live progress
              </Link>
            </div>
          ) : (
            <StartScan
              projectId={project.id}
              websiteUrl={project.websiteUrl}
              notReady={referencesNotReady({
                designConfirmed: Boolean(specState.active),
                designDraft: Boolean(specState.draft),
                designProcessing: processingRefs,
                documentsProcessing: waitingDocs,
              })}
            />
          )}
          <p className="mt-3 flex items-start gap-1 text-xs text-muted">
            Runs the enabled scanners, then compares the site with the confirmed design reference
            and approved content when they exist.
            <InfoTip label="What does a scan do?">
              The scan checks the site is reachable, crawls pages within your limits, captures each
              page at every viewport, runs the QA scanners and the reference comparisons. Steps that
              cannot run (for example AI analysis, added later) are marked as skipped with the
              reason, never as completed.
            </InfoTip>
          </p>
        </div>
      </aside>
    </div>
  );
}
