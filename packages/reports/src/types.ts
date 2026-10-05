/**
 * Report data model. A report is a snapshot of what is stored for one scan: the scan's
 * configuration and pipeline steps (including failed, inconclusive and skipped ones), its issues
 * with their current tracking status, and the scanner findings each issue is built from.
 * Nothing in a report is computed by AI or invented: every value comes from database rows.
 */

export type Severity = "critical" | "high" | "medium" | "low" | "info";
export type Verdict = "confirmed" | "potential" | "inconclusive" | "unable_to_verify";

/** Raw rows read from the database for one scan (input of `buildReportData`). */
export interface ReportSource {
  project: { id: string; name: string; websiteUrl: string };
  scan: {
    id: string;
    number: number;
    status: string;
    createdAt: Date;
    startedAt: Date | null;
    finishedAt: Date | null;
    error: string | null;
    configSnapshot: Record<string, unknown>;
    technology: Record<string, unknown> | null;
  };
  pageCount: number;
  steps: Array<{
    stepKey: string;
    status: string;
    statusReason: string | null;
    error: string | null;
    findingCount: number;
    durationMs: number | null;
    toolName: string | null;
    toolVersion: string | null;
    checks: Record<string, unknown> | null;
  }>;
  issues: Array<{
    trackId: string;
    displayNo: number;
    trackStatus: string;
    category: string;
    subcategory: string | null;
    ruleId: string | null;
    severity: Severity;
    severityRationale: string | null;
    title: string;
    description: string;
    affectedUrls: string[];
    affectedElement: string | null;
    expected: string | null;
    actual: string | null;
    recommendation: string | null;
    confidence: number;
    verdict: Verdict;
    origin: "ai" | "deterministic";
    groundingStatus: string;
    checks: Array<{ checkType: string; passed: boolean; detail: Record<string, unknown> }>;
    findingIds: string[];
  }>;
  findings: Array<{
    id: string;
    displayId: string;
    scanner: string;
    ruleId: string;
    title: string;
    message: string;
    severity: Severity;
    verdict: Verdict;
    confidence: number;
    pageUrl: string | null;
    selector: string | null;
    viewport: string | null;
    expected: string | null;
    actual: string | null;
    evidence: Array<{ kind: string; data: Record<string, unknown>; storageKey: string | null }>;
  }>;
  aiRuns: Array<{
    provider: string;
    model: string;
    status: string;
    inputTokens: number | null;
    outputTokens: number | null;
  }>;
}

export interface ReportFinding {
  id: string;
  title: string;
  message: string;
  scanner: string;
  ruleId: string;
  severity: Severity;
  verdict: Verdict;
  confidence: number;
  pageUrl: string | null;
  selector: string | null;
  viewport: string | null;
  expected: string | null;
  actual: string | null;
  /** Evidence as stored by the scanner. Stored files (screenshots) are referenced, not embedded. */
  evidence: Array<{ kind: string; data: Record<string, unknown>; hasStoredFile: boolean }>;
}

export interface ReportIssue {
  /** Stable tracking id, e.g. ISSUE-12. */
  id: string;
  /** Tracking status when the report was generated (open, in progress, resolved, ...). */
  status: string;
  severity: Severity;
  category: string;
  categoryLabel: string;
  ruleId: string | null;
  title: string;
  description: string;
  verdict: Verdict;
  confidence: number;
  affectedUrls: string[];
  affectedElement: string | null;
  expected: string | null;
  actual: string | null;
  recommendation: string | null;
  severityRationale: string | null;
  /** Who wrote the text: the scanners/rule catalog, or AI text that passed evidence validation. */
  textOrigin: "ai" | "deterministic";
  grounding: string;
  groundingChecks: Array<{ checkType: string; passed: boolean; detail: Record<string, unknown> }>;
  findings: ReportFinding[];
}

export interface ReportStep {
  key: string;
  label: string;
  status: string;
  statusReason: string | null;
  error: string | null;
  findingCount: number;
  durationMs: number | null;
  tool: string | null;
  evaluated: number | null;
  inconclusiveChecks: Array<{ check: string; reason: string; pageUrl: string | null }>;
  /** Total inconclusive checks (the stored list is capped). */
  inconclusiveTotal: number;
  notes: string[];
  /** Design/content comparisons: how many reference values matched, mismatched, could not be verified. */
  comparison: {
    matched: number;
    confirmedMismatch: number;
    potentialMismatch: number;
    unableToVerify: number;
  } | null;
}

export type CountMap = Record<string, number>;

export interface ReportData {
  format: "qa-copilot-report";
  schemaVersion: 1;
  generatedAt: string;
  generator: { name: string; version: string };
  project: { id: string; name: string; websiteUrl: string };
  scan: {
    id: string;
    number: number;
    status: string;
    statusLabel: string;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    durationMs: number | null;
    error: string | null;
    websiteUrl: string;
    pagesCrawled: number;
    viewports: Array<{ name: string; width: number; height: number }>;
    maxPages: number | null;
    maxDepth: number | null;
    respectRobots: boolean | null;
    scanners: string[];
    siteCredentials: string | null;
    designReferenceVersion: number | null;
    contentDocuments: string[];
    technology: string | null;
  };
  summary: {
    issues: {
      total: number;
      /** Open, in progress or reopened. */
      outstanding: number;
      bySeverity: CountMap;
      byStatus: CountMap;
      byCategory: CountMap;
      byVerdict: CountMap;
    };
    findings: { total: number; byVerdict: CountMap; notInAnyIssue: number };
    steps: {
      failed: string[];
      inconclusive: string[];
      skipped: string[];
    };
    ai: {
      used: boolean;
      requests: number;
      failedRequests: number;
      models: string[];
      issuesWithAiText: number;
      groundingOutcomes: CountMap;
    };
  };
  steps: ReportStep[];
  issues: ReportIssue[];
  /** Findings that are not part of any issue (only scans run before issues were created). */
  unassignedFindings: ReportFinding[];
}
