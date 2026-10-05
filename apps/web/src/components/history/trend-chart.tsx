import { SEVERITIES } from "@qa/core/domain";
import { SEVERITY_LABELS } from "@/components/ui/badges";
import { SEVERITY_MARKERS } from "@/components/ui/stat";
import { cn } from "@/lib/cn";
import type { HistoryItem } from "@/server/comparisons";

/** SVG fills matching the severity markers used elsewhere (dashboard, legends). */
const FILLS: Record<string, string> = {
  critical: "fill-danger",
  high: "fill-[#ea580c]",
  medium: "fill-warning",
  low: "fill-info",
  info: "fill-border-strong",
};

const BAR = 22;
const STEP = 46;
const LEFT = 40;
const TOP = 12;
const PLOT = 160;
const GAP = 2;

function niceMax(n: number) {
  if (n <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(n));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s * 4 >= n)!;
  return step * 4;
}

/**
 * Issues found per scan, stacked by severity (critical at the baseline), for the latest
 * comparable scans in order. Each bar links to that scan's comparison with the previous scan
 * and carries its numbers as a hover/focus title; the history table below is the table view.
 */
export function TrendChart({ projectId, items }: { projectId: string; items: HistoryItem[] }) {
  const totals = items.map((i) =>
    SEVERITIES.reduce((n, s) => n + (i.breakdown?.severity[s] ?? 0), 0),
  );
  const max = niceMax(Math.max(0, ...totals));
  const ticks = [0, max / 4, max / 2, (3 * max) / 4, max];
  const width = LEFT + items.length * STEP + 8;
  const height = TOP + PLOT + 34;
  const y = (v: number) => TOP + PLOT - (v / max) * PLOT;
  const present = SEVERITIES.filter((s) => items.some((i) => (i.breakdown?.severity[s] ?? 0) > 0));

  return (
    <figure>
      <ul aria-label="Legend" className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        {present.map((s) => (
          <li key={s} className="flex items-center gap-1.5">
            <span aria-hidden className={cn("size-2.5 rounded-sm", SEVERITY_MARKERS[s])} />
            {SEVERITY_LABELS[s]}
          </li>
        ))}
      </ul>
      <div
        role="region"
        aria-label="Issues per scan chart (scrollable)"
        tabIndex={0}
        className="relative overflow-x-auto"
      >
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="group"
          aria-label={`Issues per scan for the last ${items.length} comparable scans: ${items
            .map((i, k) => `scan ${i.number}: ${totals[k]}`)
            .join(", ")}.`}
          className="block"
        >
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={LEFT}
                x2={width - 4}
                y1={y(t)}
                y2={y(t)}
                className={t === 0 ? "stroke-border-strong" : "stroke-border"}
                strokeWidth={1}
              />
              <text x={LEFT - 6} y={y(t) + 4} textAnchor="end" className="fill-muted text-[11px]">
                {Number.isInteger(t) ? t : t.toFixed(1)}
              </text>
            </g>
          ))}
          {items.map((item, k) => {
            const x = LEFT + k * STEP + (STEP - BAR) / 2;
            let acc = 0;
            const c = item.changes?.counts;
            const label = [
              `Scan #${item.number}: ${totals[k]} issue${totals[k] === 1 ? "" : "s"}`,
              SEVERITIES.filter((s) => item.breakdown?.severity[s])
                .map((s) => `${item.breakdown!.severity[s]} ${SEVERITY_LABELS[s]!.toLowerCase()}`)
                .join(", "),
              c && item.previous
                ? `vs scan #${item.previous.number}: ${c.new} new, ${c.reopened} reopened, ${c.resolved} resolved, ${c.changed} changed, ${c.not_rechecked} not rechecked`
                : "first comparable scan",
            ]
              .filter(Boolean)
              .join(" · ");
            const href = item.previous
              ? `/projects/${projectId}/history/compare?base=${item.previous.id}&target=${item.id}`
              : `/projects/${projectId}/scans/${item.id}`;
            return (
              <a key={item.id} href={href} aria-label={label} className="group outline-none">
                <title>{label}</title>
                <rect
                  x={LEFT + k * STEP + 2}
                  y={TOP}
                  width={STEP - 4}
                  height={PLOT}
                  rx={4}
                  className="fill-transparent group-hover:fill-surface-muted group-focus-visible:fill-surface-muted group-focus-visible:stroke-focus"
                  strokeWidth={2}
                />
                {SEVERITIES.map((s) => {
                  const n = item.breakdown?.severity[s] ?? 0;
                  if (!n) return null;
                  const top = y(acc + n);
                  const h = y(acc) - top;
                  // The lowest segment sits on the baseline; the others leave a surface gap below.
                  const gap = acc === 0 ? 0 : GAP;
                  acc += n;
                  return (
                    <rect
                      key={s}
                      x={x}
                      y={top}
                      width={BAR}
                      height={Math.max(1, h - gap)}
                      rx={acc === totals[k] ? 3 : 0}
                      className={FILLS[s]}
                    />
                  );
                })}
                <text
                  x={x + BAR / 2}
                  y={TOP + PLOT + 16}
                  textAnchor="middle"
                  className="fill-muted text-[11px]"
                >
                  #{item.number}
                </text>
              </a>
            );
          })}
        </svg>
      </div>
      <figcaption className="mt-2 text-xs text-subtle">
        Issues found by each scan (all statuses), by severity. Select a bar to compare that scan
        with the one before it.
      </figcaption>
    </figure>
  );
}
