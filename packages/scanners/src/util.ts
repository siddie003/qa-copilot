import { normalizeUrl } from "@qa/crawler";
import type { CaptureRecord, EvidenceDraft, PageRecord } from "./types";

/**
 * Pages a scanner can analyze: HTML responses below 400 that were actually fetched. A URL that
 * redirects to a page already in the list (e.g. /old-page → /about) is the same document and is
 * analyzed once, so its problems are not reported twice.
 */
export function analyzablePages(pages: PageRecord[]): PageRecord[] {
  const eligible = pages.filter(
    (p) =>
      !p.crawlError &&
      p.httpStatus !== null &&
      p.httpStatus < 400 &&
      /^(text\/html|application\/xhtml\+xml)/i.test(p.contentType ?? ""),
  );
  // Prefer the page that was reached directly over one reached through redirects.
  const ordered = [...eligible].sort(
    (a, b) => Number(Boolean(a.redirectChain?.length)) - Number(Boolean(b.redirectChain?.length)),
  );
  const seen = new Set<string>();
  const kept = new Set<string>();
  for (const p of ordered) {
    const key = normalizeUrl(p.finalUrl ?? p.url) ?? p.url;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.add(p.id);
  }
  return eligible.filter((p) => kept.has(p.id));
}

/** Runs `fn` over items with at most `n` in flight; stops picking new items when aborted. */
export async function pool<T>(
  items: T[],
  n: number,
  fn: (item: T) => Promise<void>,
  signal?: AbortSignal,
) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
      while (i < items.length && !signal?.aborted) await fn(items[i++]!);
    }),
  );
}

export function displayUrl(p: PageRecord): string {
  return p.finalUrl ?? p.url;
}

/** Lower-cased single header value (first value if repeated). */
export function header(p: PageRecord, name: string): string | null {
  const v = p.responseHeaders?.[name.toLowerCase()];
  if (v === undefined) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

export function headerList(p: PageRecord, name: string): string[] {
  const v = p.responseHeaders?.[name.toLowerCase()];
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

export function truncate(s: string, max = 500): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function screenshotEvidence(
  c: CaptureRecord | undefined,
  extra: Record<string, unknown> = {},
): EvidenceDraft[] {
  if (!c?.screenshotKey) return [];
  return [
    {
      kind: "screenshot",
      data: { viewport: c.viewport, width: c.width, height: c.height, ...extra },
      storageKey: c.screenshotKey,
    },
  ];
}

export function captureFor(p: PageRecord, viewport: string): CaptureRecord | undefined {
  return p.captures.find((c) => c.viewport === viewport && !c.error);
}

/** A list of up to `max` items plus how many were omitted, for compact evidence. */
export function sample<T>(items: T[], max = 10): { items: T[]; omitted: number } {
  return { items: items.slice(0, max), omitted: Math.max(0, items.length - max) };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}
