import { cn } from "@/lib/cn";

export interface CheckPart {
  key: string;
  label: string;
  status: "completed" | "inconclusive" | "not_configured" | "unavailable" | "failed";
  detail: string;
}

const STATUS: Record<CheckPart["status"], { label: string; className: string }> = {
  completed: { label: "Checked", className: "border-success/40 text-success" },
  inconclusive: { label: "Inconclusive", className: "border-warning/40 text-warning" },
  not_configured: { label: "Not configured", className: "border-border text-muted" },
  unavailable: { label: "Not available", className: "border-danger/40 text-danger" },
  failed: { label: "Failed", className: "border-danger/40 text-danger" },
};

/**
 * What each part of a multi-part scanner did (Design Quality): checked, not configured (an input
 * such as approved content was not provided) or not available, each with its reason.
 */
export function CheckParts({ parts, compact = false }: { parts: CheckPart[]; compact?: boolean }) {
  return (
    <ul aria-label="Parts of this check" className={cn("space-y-1", compact ? "mt-2" : "")}>
      {parts.map((p) => {
        const s = STATUS[p.status] ?? STATUS.inconclusive;
        return (
          <li key={p.key} className={cn("text-sm", compact && "text-xs")}>
            <span
              className={cn(
                "mr-2 inline-block rounded-full border px-2 py-0.5 text-xs font-medium",
                s.className,
              )}
            >
              {s.label}
            </span>
            <span className="font-medium text-foreground">{p.label}</span>
            {!compact || p.status !== "completed" ? (
              <span className="block text-xs text-muted">{p.detail}</span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
