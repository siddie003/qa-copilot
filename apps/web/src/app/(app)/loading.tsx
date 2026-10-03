export default function Loading() {
  return (
    <div role="status" aria-live="polite" className="animate-pulse space-y-4">
      <span className="sr-only">Loading…</span>
      <div className="h-7 w-48 rounded bg-surface-muted" />
      <div className="h-4 w-80 max-w-full rounded bg-surface-muted" />
      <div className="h-48 rounded-lg bg-surface-muted" />
    </div>
  );
}
