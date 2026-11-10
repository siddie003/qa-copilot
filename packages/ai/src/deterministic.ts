import { remediationFor, type RemediationContext } from "./catalog";
import type { GroupFacts, IssueFields, IssueGroup, IssueVerdict } from "./types";

/** Required wording for issues whose findings could not be verified. */
export const UNABLE_TO_VERIFY = "Unable to verify from available evidence.";

const NEEDS_REVIEW =
  "Needs review: the scanner reports this as a potential problem that it could not confirm automatically.";

/** Description with the wording its verdict requires (applied to AI and deterministic text). */
export function withVerdictWording(description: string, verdict: IssueVerdict): string {
  const text = description.trim();
  if (verdict === "inconclusive")
    return text.toLowerCase().startsWith(UNABLE_TO_VERIFY.toLowerCase().slice(0, -1))
      ? text
      : `${UNABLE_TO_VERIFY} ${text}`;
  return text;
}

/** The value when every finding agrees on it, otherwise null. */
function common(values: Array<string | null>): string | null {
  const first = values[0];
  return first && values.every((v) => v === first) ? first : null;
}

function firstEvidenceString(g: IssueGroup, kind: string | null, key: string): string | null {
  for (const f of g.findings)
    for (const e of f.evidence) {
      if (kind && e.kind !== kind) continue;
      const v = e.data[key];
      if (typeof v === "string" && v.trim()) return v;
    }
  return null;
}

export function remediationContext(g: IssueGroup): RemediationContext {
  const helpUrl = firstEvidenceString(g, "axe_node", "helpUrl");
  return {
    ruleId: g.ruleId,
    expected: common(g.findings.map((f) => f.expected)),
    actual: common(g.findings.map((f) => f.actual)),
    helpUrl: helpUrl && /^https?:\/\//.test(helpUrl) ? helpUrl : null,
    token: firstEvidenceString(g, "design_token", "token"),
    source:
      firstEvidenceString(g, "design_token", "source") ??
      firstEvidenceString(g, "document", "location"),
  };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "7 elements on 3 pages", "4 pages", "2 elements" or "3 occurrences". */
export function scopeText(facts: GroupFacts): string {
  const { pageCount: p, elementCount: e, findingCount: n } = facts;
  if (p >= 2 && e >= 2) return `${plural(e, "element")} on ${plural(p, "page")}`;
  if (p >= 2) return plural(p, "page");
  if (e >= 2) return plural(e, "element");
  return plural(n, "occurrence");
}

/**
 * The scanner's own wording for an issue: titles, messages and expected/actual values of its
 * findings, the deterministic counts and the rule catalog's guidance. Contains nothing that is
 * not in the findings or the catalog.
 */
export function deterministicIssue(g: IssueGroup, facts: GroupFacts): IssueFields {
  const first = g.findings[0]!;
  const n = g.findings.length;
  const sameTitle = g.findings.every((f) => f.title === first.title);
  const title =
    n === 1
      ? first.title
      : sameTitle
        ? `${first.title} (${scopeText(facts)})`
        : `${first.title} (+${n - 1} more)`;
  const ids = g.findings.slice(0, 10).map((f) => f.displayId);
  // The highest-severity finding's message leads (findings are sorted by severity).
  const parts = [first.message];
  if (n > 1)
    parts.push(
      `Found ${n} times (${ids.join(", ")}${n > ids.length ? `, +${n - ids.length} more` : ""})${facts.pageCount ? ` on ${plural(facts.pageCount, "page")}` : ""}.`,
    );
  if (facts.verdict === "potential") parts.push(NEEDS_REVIEW);
  const ctx = remediationContext(g);
  return {
    title: title.slice(0, 300),
    description: withVerdictWording(parts.join("\n\n"), facts.verdict),
    severity: facts.severity,
    severityRationale:
      n === 1
        ? `Severity assigned by the scanner rule (${facts.severity}).`
        : `Highest severity assigned by the scanner rule among the ${n} findings (${facts.severity}).`,
    affectedUrls: facts.pages,
    affectedElement: facts.selectors.length === 1 ? facts.selectors[0]! : null,
    expected: ctx.expected,
    actual: ctx.actual,
    recommendation: remediationFor(g.category, ctx),
    explanation: null,
  };
}
