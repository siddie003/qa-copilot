const dateTime = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });
const date = new Intl.DateTimeFormat("en", { dateStyle: "medium" });

export const formatDateTime = (d: Date | string) => dateTime.format(new Date(d));
export const formatDate = (d: Date | string) => date.format(new Date(d));

const SCAN_STATUS_LABELS: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  completed_with_failures: "Completed with failures",
  failed: "Failed",
  cancelled: "Cancelled",
};

export const scanStatusLabel = (s: string) => SCAN_STATUS_LABELS[s] ?? s;

/** Host + path without scheme, for compact display of a website URL. */
export function displayUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === "/" ? "" : u.pathname;
    return `${u.host}${path}${u.search}`;
  } catch {
    return url;
  }
}

export function scanStatusTone(s: string): "success" | "warning" | "danger" | "info" | "neutral" {
  if (s === "completed") return "success";
  if (s === "completed_with_failures") return "warning";
  if (s === "failed") return "danger";
  if (s === "running" || s === "queued") return "info";
  return "neutral";
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
