/** Renders scanner evidence as plain data. Scanned content is always shown as text, never as HTML. */
export interface EvidenceItem {
  kind: string;
  data: Record<string, unknown>;
  storageKey: string | null;
}

const KIND_LABELS: Record<string, string> = {
  axe_node: "Accessibility check (axe-core)",
  header: "HTTP response headers",
  html_snippet: "HTML",
  network: "Network request",
  measurement: "Measurement",
  computed_style: "Computed styles",
  document: "Page data",
  link_check: "Link check",
  console: "Console",
  screenshot: "Screenshot",
};

function Value({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-subtle">—</span>;
  if (typeof value === "string")
    return value.includes("<") || value.length > 120 ? (
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-surface-muted p-2 font-mono text-xs">
        {value}
      </pre>
    ) : (
      <span className="break-all">{value}</span>
    );
  if (typeof value === "number" || typeof value === "boolean") return <span>{String(value)}</span>;
  return (
    <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-surface-muted p-2 font-mono text-xs">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

export function EvidenceView({ items }: { items: EvidenceItem[] }) {
  return (
    <ul className="space-y-3">
      {items.map((e, i) => (
        <li key={i} className="rounded-md border border-border p-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
            {KIND_LABELS[e.kind] ?? e.kind}
          </p>
          {e.kind === "screenshot" && e.storageKey ? (
            <a
              href={`/api/v1/artifacts/${e.storageKey}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block"
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- authenticated artifact stream */}
              <img
                src={`/api/v1/artifacts/${e.storageKey}`}
                alt={`Screenshot at ${String(e.data.viewport ?? "")} viewport`}
                loading="lazy"
                className="max-h-64 rounded border border-border object-cover object-top"
              />
              <span className="mt-1 block text-xs text-primary">
                Open full screenshot ({String(e.data.viewport ?? "")})
              </span>
            </a>
          ) : (
            <dl className="grid gap-2 text-sm sm:grid-cols-[10rem_1fr]">
              {Object.entries(e.data).map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-xs font-medium text-muted">{k}</dt>
                  <dd className="min-w-0">
                    <Value value={v} />
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </li>
      ))}
    </ul>
  );
}
