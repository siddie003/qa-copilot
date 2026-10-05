import { AlertTriangle, CheckCircle2, HelpCircle, XCircle } from "lucide-react";
import { cn } from "@/lib/cn";

export const COMPARISON_VERDICTS = {
  match: { label: "Match", Icon: CheckCircle2, cls: "text-success" },
  confirmed_mismatch: { label: "Confirmed mismatch", Icon: XCircle, cls: "text-danger" },
  potential_mismatch: { label: "Potential mismatch", Icon: AlertTriangle, cls: "text-warning" },
  unable_to_verify: { label: "Unable to verify", Icon: HelpCircle, cls: "text-muted" },
} as const;

export type ComparisonVerdictKey = keyof typeof COMPARISON_VERDICTS;

/** Verdict of one compared reference value, with an icon so color is never the only signal. */
export function ComparisonVerdict({ verdict }: { verdict: string }) {
  const v =
    COMPARISON_VERDICTS[verdict as ComparisonVerdictKey] ?? COMPARISON_VERDICTS.unable_to_verify;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap text-sm font-medium",
        v.cls,
      )}
    >
      <v.Icon aria-hidden className="size-4" />
      {v.label}
    </span>
  );
}
