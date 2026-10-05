import { CheckCircle2, CircleSlash, HelpCircle, XCircle } from "lucide-react";
import { StatusPill, type PillTone } from "@/components/ui/status-pill";
import { cn } from "@/lib/cn";

/** How an issue's text was produced and validated (Phase 7 grounding). */
export const GROUNDING_LABELS: Record<string, { label: string; tone: PillTone; help: string }> = {
  passed: {
    label: "AI text, evidence-checked",
    tone: "success",
    help: "Written by AI; every value, link, quote and cited finding was found in the scan evidence.",
  },
  partial: {
    label: "AI text, parts replaced",
    tone: "warning",
    help: "Written by AI; parts that the evidence did not support were replaced with the scanner's wording.",
  },
  rejected: {
    label: "AI text rejected",
    tone: "danger",
    help: "The AI text cited findings that do not exist or belong to another issue, or nothing it wrote could be supported. The scanner's wording is shown.",
  },
  not_applicable: {
    label: "Scanner wording",
    tone: "neutral",
    help: "Built from the scanner findings and the rule catalog; no AI text was used.",
  },
};

export function GroundingBadge({ status }: { status: string }) {
  const g = GROUNDING_LABELS[status] ?? GROUNDING_LABELS.not_applicable!;
  return <StatusPill tone={g.tone}>{g.label}</StatusPill>;
}

export const VERDICT_NOTES: Record<string, { label: string; tone: PillTone } | undefined> = {
  potential: { label: "Needs review", tone: "warning" },
  inconclusive: { label: "Unable to verify", tone: "neutral" },
  unable_to_verify: { label: "Unable to verify", tone: "neutral" },
};

const FIELD_NAMES: Record<string, string> = {
  title: "Title",
  description: "Description",
  recommendation: "Recommendation",
  severityRationale: "Severity rationale",
  expected: "Expected value",
  actual: "Actual value",
};

const CLAIM_FIELDS: Record<string, string> = {
  title: "title",
  message: "message",
  expected: "expected value",
  actual: "actual value",
  selector: "element",
  pageUrl: "page",
  evidence: "evidence",
};

const list = (v: unknown) =>
  Array.isArray(v) ? v.filter((x) => typeof x === "string" || typeof x === "number") : [];

/** One grounding check in plain language: what was checked and, if it failed, why. */
export function describeCheck(c: {
  checkType: string;
  passed: boolean;
  detail: Record<string, unknown>;
}): { label: string; detail: string | null } {
  const d = c.detail;
  const unsupported = list(d.unsupported);
  const reason = typeof d.reason === "string" ? d.reason : null;
  if (c.checkType.startsWith("field:")) {
    const name = FIELD_NAMES[c.checkType.slice(6)] ?? c.checkType.slice(6);
    return {
      label: `${name}: values supported by the evidence`,
      detail: c.passed
        ? typeof d.checkedFacts === "number" && d.checkedFacts > 0
          ? `${d.checkedFacts} value(s) checked`
          : "No numbers, colors, links or quotes to check"
        : [
            reason,
            unsupported.length ? `Not in the evidence: ${unsupported.join(", ")}` : null,
            "replaced with the scanner's wording",
          ]
            .filter(Boolean)
            .join(" · "),
    };
  }
  switch (c.checkType) {
    case "source_findings": {
      const problems = [
        list(d.unknown).length ? `not in this scan: ${list(d.unknown).join(", ")}` : null,
        list(d.otherIssue).length
          ? `belong to another issue: ${list(d.otherIssue).join(", ")}`
          : null,
        list(d.withoutEvidence).length
          ? `without evidence: ${list(d.withoutEvidence).join(", ")}`
          : null,
        reason,
      ].filter(Boolean);
      return {
        label: "Cited findings exist in this scan, belong to this issue and have evidence",
        detail: c.passed
          ? `Cited ${list(d.cited).join(", ")} (${d.issueFindings} finding(s) in this issue)`
          : `Rejected: ${problems.join("; ")}`,
      };
    }
    case "severity":
      return {
        label: "Severity within one level of the scanner's (never raised for unconfirmed findings)",
        detail: c.passed
          ? `AI chose ${d.aiSeverity}; scanner ${d.scannerSeverity}`
          : `AI chose ${d.aiSeverity}; allowed: ${list(d.allowed).join(", ")}; ${d.replacedWith} used`,
      };
    case "affected_element":
      return {
        label: "Element is one of the findings' elements",
        detail: c.passed ? null : `“${String(d.value)}” is not an element of the findings`,
      };
    case "claim":
      return {
        label: `Statement: “${String(d.text)}”`,
        detail: `${c.passed ? "Supported by" : "Not supported by"} ${String(d.findingId)} (${CLAIM_FIELDS[String(d.field)] ?? String(d.field)})${
          unsupported.length ? ` · not in that field: ${unsupported.join(", ")}` : ""
        }${reason ? ` · ${reason}` : ""}`,
      };
    case "claim_limit":
      return {
        label: "Number of statements",
        detail: `${d.received} received; only the first ${d.checked} were checked`,
      };
    case "ai_output":
      return { label: "AI text available for this issue", detail: reason };
    default:
      return { label: c.checkType, detail: JSON.stringify(d) };
  }
}

export function GroundingChecks({
  checks,
}: {
  checks: Array<{ checkType: string; passed: boolean; detail: Record<string, unknown> }>;
}) {
  if (!checks.length)
    return <p className="text-xs text-subtle">No AI text was produced for this issue.</p>;
  return (
    <ul className="space-y-1.5">
      {checks.map((c, i) => {
        const { label, detail } = describeCheck(c);
        const Icon = c.checkType === "ai_output" ? CircleSlash : c.passed ? CheckCircle2 : XCircle;
        return (
          <li key={i} className="flex gap-2 text-sm">
            <Icon
              aria-hidden
              className={cn(
                "mt-0.5 size-4 shrink-0",
                c.checkType === "ai_output"
                  ? "text-subtle"
                  : c.passed
                    ? "text-success"
                    : "text-danger",
              )}
            />
            <span className="min-w-0 break-words">
              <span className="sr-only">{c.passed ? "Passed: " : "Failed: "}</span>
              {label}
              {detail && <span className="block text-xs text-muted">{detail}</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function VerdictNote({ verdict }: { verdict: string }) {
  const v = VERDICT_NOTES[verdict];
  if (!v) return null;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted">
      <HelpCircle aria-hidden className="size-3.5" />
      {v.label}
    </span>
  );
}
