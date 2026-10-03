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
