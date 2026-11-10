import type { Severity } from "@qa/core";
import type { AiExplanation } from "@qa/core/fix-guide";

export type FindingVerdict = "confirmed" | "potential" | "inconclusive" | "unable_to_verify";

/** Verdict of an issue: the strongest verdict among its findings. */
export type IssueVerdict = "confirmed" | "potential" | "inconclusive";

/** A stored raw finding as the interpretation step reads it. Never modified by this package. */
export interface ScanFinding {
  id: string;
  /** Human-readable id unique within the scan, e.g. SEO-004. */
  displayId: string;
  scanner: string;
  ruleId: string;
  subcategory: string | null;
  title: string;
  message: string;
  severity: Severity;
  verdict: FindingVerdict;
  confidence: number;
  selector: string | null;
  viewport: string | null;
  expected: string | null;
  actual: string | null;
  fingerprint: string;
  /** URL of the page the finding belongs to (null for site-wide findings). */
  pageUrl: string | null;
  evidence: Array<{ kind: string; data: Record<string, unknown> }>;
}

/**
 * Findings that become one issue. Groups are formed deterministically, so an issue's identity
 * (its fingerprint, tracked across scans) never depends on AI output.
 */
export interface IssueGroup {
  /** Short id used in AI prompts ("G3"); unique within one scan. */
  id: string;
  /** Stable identity across scans: the issue_track fingerprint. */
  fingerprint: string;
  /** Readable form of the identity, e.g. "seo/meta-description-missing". */
  key: string;
  category: string;
  ruleId: string;
  findings: ScanFinding[];
}

/** Values computed from a group's findings (also given to the AI, so it may cite them). */
export interface GroupFacts {
  findingCount: number;
  pageCount: number;
  elementCount: number;
  pages: string[];
  viewports: string[];
  selectors: string[];
  severity: Severity;
  verdict: IssueVerdict;
  verdictCounts: Partial<Record<FindingVerdict, number>>;
  hasConfirmed: boolean;
  confidence: number;
  /** Severities the AI may choose: within one level of the scanners' severity, never higher for unconfirmed findings. */
  allowedSeverities: Severity[];
}

/** The text and values of an issue (deterministic, AI-written or a mix after grounding). */
export interface IssueFields {
  title: string;
  description: string;
  severity: Severity;
  severityRationale: string;
  affectedUrls: string[];
  affectedElement: string | null;
  expected: string | null;
  actual: string | null;
  recommendation: string;
  /** AI-written plain-language explanation (grounded parts only); null for the scanners' wording. */
  explanation: AiExplanation | null;
}

export interface GroundingCheck {
  checkType: string;
  passed: boolean;
  detail: Record<string, unknown>;
}

export type IssueOrigin = "ai" | "deterministic";
export type GroundingStatus = "passed" | "partial" | "rejected" | "not_applicable";

/** Everything needed to store one issue occurrence. */
export interface IssueDraft extends IssueFields {
  groupId: string;
  fingerprint: string;
  category: string;
  ruleId: string;
  subcategory: string | null;
  findingIds: string[];
  confidence: number;
  verdict: IssueVerdict;
  /** Tracked status for new tracks: inconclusive when no finding could be verified. */
  status: "open" | "inconclusive";
  origin: IssueOrigin;
  groundingStatus: GroundingStatus;
  /** Index of the AI batch that covered this group (links the issue to its ai_run). */
  batchIndex: number | null;
  checks: GroundingCheck[];
}
