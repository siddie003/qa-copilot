import { ISSUE_STATUSES, SEVERITIES } from "@qa/core/domain";
import { z } from "zod";

/**
 * Issue explorer filters, shared by the Issues pages (query string of a GET form) and
 * `GET /api/v1/issues`. Invalid values are dropped instead of failing the page.
 */

export type RawParams = Record<string, string | string[] | undefined>;

const list = <T extends string>(values: readonly [T, ...T[]]) =>
  z.preprocess(
    (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]),
    z.array(z.enum(values)).catch([]),
  );

/** Verdict groups shown to users: "unverified" covers inconclusive and unable to verify. */
export const VERDICT_FILTERS = ["confirmed", "potential", "unverified"] as const;
export const VERDICT_FILTER_LABELS: Record<(typeof VERDICT_FILTERS)[number], string> = {
  confirmed: "Confirmed",
  potential: "Needs review",
  unverified: "Unable to verify",
};

export const DETECTED_SINCE = { "1d": 1, "7d": 7, "30d": 30, "90d": 90 } as const;
export const DETECTED_SINCE_LABELS: Record<keyof typeof DETECTED_SINCE, string> = {
  "1d": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
};

export const ISSUE_SORTS = ["severity", "status", "category", "date", "number"] as const;
export const SORT_LABELS: Record<(typeof ISSUE_SORTS)[number], string> = {
  severity: "Severity",
  status: "Status",
  category: "Category",
  date: "Last updated",
  number: "Newest issue number",
};

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .catch(undefined)
    .transform((v) => v || undefined);

export const issueFilterSchema = z.object({
  severity: list(SEVERITIES),
  status: list(ISSUE_STATUSES),
  verdict: list(VERDICT_FILTERS),
  category: optionalText(64),
  url: optionalText(500),
  q: optionalText(200),
  /** Minimum confidence in percent (0–100). */
  minConfidence: z.coerce.number().int().min(0).max(100).optional().catch(undefined),
  since: z.enum(["1d", "7d", "30d", "90d"]).optional().catch(undefined),
  sort: z.enum(ISSUE_SORTS).catch("severity").default("severity"),
  page: z.coerce.number().int().min(1).max(10_000).catch(1).default(1),
});
export type IssueFilters = z.infer<typeof issueFilterSchema>;

export const parseIssueFilters = (params: RawParams) => issueFilterSchema.parse(params);

export const hasActiveFilters = (f: IssueFilters) =>
  Boolean(
    f.severity.length ||
    f.status.length ||
    f.verdict.length ||
    f.category ||
    f.url ||
    f.q ||
    f.minConfidence !== undefined ||
    f.since,
  );

/** Repository options for the filters (verdict groups expanded, relative dates resolved). */
export function toListOptions(f: IssueFilters, now = Date.now()) {
  return {
    severities: f.severity,
    statuses: f.status,
    category: f.category,
    verdicts: f.verdict.flatMap((v) =>
      v === "unverified" ? (["inconclusive", "unable_to_verify"] as const) : [v],
    ),
    url: f.url,
    q: f.q,
    minConfidence: f.minConfidence !== undefined ? f.minConfidence / 100 : undefined,
    detectedSince: f.since ? new Date(now - DETECTED_SINCE[f.since] * 86_400_000) : undefined,
    sort: f.sort,
    page: f.page,
  };
}

/** URLSearchParams → the record shape forms produce (repeated keys become arrays). */
export function searchParamsToRecord(sp: URLSearchParams): RawParams {
  const out: RawParams = {};
  for (const key of new Set(sp.keys())) {
    const all = sp.getAll(key);
    out[key] = all.length > 1 ? all : all[0];
  }
  return out;
}
