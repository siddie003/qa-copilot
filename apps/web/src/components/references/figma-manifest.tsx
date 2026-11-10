import { formatDateTime } from "@/lib/format";

/** The parts of the persisted Figma manifest the UI shows (see @qa/reference FigmaManifest). */
interface ManifestPage {
  id: string;
  name: string;
  status: "pending" | "done" | "failed";
  error?: string;
  framesTotal?: number;
  nodes?: number;
}
interface Manifest {
  version: string | null;
  mode: "whole_file" | "pages" | "nodes" | null;
  pagesDiscovered: number | null;
  pages: ManifestPage[];
  requests: { tier1: number; tier3: number; retries: number };
  rateLimit: {
    retryAfterSeconds: number | null;
    planTier: string | null;
    rateLimitType: string | null;
    upgradeLink: string | null;
    at: string;
  } | null;
  warnings: string[];
  runs: number;
  complete: boolean;
  finishedAt: string | null;
  unchangedCheckedAt: string | null;
}

const MODE_LABELS = {
  whole_file: "read in one request",
  pages: "read page by page",
  nodes: "linked frame(s) only",
} as const;

const n = (v: number) => v.toLocaleString("en-US");

/** Only Figma's own pages are linked (the header comes from Figma's API, still checked). */
function safeFigmaLink(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && /(^|\.)figma\.com$/.test(u.hostname) ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * What a Figma read covered, from the persisted manifest: pages read / failed / not reached,
 * frames, the file version, requests used per rate-limit tier and Figma's rate-limit details.
 * Every number comes from the manifest; nothing is estimated.
 */
export function FigmaManifestSummary({ manifest }: { manifest: unknown }) {
  if (!manifest || typeof manifest !== "object" || !("pages" in manifest)) return null;
  const m = manifest as Manifest;
  const done = m.pages.filter((p) => p.status === "done");
  const failed = m.pages.filter((p) => p.status === "failed");
  const pending = m.pages.filter((p) => p.status === "pending");
  const frames = done.reduce((s, p) => s + (p.framesTotal ?? 0), 0);
  const unit = m.mode === "nodes" ? "linked node" : "page";
  const total = m.pagesDiscovered ?? m.pages.length;
  const link = safeFigmaLink(m.rateLimit?.upgradeLink ?? null);
  return (
    <div className="space-y-1 text-xs text-muted">
      <p>
        {n(done.length)} of {n(total)} {unit}
        {total === 1 ? "" : "s"} read
        {failed.length ? ` · ${n(failed.length)} failed` : ""}
        {pending.length ? ` · ${n(pending.length)} not read yet` : ""} · {n(frames)} top-level frame
        {frames === 1 ? "" : "s"}
        {m.version ? ` · Figma version ${m.version}` : ""}
        {m.mode ? ` · ${MODE_LABELS[m.mode]}` : ""}
      </p>
      <p>
        Figma API requests so far: {n(m.requests.tier1)} file-content (Tier 1),{" "}
        {n(m.requests.tier3)} metadata (Tier 3)
        {m.requests.retries ? `, ${n(m.requests.retries)} retried` : ""} over {n(m.runs)} run
        {m.runs === 1 ? "" : "s"}
        {m.unchangedCheckedAt
          ? ` · checked ${formatDateTime(m.unchangedCheckedAt)}: unchanged, nothing fetched`
          : ""}
      </p>
      {m.rateLimit && (
        <p className="text-warning">
          Figma rate limit reached {formatDateTime(m.rateLimit.at)}
          {m.rateLimit.planTier ? ` (plan: ${m.rateLimit.planTier}` : " ("}
          {m.rateLimit.rateLimitType === "low"
            ? "; View/Collab seat: file requests are limited to a few per month"
            : m.rateLimit.rateLimitType === "high"
              ? "; Full/Dev seat"
              : ""}
          ).{" "}
          {link && (
            <a href={link} target="_blank" rel="noopener noreferrer" className="underline">
              Figma plan options
            </a>
          )}
        </p>
      )}
      {m.warnings.map((w) => (
        <p key={w}>{w}</p>
      ))}
      {failed.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-warning">
          {failed.slice(0, 20).map((p) => (
            <li key={p.id}>
              {p.name} ({p.id}): {p.error ?? "could not be read"}
            </li>
          ))}
          {failed.length > 20 && <li>and {n(failed.length - 20)} more failed pages</li>}
        </ul>
      )}
      {m.pages.length > 0 && (
        <details>
          <summary className="cursor-pointer">
            All {unit}s ({n(m.pages.length)})
          </summary>
          <ul className="mt-1 max-h-60 space-y-0.5 overflow-auto pl-1" tabIndex={0}>
            {m.pages.map((p) => (
              <li key={p.id}>
                <span className="font-medium text-foreground">{p.name}</span>{" "}
                <span className="font-mono">{p.id}</span> ·{" "}
                {p.status === "done"
                  ? `${n(p.framesTotal ?? 0)} frames, ${n(p.nodes ?? 0)} nodes`
                  : p.status === "failed"
                    ? `failed: ${p.error ?? "unknown error"}`
                    : "not read yet"}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
