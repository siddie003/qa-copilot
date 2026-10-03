import { ButtonLink } from "./button";

/** Previous/next pagination that preserves the current query string. */
export function Pagination({
  page,
  pageSize,
  total,
  basePath,
  params,
  noun,
}: {
  page: number;
  pageSize: number;
  total: number;
  basePath: string;
  params: Record<string, string | string[] | undefined>;
  noun: string;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  const href = (p: number) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (k === "page" || v === undefined) continue;
      for (const item of Array.isArray(v) ? v : [v]) if (item) qs.append(k, item);
    }
    qs.set("page", String(p));
    return `${basePath}?${qs}`;
  };
  return (
    <nav aria-label="Pagination" className="mt-4 flex items-center justify-between text-sm">
      <span className="text-muted">
        Page {page} of {pages} · {total} {noun}
      </span>
      <div className="flex gap-2">
        {page > 1 && (
          <ButtonLink variant="secondary" size="sm" href={href(page - 1)}>
            Previous
          </ButtonLink>
        )}
        {page < pages && (
          <ButtonLink variant="secondary" size="sm" href={href(page + 1)}>
            Next
          </ButtonLink>
        )}
      </div>
    </nav>
  );
}
