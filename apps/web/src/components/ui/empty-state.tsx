import type { LucideIcon } from "lucide-react";

export function EmptyState({
  icon: Icon,
  title,
  description,
  note,
  action,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  note?: string;
  action?: React.ReactNode;
}) {
  return (
    <section className="flex flex-col items-center rounded-lg border border-dashed border-border-strong bg-surface px-6 py-14 text-center">
      <div className="mb-4 rounded-full bg-surface-muted p-3">
        <Icon aria-hidden className="size-6 text-subtle" />
      </div>
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="mt-1 max-w-md text-sm text-muted">{description}</p>
      {note && <p className="mt-3 text-xs text-subtle">{note}</p>}
      {action && <div className="mt-5">{action}</div>}
    </section>
  );
}
