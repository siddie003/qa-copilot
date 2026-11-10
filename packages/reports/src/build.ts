import { buildIssueGuide } from "@qa/core/fix-guide";
import { FINDING_SOURCE_LABELS, stepLabel } from "@qa/core/domain";
import type {
  CountMap,
  ReportData,
  ReportFinding,
  ReportIssue,
  ReportSource,
  ReportStep,
  Severity,
} from "./types";

export const REPORT_SCHEMA_VERSION = 1 as const;

const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];
const OUTSTANDING = new Set(["open", "in_progress", "reopened"]);

export const SCAN_STATUS_LABELS: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  completed_with_failures: "Completed with failures",
  failed: "Failed",
  cancelled: "Cancelled",
};

export const SEVERITY_LABELS: Record<string, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  info: "Informational",
};

export const STATUS_LABELS: Record<string, string> = {
  open: "Open",
  in_progress: "In progress",
  resolved: "Resolved",
  reopened: "Reopened",
  ignored: "Ignored",
  inconclusive: "Inconclusive",
};

/** Evidence-based verdicts, worded as in the app. */
export const VERDICT_LABELS: Record<string, string> = {
  confirmed: "Confirmed",
  potential: "Needs review (potential)",
  inconclusive: "Unable to verify",
  unable_to_verify: "Unable to verify",
};

/** Pipeline step outcomes, worded as in the app ("Scanner failed" for failed scanners). */
export const STEP_STATUS_LABELS: Record<string, string> = {
  pending: "Not run",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  inconclusive: "Inconclusive",
  skipped: "Skipped",
};

export const GROUNDING_LABELS: Record<string, string> = {
  passed: "AI text, evidence-checked",
  partial: "AI text, unsupported parts replaced with scanner wording",
  rejected: "AI text rejected; scanner wording",
  not_applicable: "Scanner wording",
};

export const categoryLabel = (c: string) => FINDING_SOURCE_LABELS[c] ?? c;

/** Shortens a long value for display, marking the cut with an ellipsis (JSON keeps it whole). */
export const clip = (v: string, max = 240) => (v.length > max ? `${v.slice(0, max - 1)}…` : v);

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (typeof v === "string" ? v : null);

function countBy<T>(items: T[], key: (t: T) => string, order: readonly string[] = []): CountMap {
  const out: CountMap = Object.fromEntries(order.map((k) => [k, 0]));
  for (const i of items) out[key(i)] = (out[key(i)] ?? 0) + 1;
  return out;
}

function toFinding(f: ReportSource["findings"][number]): ReportFinding {
  return {
    id: f.displayId,
    title: f.title,
    message: f.message,
    scanner: f.scanner,
    ruleId: f.ruleId,
    severity: f.severity,
    verdict: f.verdict,
    confidence: f.confidence,
    pageUrl: f.pageUrl,
    selector: f.selector,
    viewport: f.viewport,
    expected: f.expected,
    actual: f.actual,
    evidence: f.evidence.map((e) => ({
      kind: e.kind,
      data: e.data,
      hasStoredFile: Boolean(e.storageKey),
    })),
  };
}

/** The issue page's plain summary and fix guide, for readers of the report. */
function plainLanguage(
  i: ReportSource["issues"][number],
  findings: ReportSource["findings"],
): ReportIssue["plainLanguage"] {
  const g = buildIssueGuide({
    category: i.category,
    ruleId: i.ruleId,
    verdict: i.verdict,
    affectedUrls: i.affectedUrls,
    affectedElement: i.affectedElement,
    recommendation: i.recommendation,
    findings,
    explanation:
      i.groundingStatus === "passed" || i.groundingStatus === "partial"
        ? (i.explanation ?? null)
        : null,
  });
  return {
    problem: g.problem,
    whyItMatters: g.whyItMatters,
    nextAction: g.nextAction,
    steps: g.steps,
    verify: g.verify,
    aiWritten: g.aiParts,
  };
}

function toStep(s: ReportSource["steps"][number]): ReportStep {
  const c = s.checks ?? {};
  const inconclusive = Array.isArray(c.inconclusive)
    ? (c.inconclusive as Array<Record<string, unknown>>).map((i) => ({
        check: String(i.check ?? ""),
        reason: String(i.reason ?? ""),
        pageUrl: str(i.pageUrl),
      }))
    : [];
  const cmp = c.comparison as Record<string, unknown> | undefined;
  return {
    key: s.stepKey,
    label: stepLabel(s.stepKey),
    status: s.status,
    statusReason: s.statusReason,
    error: s.error,
    findingCount: s.findingCount,
    durationMs: s.durationMs,
    tool: s.toolName ? [s.toolName, s.toolVersion].filter(Boolean).join(" ") : null,
    evaluated: num(c.evaluated),
    inconclusiveChecks: inconclusive,
    inconclusiveTotal: num(c.inconclusiveTotal) ?? inconclusive.length,
    notes: Array.isArray(c.notes) ? c.notes.filter((n): n is string => typeof n === "string") : [],
    comparison: cmp
      ? {
          matched: num(cmp.matched) ?? 0,
          confirmedMismatch: num(cmp.confirmedMismatch) ?? 0,
          potentialMismatch: num(cmp.potentialMismatch) ?? 0,
          unableToVerify: num(cmp.unableToVerify) ?? 0,
        }
      : null,
    parts: Array.isArray(c.parts)
      ? (c.parts as Array<Record<string, unknown>>).map((p) => ({
          label: String(p.label ?? p.key ?? ""),
          status: String(p.status ?? ""),
          detail: String(p.detail ?? ""),
        }))
      : [],
  };
}

/** Readable status of one part of a multi-part scanner. */
export const PART_STATUS_LABELS: Record<string, string> = {
  completed: "checked",
  inconclusive: "inconclusive",
  not_configured: "not configured",
  unavailable: "not available",
  failed: "failed",
};

/** Detected site technology, with the HTTP server named separately (as on the scan page). */
function technologySummary(t: Record<string, unknown> | null): string | null {
  const detected = Array.isArray(t?.detected) ? (t.detected as Array<Record<string, unknown>>) : [];
  const names = (server: boolean) =>
    detected
      .filter((d) => (d.category === "server") === server)
      .map((d) => str(d.name))
      .filter((n): n is string => Boolean(n));
  const site = names(false);
  const servers = names(true);
  const parts = [
    site.length ? site.join(", ") : null,
    servers.length ? `server: ${servers.join(", ")}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join("; ") : null;
}

/**
 * Builds the report for one scan from stored rows. Pure and deterministic for a given input and
 * `generatedAt`, so the same data always produces the same report.
 */
export function buildReportData(
  src: ReportSource,
  opts: { generatedAt: Date; generator: { name: string; version: string } },
): ReportData {
  const cfg = src.scan.configSnapshot;
  const findingsById = new Map(src.findings.map((f) => [f.id, f]));
  const assigned = new Set<string>();

  const issues: ReportIssue[] = [...src.issues]
    .sort(
      (a, b) =>
        SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
        a.displayNo - b.displayNo,
    )
    .map((i) => {
      const findings = i.findingIds
        .map((id) => findingsById.get(id))
        .filter((f): f is NonNullable<typeof f> => Boolean(f))
        .sort((a, b) => a.displayId.localeCompare(b.displayId, "en", { numeric: true }));
      for (const f of findings) assigned.add(f.id);
      return {
        id: `ISSUE-${i.displayNo}`,
        status: i.trackStatus,
        severity: i.severity,
        category: i.category,
        categoryLabel: categoryLabel(i.category),
        ruleId: i.ruleId,
        title: i.title,
        description: i.description,
        verdict: i.verdict,
        confidence: i.confidence,
        affectedUrls: i.affectedUrls,
        affectedElement: i.affectedElement,
        expected: i.expected,
        actual: i.actual,
        recommendation: i.recommendation,
        severityRationale: i.severityRationale,
        plainLanguage: plainLanguage(i, findings),
        textOrigin: i.origin,
        grounding: i.groundingStatus,
        groundingChecks: i.checks,
        findings: findings.map(toFinding),
      };
    });

  const unassignedFindings = src.findings
    .filter((f) => !assigned.has(f.id))
    .sort(
      (a, b) =>
        SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
        a.displayId.localeCompare(b.displayId, "en", { numeric: true }),
    )
    .map(toFinding);

  const steps = src.steps.map(toStep);
  const viewports = Array.isArray(cfg.viewports)
    ? (cfg.viewports as Array<Record<string, unknown>>).map((v) => ({
        name: String(v.name ?? ""),
        width: num(v.width) ?? 0,
        height: num(v.height) ?? 0,
      }))
    : [];
  const docs = Array.isArray(cfg.contentDocuments)
    ? (cfg.contentDocuments as Array<Record<string, unknown>>)
        .map((d) => str(d.filename))
        .filter((n): n is string => Boolean(n))
    : [];
  const { startedAt, finishedAt } = src.scan;

  return {
    format: "qa-copilot-report",
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt: opts.generatedAt.toISOString(),
    generator: opts.generator,
    project: src.project,
    scan: {
      id: src.scan.id,
      number: src.scan.number,
      status: src.scan.status,
      statusLabel: SCAN_STATUS_LABELS[src.scan.status] ?? src.scan.status,
      createdAt: src.scan.createdAt.toISOString(),
      startedAt: iso(startedAt),
      finishedAt: iso(finishedAt),
      durationMs: startedAt && finishedAt ? finishedAt.getTime() - startedAt.getTime() : null,
      error: src.scan.error,
      websiteUrl: str(cfg.websiteUrl) ?? src.project.websiteUrl,
      pagesCrawled: src.pageCount,
      viewports,
      maxPages: num(cfg.maxPages),
      maxDepth: num(cfg.maxDepth),
      respectRobots: typeof cfg.respectRobots === "boolean" ? cfg.respectRobots : null,
      scanners: Array.isArray(cfg.scanners) ? cfg.scanners.map(String) : [],
      siteCredentials: str(cfg.authType),
      designReferenceVersion: num(cfg.designSpecVersion),
      contentDocuments: docs,
      technology: technologySummary(src.scan.technology),
    },
    summary: {
      issues: {
        total: issues.length,
        outstanding: issues.filter((i) => OUTSTANDING.has(i.status)).length,
        bySeverity: countBy(issues, (i) => i.severity, SEVERITY_ORDER),
        byStatus: countBy(issues, (i) => i.status),
        byCategory: countBy(issues, (i) => i.category),
        byVerdict: countBy(issues, (i) => i.verdict),
      },
      findings: {
        total: src.findings.length,
        byVerdict: countBy(src.findings, (f) => f.verdict),
        notInAnyIssue: unassignedFindings.length,
      },
      steps: {
        failed: steps.filter((s) => s.status === "failed").map((s) => s.key),
        inconclusive: steps.filter((s) => s.status === "inconclusive").map((s) => s.key),
        skipped: steps.filter((s) => s.status === "skipped").map((s) => s.key),
      },
      ai: {
        used: src.aiRuns.length > 0,
        requests: src.aiRuns.length,
        failedRequests: src.aiRuns.filter((r) => r.status === "failed").length,
        models: [...new Set(src.aiRuns.map((r) => `${r.provider}/${r.model}`))].sort(),
        issuesWithAiText: issues.filter((i) => i.textOrigin === "ai").length,
        groundingOutcomes: countBy(issues, (i) => i.grounding),
      },
    },
    steps,
    issues,
    unassignedFindings,
  };
}
