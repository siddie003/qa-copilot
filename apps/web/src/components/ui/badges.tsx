import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  CircleSlash,
  HelpCircle,
  Loader2,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/cn";

const SEVERITY_STYLES: Record<string, string> = {
  critical: "bg-danger text-white",
  high: "bg-danger-bg text-danger",
  medium: "bg-warning-bg text-warning",
  low: "bg-info-bg text-info",
  info: "bg-surface-muted text-muted",
};

export const SEVERITY_LABELS: Record<string, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  info: "Informational",
};

export function SeverityBadge({ severity }: { severity: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 text-xs font-semibold",
        SEVERITY_STYLES[severity] ?? SEVERITY_STYLES.info,
      )}
    >
      {SEVERITY_LABELS[severity] ?? severity}
    </span>
  );
}

export const ISSUE_STATUS_LABELS: Record<string, string> = {
  open: "Open",
  in_progress: "In progress",
  resolved: "Resolved",
  reopened: "Reopened",
  ignored: "Ignored",
  inconclusive: "Inconclusive",
};

const ISSUE_STATUS_STYLES: Record<string, string> = {
  open: "bg-info-bg text-info",
  in_progress: "bg-warning-bg text-warning",
  resolved: "bg-success-bg text-success",
  reopened: "bg-danger-bg text-danger",
  ignored: "bg-surface-muted text-muted",
  inconclusive: "bg-surface-muted text-muted",
};

export function IssueStatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        ISSUE_STATUS_STYLES[status] ?? ISSUE_STATUS_STYLES.ignored,
      )}
    >
      {ISSUE_STATUS_LABELS[status] ?? status}
    </span>
  );
}

const STEP = {
  pending: { label: "Pending", Icon: CircleDashed, cls: "text-subtle" },
  running: { label: "Running", Icon: Loader2, cls: "text-info [&_svg]:animate-spin" },
  completed: { label: "Completed", Icon: CheckCircle2, cls: "text-success" },
  failed: { label: "Failed", Icon: XCircle, cls: "text-danger" },
  inconclusive: { label: "Inconclusive", Icon: HelpCircle, cls: "text-warning" },
  skipped: { label: "Skipped", Icon: CircleSlash, cls: "text-subtle" },
} as const;

/** Status of a scanner / pipeline step, with an icon so color is never the only signal. */
export function StepStatus({ status }: { status: string }) {
  const s = STEP[status as keyof typeof STEP] ?? {
    label: status,
    Icon: AlertTriangle,
    cls: "text-muted",
  };
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-sm font-medium", s.cls)}>
      <s.Icon aria-hidden className="size-4" />
      {s.label}
    </span>
  );
}
