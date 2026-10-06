import { ConfigError, configWarnings, describeConfig, getConfig } from "@qa/core";
import type { Metadata } from "next";
import { connection } from "next/server";
import { Alert } from "@/components/ui/alert";
import { PageHeader } from "@/components/ui/page-header";
import { StatusPill, type PillTone } from "@/components/ui/status-pill";
import { runReadinessChecks } from "@/server/readiness";
import { requirePageUser } from "@/server/session";

export const metadata: Metadata = { title: "Settings" };

function tone(status: string): PillTone {
  if (status === "ok") return "success";
  if (status === "error") return "danger";
  return "neutral";
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border-b border-border px-4 py-3 last:border-b-0 sm:flex-row sm:items-center sm:justify-between">
      <dt className="text-sm font-medium">{label}</dt>
      <dd className="text-sm text-muted sm:text-right">{children}</dd>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  const id = `card-${title.toLowerCase().replace(/\W+/g, "-")}`;
  return (
    <section aria-labelledby={id} className="rounded-lg border border-border bg-surface">
      <h2 id={id} className="border-b border-border px-4 py-3 text-sm font-semibold">
        {title}
      </h2>
      <dl>{children}</dl>
    </section>
  );
}

export default async function SettingsPage() {
  await connection(); // Always render at request time: these are live checks.
  const user = await requirePageUser();
  const report = await runReadinessChecks({ includeDetails: true });
  const { config, database, storage, migrations } = report.checks;

  let summary: ReturnType<typeof describeConfig> | undefined;
  let warnings: string[] = [];
  try {
    summary = describeConfig(getConfig());
    warnings = configWarnings(getConfig());
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
  }

  return (
    <>
      <PageHeader
        title="Settings"
        description="Account, system status and configuration. Secrets are never displayed."
      />
      {warnings.length > 0 && (
        <section aria-labelledby="production-checks" className="mb-6 space-y-2">
          <h2 id="production-checks" className="text-sm font-semibold">
            Production configuration checks
          </h2>
          {warnings.map((w) => (
            <Alert key={w} tone="info">
              {w}
            </Alert>
          ))}
        </section>
      )}
      <div className="grid gap-6 xl:grid-cols-2">
        <Card title="Account">
          <Row label="Name">{user.name}</Row>
          <Row label="Email">{user.email}</Row>
        </Card>
        <Card title="System status">
          <Row label="Overall">
            <StatusPill tone={report.status === "ready" ? "success" : "danger"}>
              {report.status === "ready" ? "Ready" : "Not ready"}
            </StatusPill>
          </Row>
          <Row label="Configuration">
            <span className="flex flex-col items-start gap-1 sm:items-end">
              <StatusPill tone={tone(config.status)}>{config.status}</StatusPill>
              {config.status === "error" && config.invalidVariables && (
                <span>Invalid or missing: {config.invalidVariables.join(", ")}</span>
              )}
            </span>
          </Row>
          <Row label="PostgreSQL">
            <span className="flex flex-col items-start gap-1 sm:items-end">
              <StatusPill tone={tone(database.status)}>{database.status}</StatusPill>
              {database.status === "ok" && (
                <span>
                  v{database.serverVersion} · database “{database.database}” · {database.latencyMs}{" "}
                  ms
                </span>
              )}
              {database.status === "error" && (
                <span>
                  {database.message} ({database.code})
                </span>
              )}
              {database.status === "skipped" && <span>{database.reason}</span>}
            </span>
          </Row>
          <Row label="Storage">
            <span className="flex flex-col items-start gap-1 sm:items-end">
              <StatusPill tone={tone(storage.status)}>{storage.status}</StatusPill>
              {storage.status === "ok" && <span className="break-all">{storage.path}</span>}
              {storage.status === "error" && <span>{storage.message}</span>}
              {storage.status === "skipped" && <span>{storage.reason}</span>}
            </span>
          </Row>
          <Row label="Database migrations">
            <span className="flex flex-col items-start gap-1 sm:items-end">
              <StatusPill tone={tone(migrations.status)}>{migrations.status}</StatusPill>
              {migrations.status === "ok" && (
                <span>
                  {migrations.applied} of {migrations.expected} applied
                </span>
              )}
              {migrations.status === "error" && <span>{migrations.message}</span>}
              {migrations.status === "skipped" && <span>{migrations.reason}</span>}
            </span>
          </Row>
          <Row label="Checked at">
            <time dateTime={report.checkedAt}>{report.checkedAt}</time>
          </Row>
        </Card>

        <Card title="Integrations and limits">
          {summary ? (
            <>
              <Row label="AI provider">
                {summary.aiConfigured
                  ? `${summary.aiProvider} · ${summary.aiModel}${summary.aiEffort ? ` · effort ${summary.aiEffort}` : ""}${summary.aiRefusalFallback ? " · refusal fallback on" : ""}`
                  : "Not configured (issues use the scanners' wording)"}
              </Row>
              <Row label="Figma API">
                {summary.figmaConfigured
                  ? "Token configured"
                  : "Not configured (manual design input available)"}
              </Row>
              <Row label="New account sign-up">
                {summary.signupEnabled ? "Enabled" : "Disabled"}
              </Row>
              <Row label="Encryption key">
                {summary.encryptionKeyConfigured ? "Configured" : "Missing"}
              </Row>
              <Row label="Crawl limits">
                {summary.scanLimits.maxPages} pages · depth {summary.scanLimits.maxDepth} ·{" "}
                {summary.scanLimits.concurrency} concurrent
              </Row>
              <Row label="Environment">{summary.nodeEnv}</Row>
            </>
          ) : (
            <Row label="Configuration">
              Unavailable until the environment configuration is valid.
            </Row>
          )}
        </Card>
      </div>
    </>
  );
}
