import { SCANNER_KEYS, SCANNER_LABELS, stepLabel } from "@qa/core";
import { getDb, referencesRepo, scansRepo } from "@qa/db";
import { CheckCircle2, CircleDashed, Play } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { StepStatus } from "@/components/ui/badges";
import { Button } from "@/components/ui/button";
import { InfoTip } from "@/components/ui/info-tip";
import { Card } from "@/components/ui/stat";
import { formatDateTime } from "@/lib/format";
import { loadProjectForPage } from "@/server/loaders";

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
  const [references, contentDocs, latest] = await Promise.all([
    referencesRepo.listReferenceSources(db, project.id),
    referencesRepo.countContentDocuments(db, project.id),
    scansRepo.getLatestScan(db, user.id, project.id),
  ]);
  const d = project.scanDefaults;
  const settingsHref = `/projects/${project.id}/settings`;

  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_22rem]">
      <div className="min-w-0 space-y-6">
        <Card title="Scan readiness">
          <ul className="divide-y divide-border">
            <Check ok label="Website" detail={project.websiteUrl} />
            <Check
              ok={references.length > 0}
              label="Figma / brand reference"
              detail={
                references.length
                  ? `${references.length} reference${references.length === 1 ? "" : "s"} recorded (${references.filter((r) => r.status === "pending").length} not yet processed). Design comparison runs once references are processed (Phase 6).`
                  : "None. Scanning still works; design comparison is reported as “Unable to verify”."
              }
            />
            <Check
              ok={contentDocs > 0}
              label="Approved content"
              detail={
                contentDocs
                  ? `${contentDocs} document${contentDocs === 1 ? "" : "s"} uploaded.`
                  : "None. Content comparison is reported as “Unable to verify”. Uploads arrive in Phase 6."
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
                Scan #{latest.number} · {formatDateTime(latest.createdAt)}
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
          <Button className="w-full" disabled aria-describedby="scan-unavailable">
            <Play aria-hidden className="size-4" />
            Start QA Scan
          </Button>
          <p id="scan-unavailable" className="mt-2 flex items-start gap-1 text-xs text-muted">
            Scanning is not available yet. The crawler, browser automation and scanners are built in
            Phases 4–5.
            <InfoTip label="Why is scanning disabled?">
              The button is disabled rather than simulated: no scan results are shown until real
              scanners have run against the website.
            </InfoTip>
          </p>
        </div>
      </aside>
    </div>
  );
}
