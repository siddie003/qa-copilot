"use client";

import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  CircleDashed,
  HelpCircle,
  Loader2,
  XCircle,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { cn } from "@/lib/cn";

const STATUS = {
  pending: { label: "Queued", Icon: CircleDashed, cls: "text-subtle" },
  processing: { label: "Processing", Icon: Loader2, cls: "text-info [&_svg]:animate-spin" },
  parsing: { label: "Processing", Icon: Loader2, cls: "text-info [&_svg]:animate-spin" },
  ready: { label: "Ready", Icon: CheckCircle2, cls: "text-success" },
  parsed: { label: "Parsed", Icon: CheckCircle2, cls: "text-success" },
  failed: { label: "Failed", Icon: XCircle, cls: "text-danger" },
  unavailable: { label: "Unavailable", Icon: HelpCircle, cls: "text-warning" },
  cancelled: { label: "Cancelled", Icon: Ban, cls: "text-muted" },
  partial: { label: "Partial", Icon: AlertTriangle, cls: "text-warning" },
  ready_with_warnings: { label: "Ready with warnings", Icon: AlertTriangle, cls: "text-warning" },
} as const;

/**
 * Processing state of a reference or document, with an icon so color is never the only signal.
 * A ready reference with an outcome shows it (Partial, Ready with warnings).
 */
export function ProcessingStatus({ status, outcome }: { status: string; outcome?: string | null }) {
  const key =
    status === "ready" && outcome === "partial"
      ? "partial"
      : status === "ready" && outcome === "completed_with_warnings"
        ? "ready_with_warnings"
        : status;
  const s = STATUS[key as keyof typeof STATUS] ?? {
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

export const isProcessing = (status: string) =>
  ["pending", "processing", "parsing"].includes(status);

/** Refreshes server data every few seconds while background work is in progress. */
export function useRefreshWhile(active: boolean, intervalMs = 2500) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(t);
  }, [active, intervalMs, router]);
}
