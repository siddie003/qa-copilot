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
  text_diff: "Text difference",
  design_token: "Design reference value",
};

const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;

function Swatch({ color }: { color: string }) {
  return (
    <span
      aria-hidden
      className="mr-1.5 inline-block size-3.5 rounded-sm border border-border-strong align-[-2px]"
      style={{ backgroundColor: color }}
    />
  );
}

/** Word diff between the website text and the approved text. */
function TextDiff({ data }: { data: Record<string, unknown> }) {
  const parts = (data.diff as Array<{ op: string; text: string }> | undefined) ?? [];
  return (
    <div className="space-y-2 text-sm">
      <p className="text-xs text-muted">
        <ins className="bg-success-bg px-0.5 text-foreground underline">Underlined</ins>: in the
        approved text but missing on the website ·{" "}
        <del className="bg-danger-bg px-0.5 text-foreground">struck through</del>: on the website
        but not in the approved text
        {typeof data.similarity === "number" ? ` · similarity ${data.similarity}` : ""}
      </p>
      <p className="whitespace-pre-wrap break-words rounded bg-surface-muted p-2 leading-relaxed">
        {parts.map((p, i) =>
          p.op === "missing_on_website" ? (
            <ins key={i} className="bg-success-bg px-0.5 underline">
              {p.text}
            </ins>
          ) : p.op === "not_in_reference" ? (
            <del key={i} className="bg-danger-bg px-0.5">
              {p.text}
            </del>
          ) : (
            <span key={i}>{p.text}</span>
          ),
        )}
      </p>
      <dl className="grid gap-1 sm:grid-cols-[10rem_1fr]">
        <dt className="text-xs font-medium text-muted">Approved text</dt>
        <dd className="break-words">{String(data.reference ?? "")}</dd>
        <dt className="text-xs font-medium text-muted">Website text</dt>
        <dd className="break-words">{String(data.website ?? "")}</dd>
        {typeof data.element === "string" && (
          <>
            <dt className="text-xs font-medium text-muted">Element</dt>
            <dd className="break-all font-mono text-xs">{data.element}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

/** Computed-style observations per page and viewport. */
function Observations({ rows }: { rows: Array<Record<string, unknown>> }) {
  return (
    <div
      role="region"
      aria-label="Observed values"
      tabIndex={0}
      className="relative overflow-x-auto"
    >
      <table className="w-full min-w-[560px] text-left text-xs">
        <thead className="text-muted">
          <tr>
            {["Page", "Viewport", "Actual", "ΔE", "Elements", "Example"].map((h) => (
              <th key={h} scope="col" className="py-1 pr-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r, i) => (
            <tr key={i}>
              <td className="break-all py-1 pr-2">{String(r.page ?? "")}</td>
              <td className="py-1 pr-2">{String(r.viewport ?? "")}</td>
              <td className="py-1 pr-2 font-mono">
                {typeof r.actual === "string" && HEX.test(r.actual) && <Swatch color={r.actual} />}
                {String(r.actual ?? "")}
              </td>
              <td className="py-1 pr-2 tabular-nums">
                {r.deltaE === undefined ? "—" : String(r.deltaE)}
              </td>
              <td className="py-1 pr-2 tabular-nums">{String(r.elements ?? "")}</td>
              <td className="break-all py-1 pr-2 font-mono">
                {String(r.selector ?? "")}
                {r.text ? (
                  <span className="block font-sans text-subtle">“{String(r.text)}”</span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Value({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-subtle">—</span>;
  if (typeof value === "string" && HEX.test(value))
    return (
      <span className="font-mono">
        <Swatch color={value} />
        {value}
      </span>
    );
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((v) => v && typeof v === "object" && "actual" in v && "page" in v)
  )
    return <Observations rows={value as Array<Record<string, unknown>>} />;
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
          ) : e.kind === "text_diff" ? (
            <TextDiff data={e.data} />
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
