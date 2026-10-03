import Link from "next/link";
import { cn } from "@/lib/cn";

/**
 * KPI tile: label + number in text ink. An optional marker swatch carries the category identity,
 * so the number itself is never color-coded.
 */
export function StatTile({
  label,
  value,
  marker,
  href,
  hint,
}: {
  label: string;
  value: number;
  marker?: string;
  href?: string;
  hint?: string;
}) {
  const body = (
    <>
      <dt className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted">
        {marker && <span aria-hidden className={cn("size-2.5 rounded-sm", marker)} />}
        {label}
      </dt>
      <dd className="mt-1 text-2xl font-semibold tabular-nums text-foreground">{value}</dd>
      {hint && <dd className="mt-0.5 text-xs text-subtle">{hint}</dd>}
    </>
  );
  const cls = "block rounded-lg border border-border bg-surface px-4 py-3";
  return href ? (
    <div>
      <Link href={href} className={cn(cls, "hover:border-border-strong hover:bg-surface-muted/50")}>
        <dl>{body}</dl>
      </Link>
    </div>
  ) : (
    <dl className={cls}>{body}</dl>
  );
}

export const SEVERITY_MARKERS: Record<string, string> = {
  critical: "bg-danger",
  high: "bg-[#ea580c]",
  medium: "bg-warning",
  low: "bg-info",
  info: "bg-border-strong",
};

export function Card({
  title,
  action,
  children,
  className,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  const id = `card-${title.toLowerCase().replace(/\W+/g, "-")}`;
  return (
    <section
      aria-labelledby={id}
      className={cn("rounded-lg border border-border bg-surface", className)}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 id={id} className="text-sm font-semibold">
          {title}
        </h2>
        {action}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}
