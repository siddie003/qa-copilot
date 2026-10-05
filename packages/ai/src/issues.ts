import { deterministicIssue, withVerdictWording } from "./deterministic";
import { groundAiIssue } from "./grounding";
import { groupFacts, groupFindings } from "./grouping";
import type { BatchResult } from "./interpret";
import type { PreparedGroup } from "./prompt";
import type { AiIssue } from "./schema";
import type {
  GroundingCheck,
  GroundingStatus,
  IssueDraft,
  IssueOrigin,
  ScanFinding,
} from "./types";

/** Groups a scan's findings and computes each group's facts and deterministic wording. */
export function prepareGroups(findings: ScanFinding[]): PreparedGroup[] {
  return groupFindings(findings).map((group) => {
    const facts = groupFacts(group);
    return { group, facts, deterministic: deterministicIssue(group, facts) };
  });
}

export interface DraftStats {
  issues: number;
  findings: number;
  ai: number;
  passed: number;
  partial: number;
  rejected: number;
  deterministic: number;
  /** Groups whose batch succeeded but whose AI output was missing. */
  missing: number;
  /** AI entries discarded because their group id was unknown or repeated. */
  discarded: number;
  checksPassed: number;
  checksFailed: number;
}

export interface DraftOptions {
  prepared: PreparedGroup[];
  /** AI batch results (empty when no provider is configured). */
  batches: BatchResult[];
  /** Reference data design issues may cite (the scan's frozen design spec). */
  designReference?: unknown;
}

function mostCommon(values: Array<string | null>): string | null {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/**
 * One issue per group, in group order. AI text is used only where grounding accepts it; every
 * other group (no provider, failed batch, missing or rejected output) keeps the deterministic
 * wording. Every finding ends up in exactly one issue.
 */
export function buildIssueDrafts(opts: DraftOptions): { drafts: IssueDraft[]; stats: DraftStats } {
  const scanFindingIds = new Set(
    opts.prepared.flatMap((p) => p.group.findings.map((f) => f.displayId)),
  );
  const batchOf = new Map<string, BatchResult>();
  const aiOf = new Map<string, AiIssue>();
  let discarded = 0;
  for (const b of opts.batches) {
    for (const id of b.groupIds) batchOf.set(id, b);
    if (b.status !== "completed") continue;
    const ids = new Set(b.groupIds);
    for (const issue of b.issues) {
      const id = issue.groupId.trim();
      if (!ids.has(id) || aiOf.has(id)) discarded += 1;
      else aiOf.set(id, issue);
    }
  }
  const stats: DraftStats = {
    issues: opts.prepared.length,
    findings: scanFindingIds.size,
    ai: 0,
    passed: 0,
    partial: 0,
    rejected: 0,
    deterministic: 0,
    missing: 0,
    discarded,
    checksPassed: 0,
    checksFailed: 0,
  };

  const drafts = opts.prepared.map((p): IssueDraft => {
    const { group: g, facts, deterministic: det } = p;
    const batch = batchOf.get(g.id) ?? null;
    const ai = aiOf.get(g.id);
    let origin: IssueOrigin = "deterministic";
    let groundingStatus: GroundingStatus = "not_applicable";
    let fields = { ...det, description: withVerdictWording(det.description, facts.verdict) };
    let checks: GroundingCheck[] = [];
    if (ai) {
      const r = groundAiIssue(ai, {
        prepared: p,
        scanFindingIds,
        referenceValues:
          g.category === "design" && opts.designReference ? [opts.designReference] : [],
      });
      ({ origin, fields, checks } = r);
      groundingStatus = r.status;
    } else if (batch) {
      if (batch.status === "completed") stats.missing += 1;
      // Recorded on the issue so it explains why the text is the scanner's wording.
      checks = [
        {
          checkType: "ai_output",
          passed: false,
          detail:
            batch.status === "completed"
              ? { reason: "The AI response did not include this issue" }
              : {
                  reason: batch.error?.message ?? "The AI request failed",
                  code: batch.error?.code,
                },
        },
      ];
    }
    if (origin === "ai") stats.ai += 1;
    else stats.deterministic += 1;
    if (groundingStatus === "passed") stats.passed += 1;
    if (groundingStatus === "partial") stats.partial += 1;
    if (groundingStatus === "rejected") stats.rejected += 1;
    for (const c of checks) {
      if (c.checkType === "ai_output") continue;
      if (c.passed) stats.checksPassed += 1;
      else stats.checksFailed += 1;
    }
    return {
      ...fields,
      groupId: g.id,
      fingerprint: g.fingerprint,
      category: g.category,
      ruleId: g.ruleId,
      subcategory: mostCommon(g.findings.map((f) => f.subcategory)),
      findingIds: g.findings.map((f) => f.id),
      confidence: facts.confidence,
      verdict: facts.verdict,
      status: facts.verdict === "inconclusive" ? "inconclusive" : "open",
      origin,
      groundingStatus,
      batchIndex: batch && batch.status !== "skipped" ? batch.index : null,
      checks,
    };
  });
  return { drafts, stats };
}
