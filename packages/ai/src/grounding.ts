import type { AiExplanation } from "@qa/core/fix-guide";
import { withVerdictWording } from "./deterministic";
import type { PreparedGroup } from "./prompt";
import type { AiIssue, ClaimField } from "./schema";
import type {
  GroundingCheck,
  GroundingStatus,
  IssueFields,
  IssueGroup,
  IssueOrigin,
  ScanFinding,
} from "./types";
import { buildCorpus, countFacts, unsupportedFacts, type Corpus } from "./values";

/**
 * Deterministic grounding validator: decides how much of an AI-written issue may be shown.
 *
 * Hard checks (failure rejects the AI text; the scanner's wording is used):
 *   - source findings: at least one cited, every cited id exists in this scan, belongs to this
 *     issue and has evidence.
 * Soft checks (failure replaces only the offending field with the scanner's wording):
 *   - every number, color, URL, page path, finding id and quoted text in the title, description,
 *     expected, actual, recommendation and severity rationale is supported by the issue's corpus;
 *     length limits;
 *   - severity within one level of the scanners' severity, never raised for unconfirmed findings;
 *   - affected element is one of the findings' selectors;
 *   - each claim is supported by the field of the finding it cites;
 *   - the optional plain-language explanation: problem, impact and next step each pass the same
 *     fact check (else that part falls back to the built-in fix guide); the fix steps are kept
 *     only if every step passes; caveats are kept one by one.
 * Affected URLs and the category are never taken from AI output.
 */

export const GROUNDING_VERSION = "1.0.0";

export const FIELD_LIMITS = {
  title: 160,
  description: 2000,
  recommendation: 2500,
  severityRationale: 600,
  expected: 500,
  actual: 500,
} as const;
const MAX_CLAIMS = 6;
const MAX_CLAIM_LENGTH = 400;

export const EXPLANATION_LIMITS = {
  problem: 400,
  impact: 500,
  nextStep: 400,
  step: 400,
  caveat: 300,
  maxSteps: 8,
  maxCaveats: 4,
} as const;

const STOPWORDS = new Set(
  "this that with from have does when where which their there these those page pages website site element elements finding findings issue value values should would could about other than into more most only also been were they them".split(
    " ",
  ),
);

export interface GroundingResult {
  origin: IssueOrigin;
  status: GroundingStatus;
  fields: IssueFields;
  checks: GroundingCheck[];
}

export interface GroundingContext {
  prepared: PreparedGroup;
  /** Display ids of every finding in the scan (tells "fabricated" from "another issue's"). */
  scanFindingIds: ReadonlySet<string>;
  /** Additional reference data the text may cite (the scan's design reference for design issues). */
  referenceValues?: unknown[];
}

/** Readable WCAG references for axe tags ("wcag143" → "1.4.3", "wcag21aa" → "WCAG 2.1 AA"). */
export function wcagReferences(g: IssueGroup): string[] {
  const out = new Set<string>();
  for (const f of g.findings)
    for (const e of f.evidence) {
      const tags = e.data.wcag;
      if (!Array.isArray(tags)) continue;
      for (const tag of tags) {
        if (typeof tag !== "string") continue;
        const sc = /^wcag(\d)(\d)(\d{1,2})$/.exec(tag);
        if (sc) out.add(`WCAG ${sc[1]}.${sc[2]}.${sc[3]}`);
        const version = /^wcag(\d)(\d?)(a{1,3})$/i.exec(tag);
        if (version)
          out.add(`WCAG ${version[1]}.${version[2] || "0"} ${version[3]!.toUpperCase()}`);
      }
    }
  return [...out];
}

function findingFacts(f: ScanFinding) {
  return {
    id: f.displayId,
    scanner: f.scanner,
    ruleId: f.ruleId,
    subcategory: f.subcategory,
    title: f.title,
    message: f.message,
    selector: f.selector,
    viewport: f.viewport,
    expected: f.expected,
    actual: f.actual,
    pageUrl: f.pageUrl,
    evidence: f.evidence.map((e) => e.data),
  };
}

/** Everything an issue's text may be grounded in: the data the AI was given, unabridged. */
export function issueCorpus(p: PreparedGroup, referenceValues: unknown[] = []): Corpus {
  const { group: g, facts } = p;
  return buildCorpus(
    [
      g.findings.map(findingFacts),
      {
        findingCount: facts.findingCount,
        pageCount: facts.pageCount,
        elementCount: facts.elementCount,
        pages: facts.pages,
        viewports: facts.viewports,
      },
      p.deterministic.recommendation,
      wcagReferences(g),
      // The accessibility scanner tests against WCAG 2.2 A/AA (scan scope, not a finding).
      g.category === "accessibility" ? "WCAG 2.2 A/AA" : null,
      referenceValues,
      // Approved sections shown to the AI for content issues (it may quote them).
      p.context?.approvedSections ?? null,
    ],
    g.findings.map((f) => f.displayId),
  );
}

function claimFieldValue(f: ScanFinding, field: ClaimField): unknown {
  if (field === "evidence") return f.evidence.length ? f.evidence.map((e) => e.data) : null;
  const v = f[field];
  return typeof v === "string" && v.trim() ? v : null;
}

const significantWords = (text: string) =>
  (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}-]{3,}/gu) ?? []).filter(
    (w) => !STOPWORDS.has(w),
  );

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

type TextField = "title" | "description" | "recommendation" | "severityRationale";

export function groundAiIssue(ai: AiIssue, ctx: GroundingContext): GroundingResult {
  const { group: g, facts, deterministic: det } = ctx.prepared;
  const issueIds = new Set(g.findings.map((f) => f.displayId));
  const byId = new Map(g.findings.map((f) => [f.displayId, f]));
  const checks: GroundingCheck[] = [];
  const fallback = { ...det, description: withVerdictWording(det.description, facts.verdict) };

  // Hard check: the AI text must be based on real findings of this issue.
  const cited = [...new Set(ai.sourceFindingIds.map((s) => s.trim()).filter(Boolean))];
  const unknown = cited.filter((id) => !ctx.scanFindingIds.has(id));
  const otherIssue = cited.filter((id) => ctx.scanFindingIds.has(id) && !issueIds.has(id));
  const withoutEvidence = cited.filter((id) => byId.get(id)?.evidence.length === 0);
  const sourcesOk =
    cited.length > 0 && !unknown.length && !otherIssue.length && !withoutEvidence.length;
  checks.push({
    checkType: "source_findings",
    passed: sourcesOk,
    detail: {
      cited,
      issueFindings: g.findings.length,
      ...(unknown.length ? { unknown } : {}),
      ...(otherIssue.length ? { otherIssue } : {}),
      ...(withoutEvidence.length ? { withoutEvidence } : {}),
      ...(cited.length ? {} : { reason: "no source findings cited" }),
    },
  });
  if (!sourcesOk) return { origin: "deterministic", status: "rejected", fields: fallback, checks };

  const corpus = issueCorpus(ctx.prepared, ctx.referenceValues);
  const fields: IssueFields = { ...fallback };
  const failedFields = new Set<string>();

  const checkText = (
    field: TextField | "expected" | "actual",
    value: string,
    limit: number,
  ): boolean => {
    const text = value.trim();
    const reason = !text ? "empty" : text.length > limit ? `longer than ${limit} characters` : null;
    const unsupported = reason ? [] : unsupportedFacts(text, corpus);
    const passed = !reason && unsupported.length === 0;
    checks.push({
      checkType: `field:${field}`,
      passed,
      detail: {
        checkedFacts: reason ? 0 : countFacts(text),
        ...(unsupported.length ? { unsupported: unsupported.slice(0, 20) } : {}),
        ...(reason ? { reason } : {}),
        ...(passed ? {} : { replacedWith: "scanner wording" }),
      },
    });
    if (passed) fields[field] = text;
    else failedFields.add(field);
    return passed;
  };

  checkText("title", ai.title, FIELD_LIMITS.title);
  checkText("description", ai.description, FIELD_LIMITS.description);
  checkText("recommendation", ai.recommendation, FIELD_LIMITS.recommendation);

  // Optional plain-language explanation: grounded part by part.
  const assess = (value: string, limit: number) => {
    const text = value.trim();
    const reason = !text ? "empty" : text.length > limit ? `longer than ${limit} characters` : null;
    const unsupported = reason ? [] : unsupportedFacts(text, corpus);
    return { text, reason, unsupported, passed: !reason && unsupported.length === 0 };
  };
  const x = ai.explanation ?? null;
  if (x) {
    const out: AiExplanation = {};
    for (const key of ["problem", "impact", "nextStep"] as const) {
      const r = assess(x[key], EXPLANATION_LIMITS[key]);
      checks.push({
        checkType: `field:explanation.${key}`,
        passed: r.passed,
        detail: {
          checkedFacts: r.reason ? 0 : countFacts(r.text),
          ...(r.unsupported.length ? { unsupported: r.unsupported.slice(0, 20) } : {}),
          ...(r.reason ? { reason: r.reason } : {}),
          ...(r.passed ? {} : { replacedWith: "built-in fix guide" }),
        },
      });
      if (r.passed) out[key] = r.text;
    }
    const lists = [
      ["steps", x.steps, EXPLANATION_LIMITS.step, EXPLANATION_LIMITS.maxSteps, true],
      ["caveats", x.caveats, EXPLANATION_LIMITS.caveat, EXPLANATION_LIMITS.maxCaveats, false],
    ] as const;
    for (const [key, items, limit, max, allOrNothing] of lists) {
      const results = items
        .filter((s) => s.trim())
        .slice(0, max)
        .map((s) => assess(s, limit));
      if (!results.length) continue;
      const bad = results.filter((r) => !r.passed);
      const kept = allOrNothing && bad.length ? [] : results.filter((r) => r.passed);
      checks.push({
        checkType: `field:explanation.${key}`,
        passed: bad.length === 0,
        detail: {
          items: results.length,
          ...(items.length > max ? { received: items.length } : {}),
          ...(bad.length
            ? {
                failedItems: bad.length,
                unsupported: bad.flatMap((r) => r.unsupported).slice(0, 20),
                reasons: [...new Set(bad.map((r) => r.reason).filter(Boolean))],
                replacedWith: kept.length ? "supported items only" : "built-in fix guide",
              }
            : {}),
        },
      });
      if (kept.length) out[key] = kept.map((r) => r.text);
    }
    fields.explanation = Object.keys(out).length ? out : null;
  }
  for (const field of ["expected", "actual"] as const) {
    const v = ai[field];
    // null means "differs between findings": the scanner's value (if any) is kept.
    if (v !== null && v.trim()) checkText(field, v, FIELD_LIMITS[field]);
  }

  const severityOk = facts.allowedSeverities.includes(ai.severity);
  checks.push({
    checkType: "severity",
    passed: severityOk,
    detail: {
      scannerSeverity: facts.severity,
      aiSeverity: ai.severity,
      allowed: facts.allowedSeverities,
      unconfirmedOnly: !facts.hasConfirmed,
      ...(severityOk ? {} : { replacedWith: facts.severity }),
    },
  });
  if (severityOk) {
    fields.severity = ai.severity;
    // The rationale only stands with the severity it justifies.
    checkText("severityRationale", ai.severityRationale, FIELD_LIMITS.severityRationale);
  } else failedFields.add("severity");

  if (ai.affectedElement !== null && ai.affectedElement.trim()) {
    const wanted = collapse(ai.affectedElement);
    const match = facts.selectors.find((s) => collapse(s) === wanted);
    checks.push({
      checkType: "affected_element",
      passed: Boolean(match),
      detail: {
        value: ai.affectedElement.slice(0, 300),
        knownElements: facts.selectors.length,
        ...(match ? {} : { replacedWith: det.affectedElement ? "scanner value" : "none" }),
      },
    });
    if (match) fields.affectedElement = match;
    else failedFields.add("affectedElement");
  }

  for (const c of ai.claims.slice(0, MAX_CLAIMS)) {
    const id = c.findingId.trim();
    const f = byId.get(id);
    const value = f ? claimFieldValue(f, c.evidenceField) : null;
    const text = c.text.trim();
    let unsupported: string[] = [];
    let reason: string | null = null;
    if (!text || text.length > MAX_CLAIM_LENGTH) reason = text ? "too long" : "empty";
    else if (!f)
      reason = ctx.scanFindingIds.has(id)
        ? "cites a finding of another issue"
        : "cites a finding that does not exist";
    else if (value === null) reason = `the finding has no ${c.evidenceField}`;
    else {
      const cited = buildCorpus([value], [id]);
      unsupported = unsupportedFacts(text, cited);
      if (
        !unsupported.length &&
        countFacts(text) === 0 &&
        !significantWords(text).some((w) => cited.text.includes(w))
      )
        reason = "nothing in the claim appears in the cited field";
    }
    const passed = !reason && unsupported.length === 0;
    checks.push({
      checkType: "claim",
      passed,
      detail: {
        text: text.slice(0, MAX_CLAIM_LENGTH),
        findingId: id,
        field: c.evidenceField,
        ...(unsupported.length ? { unsupported: unsupported.slice(0, 20) } : {}),
        ...(reason ? { reason } : {}),
      },
    });
    if (!passed) failedFields.add("claims");
  }
  if (ai.claims.length > MAX_CLAIMS)
    checks.push({
      checkType: "claim_limit",
      passed: false,
      detail: { received: ai.claims.length, checked: MAX_CLAIMS },
    });

  fields.description = withVerdictWording(fields.description, facts.verdict);
  // Nothing of substance left from the AI: treat as rejected.
  if (["title", "description", "recommendation"].every((f) => failedFields.has(f)))
    return { origin: "deterministic", status: "rejected", fields: fallback, checks };
  return {
    origin: "ai",
    status: checks.every((c) => c.passed) ? "passed" : "partial",
    fields,
    checks,
  };
}
