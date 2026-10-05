import { FINDING_SOURCE_LABELS, stepLabel, type IssueStatus, type Severity } from "./domain";

/**
 * Scan comparison (Phase 9). Compares two stored scans of one project, issue by issue (issues
 * are matched by their tracked identity, `issue_track`) and, inside each issue, finding by
 * finding (matched by finding fingerprint).
 *
 * Absence is only evidence when the later scan actually re-checked the same thing: the scanner
 * ran, the page was analyzed, the viewport was captured, the scanner did not report the page or
 * the rule as unverifiable, and the reference (design/content) did not change. Otherwise an issue
 * that disappeared is "not rechecked" (never "resolved"), and an issue that appeared where the
 * earlier scan could not have seen it is "newly checked" (never "new").
 *
 * Pure and browser-safe: inputs are plain records loaded by `@qa/db` (comparisons repository).
 */

/** Bump when the classification rules change: cached summaries of older versions are recomputed. */
export const COMPARISON_VERSION = 1;

export const CHANGE_CATEGORIES = [
  "new",
  "reopened",
  "changed",
  "resolved",
  "persistent",
  "not_rechecked",
  "newly_checked",
] as const;
export type ChangeCategory = (typeof CHANGE_CATEGORIES)[number];

export const CHANGE_CATEGORY_LABELS: Record<ChangeCategory, string> = {
  new: "New",
  reopened: "Reopened",
  changed: "Changed",
  resolved: "Resolved",
  persistent: "Persistent",
  not_rechecked: "Not rechecked",
  newly_checked: "Newly checked",
};

export const CHANGE_CATEGORY_DESCRIPTIONS: Record<ChangeCategory, string> = {
  new: "Found in the target scan; the base scan checked the same pages and did not find it.",
  reopened:
    "Found again: either a resolved issue that the target scan found again (status set to Reopened), or an issue seen in an earlier scan that the base scan no longer found.",
  changed: "Found in both scans, but its severity, verdict, affected pages or findings differ.",
  resolved:
    "Found in the base scan; the target scan re-checked every affected page and did not find it.",
  persistent: "Found in both scans with the same severity, verdict and findings.",
  not_rechecked:
    "Found in the base scan but not in the target scan, which could not re-check it (scanner not run or failed, page not analyzed, reference changed). Not counted as resolved.",
  newly_checked:
    "Found in the target scan where the base scan could not have seen it (scanner not run or failed, page not analyzed). Not counted as new.",
};

export const FINDING_CHANGE_CATEGORIES = [
  "new",
  "fixed",
  "changed",
  "persistent",
  "not_rechecked",
  "newly_checked",
] as const;
export type FindingChangeCategory = (typeof FINDING_CHANGE_CATEGORIES)[number];

export const FINDING_CHANGE_LABELS: Record<FindingChangeCategory, string> = {
  new: "New",
  fixed: "No longer found",
  changed: "Changed",
  persistent: "Unchanged",
  not_rechecked: "Not rechecked",
  newly_checked: "Newly checked",
};

type Verdict = "confirmed" | "potential" | "inconclusive" | "unable_to_verify";

// ---------------------------------------------------------------------------------------------
// Inputs (stored records)

export interface ComparisonStepInput {
  stepKey: string;
  status: string;
  statusReason: string | null;
  error: string | null;
  findingCount: number;
  checks: Record<string, unknown> | null;
}

export interface ComparisonPageInput {
  url: string;
  finalUrl: string | null;
  httpStatus: number | null;
  contentType: string | null;
  crawlError: string | null;
  captures: Array<{ viewport: string; error: string | null }>;
}

export interface ComparisonFindingInput {
  id: string;
  displayId: string;
  scanner: string;
  ruleId: string;
  title: string;
  severity: Severity;
  verdict: Verdict;
  selector: string | null;
  viewport: string | null;
  expected: string | null;
  actual: string | null;
  fingerprint: string;
  /** URL of the finding's page (final URL if the page redirected); null for site-wide findings. */
  pageUrl: string | null;
}

export interface ComparisonIssueInput {
  id: string;
  trackId: string;
  displayNo: number;
  category: string;
  ruleId: string | null;
  title: string;
  severity: Severity;
  verdict: Verdict;
  confidence: number;
  affectedUrls: string[];
  findingIds: string[];
}

export interface ComparisonScanInput {
  id: string;
  projectId: string;
  number: number;
  status: string;
  createdAt: Date | string;
  startedAt: Date | string | null;
  finishedAt: Date | string | null;
  websiteUrl: string | null;
  scanners: string[];
  viewports: string[];
  maxPages: number | null;
  maxDepth: number | null;
  designSpecId: string | null;
  designSpecVersion: number | null;
  contentSnapshotHash: string | null;
  steps: ComparisonStepInput[];
  pages: ComparisonPageInput[];
  findings: ComparisonFindingInput[];
  issues: ComparisonIssueInput[];
}

/** What the workflow history says about one tracked issue (from issue_track / status events). */
export interface ComparisonTrackInput {
  trackId: string;
  displayNo: number;
  status: IssueStatus;
  /** Number of the latest scan before the base scan in which the issue occurred, if any. */
  lastSeenBeforeBase: number | null;
  /** System event written by the target scan: a resolved issue was found again. */
  reopenedByTarget: { at: Date | string } | null;
}

// ---------------------------------------------------------------------------------------------
// Output

export interface ComparisonScanRef {
  id: string;
  number: number;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Issue records exist (the evidence-validation step completed). */
  issuesAvailable: boolean;
  issueCount: number;
}

export interface FieldChange {
  field: "severity" | "verdict" | "actual" | "expected" | "viewport" | "pages";
  from: string | null;
  to: string | null;
  /**
   * Shown for information only: a lab measurement that varies between page loads (see
   * `MEASUREMENT_SOURCES`). It does not make a finding "changed" on its own.
   */
  measurement?: true;
}

export interface ComparisonFindingRef {
  id: string;
  displayId: string;
  title: string;
  severity: Severity;
  verdict: Verdict;
  pageUrl: string | null;
  viewport: string | null;
  selector: string | null;
}

export interface FindingComparisonItem {
  category: FindingChangeCategory;
  base: ComparisonFindingRef | null;
  target: ComparisonFindingRef | null;
  changes: FieldChange[];
  /** Why a finding could not be compared (not rechecked / newly checked). */
  reason: string | null;
}

export interface ComparisonIssueSide {
  issueId: string;
  title: string;
  severity: Severity;
  verdict: Verdict;
  confidence: number;
  findingCount: number;
  affectedUrls: string[];
}

export interface IssueComparisonItem {
  category: ChangeCategory;
  trackId: string;
  displayNo: number;
  /** Producing scanner / comparison (issue category). */
  source: string;
  ruleId: string | null;
  title: string;
  /** Current workflow status of the tracked issue. */
  trackStatus: IssueStatus | null;
  base: ComparisonIssueSide | null;
  target: ComparisonIssueSide | null;
  /** Plain-language explanation of the classification, built from the records. */
  reason: string;
  changes: FieldChange[];
  findings: FindingComparisonItem[];
  findingCounts: Record<FindingChangeCategory, number>;
}

export interface StepComparisonItem {
  stepKey: string;
  label: string;
  base: StepSide | null;
  target: StepSide | null;
  /** better / worse: the step completed in one scan only; different: any other status change. */
  direction: "same" | "better" | "worse" | "different" | "added" | "removed";
}

export interface StepSide {
  status: string;
  reason: string | null;
  findingCount: number;
  inconclusiveChecks: number;
}

export interface ComparisonSummary {
  version: number;
  comparable: boolean;
  counts: Record<ChangeCategory, number>;
  findings: Record<FindingChangeCategory, number>;
  baseIssues: number;
  targetIssues: number;
  /** Target issues whose evidence could not confirm them (verdict inconclusive / unable to verify). */
  targetUnableToVerify: number;
  /** Target issues that need review (verdict potential). */
  targetNeedsReview: number;
  stepChanges: number;
  warnings: number;
}

export interface ScanComparisonResult {
  version: number;
  projectId: string;
  base: ComparisonScanRef;
  target: ComparisonScanRef;
  /** False when issue records are missing for either scan; steps are still compared. */
  comparable: boolean;
  notComparable: string[];
  /** Differences in scan settings or coverage that limit what the comparison can say. */
  warnings: string[];
  summary: ComparisonSummary;
  issues: IssueComparisonItem[];
  steps: StepComparisonItem[];
}

// ---------------------------------------------------------------------------------------------
// Helpers

const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "gclid",
  "fbclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "_ga",
]);

/**
 * Site-relative page identity (path + sorted query without tracking parameters), the same
 * location identity finding fingerprints use, so a page matches across scans even if the scheme
 * or host spelling changed. Mirrors `normalizeUrl` in `@qa/crawler` (kept in step by a test).
 */
export function pageKey(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !TRACKING_PARAMS.has(k.toLowerCase()))
    .sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
  const search = new URLSearchParams(params).toString();
  return `${u.pathname}${search ? `?${search}` : ""}`;
}

/** Steps that ran: absence of a finding from them is evidence. */
const RAN = new Set(["completed", "inconclusive"]);

/**
 * Inconclusive checks (stored on the scanner step) that mean a scanner could not analyze a whole
 * page. Names are the scanners' own check labels; a test keeps them in step with the scanners.
 */
export const PAGE_LEVEL_GAP_CHECKS = ["axe-core analysis", "On-page SEO", "HTML security checks"];

/** Site-wide inconclusive checks that mean a scanner hit a limit and did not check everything. */
export const SCANNER_WIDE_GAP_CHECKS: Record<string, string[]> = { links: ["Link checks"] };

/**
 * Scanners whose observed values are lab measurements of one page load (timings, transfer sizes)
 * and vary between otherwise identical scans. For their findings, a different measured value or a
 * different worst viewport is reported as a measurement difference, not as a change; a different
 * severity or verdict (a threshold crossed) still is a change.
 */
export const MEASUREMENT_SOURCES = new Set(["performance"]);

export const sourceLabel = (key: string) => FINDING_SOURCE_LABELS[key] ?? stepLabel(key);

const iso = (d: Date | string | null) => (d === null ? null : new Date(d).toISOString());

const emptyCounts = <K extends string>(keys: readonly K[]) =>
  Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;

const VERDICT_WORDING: Record<Verdict, string> = {
  confirmed: "confirmed",
  potential: "needs review",
  inconclusive: "unable to verify",
  unable_to_verify: "unable to verify",
};

/** Issue verdicts compare by meaning: inconclusive and unable_to_verify are the same state. */
const verdictClass = (v: Verdict) => (v === "unable_to_verify" ? "inconclusive" : v);

const STEP_STATUS_WORDS: Record<string, string> = {
  failed: "failed",
  skipped: "was skipped",
  pending: "did not run",
  running: "did not finish",
};

interface PageState {
  analyzable: boolean;
  problem: string | null;
  captures: Map<string, string | null>;
}

interface StepGaps {
  site: string[];
  pages: Map<string, Array<{ check: string; reason: string }>>;
  truncated: boolean;
}

interface Coverage {
  scan: ComparisonScanInput;
  steps: Map<string, ComparisonStepInput>;
  pages: Map<string, PageState>;
  gaps: Map<string, StepGaps>;
}

const isHtml = (ct: string | null) => /^(text\/html|application\/xhtml\+xml)/i.test(ct ?? "");

function pageProblem(p: ComparisonPageInput): string | null {
  if (p.crawlError) return p.crawlError;
  if (p.httpStatus === null) return "no response";
  if (p.httpStatus >= 400) return `HTTP ${p.httpStatus}`;
  if (!isHtml(p.contentType)) return `not an HTML page (${p.contentType ?? "no content type"})`;
  return null;
}

function buildCoverage(scan: ComparisonScanInput): Coverage {
  const pages = new Map<string, PageState>();
  for (const p of scan.pages) {
    const problem = pageProblem(p);
    const keys = new Set(
      [p.finalUrl, p.url].filter((u): u is string => !!u).map((u) => pageKey(u)),
    );
    for (const key of keys) {
      if (!key) continue;
      const state = pages.get(key) ?? { analyzable: false, problem, captures: new Map() };
      if (!problem) {
        state.analyzable = true;
        state.problem = null;
      }
      for (const c of p.captures) {
        // A successful capture of the same document wins over a failed one.
        if (!state.captures.has(c.viewport) || state.captures.get(c.viewport))
          state.captures.set(c.viewport, c.error);
      }
      pages.set(key, state);
    }
  }
  const gaps = new Map<string, StepGaps>();
  for (const s of scan.steps) {
    const list = Array.isArray(s.checks?.inconclusive)
      ? (s.checks.inconclusive as Array<Record<string, unknown>>)
      : [];
    const total = typeof s.checks?.inconclusiveTotal === "number" ? s.checks.inconclusiveTotal : 0;
    const g: StepGaps = { site: [], pages: new Map(), truncated: total > list.length };
    const siteWide = SCANNER_WIDE_GAP_CHECKS[s.stepKey] ?? [];
    for (const entry of list) {
      const check = typeof entry.check === "string" ? entry.check : "";
      const reason = typeof entry.reason === "string" ? entry.reason : "";
      const url = typeof entry.pageUrl === "string" ? entry.pageUrl : null;
      if (!url) {
        if (siteWide.includes(check)) g.site.push(reason || check);
        continue;
      }
      const key = pageKey(url);
      if (!key) continue;
      g.pages.set(key, [...(g.pages.get(key) ?? []), { check, reason }]);
    }
    gaps.set(s.stepKey, g);
  }
  return { scan, steps: new Map(scan.steps.map((s) => [s.stepKey, s])), pages, gaps };
}

/**
 * Why `to` could not have observed `f` (a finding of `from`), or null when it re-checked it.
 * Used both ways: for base findings missing from the target (resolved vs not rechecked) and for
 * target findings missing from the base (new vs newly checked).
 */
function coverageGap(f: ComparisonFindingInput, from: ComparisonScanInput, to: Coverage) {
  const n = `scan #${to.scan.number}`;
  const label = sourceLabel(f.scanner);
  const step = to.steps.get(f.scanner);
  if (!step) return `${label} was not part of ${n}.`;
  if (!RAN.has(step.status)) {
    const why = step.error ?? step.statusReason;
    return `${label} ${STEP_STATUS_WORDS[step.status] ?? step.status} in ${n}${why ? ` (${why})` : ""}.`;
  }
  if (f.scanner === "design" && from.designSpecId !== to.scan.designSpecId) {
    const a = from.designSpecVersion ?? "none";
    const b = to.scan.designSpecVersion ?? "none";
    return `The design reference changed between the scans (version ${a} → ${b}).`;
  }
  if (f.scanner === "content" && from.contentSnapshotHash !== to.scan.contentSnapshotHash)
    return "The approved content documents or their page mapping changed between the scans.";
  const gaps = to.gaps.get(f.scanner);
  if (gaps?.site.length) return `${label} did not check everything in ${n}: ${gaps.site[0]}`;
  if (!f.pageUrl) return null;
  const key = pageKey(f.pageUrl);
  if (!key) return null;
  const page = to.pages.get(key);
  if (!page) return `${key} was not crawled in ${n}.`;
  if (!page.analyzable) return `${key} could not be analyzed in ${n} (${page.problem}).`;
  if (f.viewport) {
    if (!to.scan.viewports.includes(f.viewport))
      return `The ${f.viewport} viewport was not part of ${n}.`;
    if (!page.captures.has(f.viewport)) return `${key} was not captured at ${f.viewport} in ${n}.`;
    const err = page.captures.get(f.viewport);
    if (err) return `The ${f.viewport} capture of ${key} failed in ${n} (${err}).`;
  }
  const gap = gaps?.pages
    .get(key)
    ?.find(
      (g) =>
        PAGE_LEVEL_GAP_CHECKS.includes(g.check) ||
        g.check === f.ruleId ||
        g.check.startsWith(`${f.ruleId}:`),
    );
  if (gap) return `${label} could not fully check ${key} in ${n}: ${gap.reason}`;
  return null;
}

const findingRef = (f: ComparisonFindingInput): ComparisonFindingRef => ({
  id: f.id,
  displayId: f.displayId,
  title: f.title,
  severity: f.severity,
  verdict: f.verdict,
  pageUrl: f.pageUrl,
  viewport: f.viewport,
  selector: f.selector,
});

function fieldChanges(a: ComparisonFindingInput, b: ComparisonFindingInput): FieldChange[] {
  const out: FieldChange[] = [];
  if (a.severity !== b.severity) out.push({ field: "severity", from: a.severity, to: b.severity });
  if (verdictClass(a.verdict) !== verdictClass(b.verdict))
    out.push({ field: "verdict", from: a.verdict, to: b.verdict });
  const measured = MEASUREMENT_SOURCES.has(a.scanner) ? ({ measurement: true } as const) : {};
  if (a.actual !== b.actual)
    out.push({ field: "actual", from: a.actual, to: b.actual, ...measured });
  if (a.expected !== b.expected) out.push({ field: "expected", from: a.expected, to: b.expected });
  if (a.viewport !== b.viewport)
    out.push({ field: "viewport", from: a.viewport, to: b.viewport, ...measured });
  return out;
}

/** A change that counts (measurement differences alone do not). */
const isRealChange = (c: FieldChange) => !c.measurement;

/** Same element on the same page by the same rule (fallback when the viewport class changed). */
const looseKey = (f: ComparisonFindingInput) =>
  [f.scanner, f.ruleId, f.pageUrl ? pageKey(f.pageUrl) : "site", f.selector ?? ""].join("\n");

function compareFindings(
  baseFindings: ComparisonFindingInput[],
  targetFindings: ComparisonFindingInput[],
  base: Coverage,
  target: Coverage,
): FindingComparisonItem[] {
  const items: FindingComparisonItem[] = [];
  const pending = new Map<string, ComparisonFindingInput[]>();
  for (const f of targetFindings)
    pending.set(f.fingerprint, [...(pending.get(f.fingerprint) ?? []), f]);
  const unmatchedBase: ComparisonFindingInput[] = [];
  for (const b of baseFindings) {
    const t = pending.get(b.fingerprint)?.shift();
    if (t) pairItem(items, b, t);
    else unmatchedBase.push(b);
  }
  const unmatchedTarget = [...pending.values()].flat();
  // Second pass: the viewport class of an element can change (seen at one viewport instead of
  // several), which changes the fingerprint; the same element is then a changed finding.
  const loose = new Map<string, ComparisonFindingInput[]>();
  for (const t of unmatchedTarget) loose.set(looseKey(t), [...(loose.get(looseKey(t)) ?? []), t]);
  const paired = new Set<string>();
  for (const b of [...unmatchedBase]) {
    const t = loose.get(looseKey(b))?.shift();
    if (!t) continue;
    pairItem(items, b, t);
    paired.add(b.id).add(t.id);
  }
  for (const b of unmatchedBase) {
    if (paired.has(b.id)) continue;
    const reason = coverageGap(b, base.scan, target);
    items.push({
      category: reason ? "not_rechecked" : "fixed",
      base: findingRef(b),
      target: null,
      changes: [],
      reason,
    });
  }
  for (const t of unmatchedTarget) {
    if (paired.has(t.id)) continue;
    const reason = coverageGap(t, target.scan, base);
    items.push({
      category: reason ? "newly_checked" : "new",
      base: null,
      target: findingRef(t),
      changes: [],
      reason,
    });
  }
  return items;
}

function pairItem(
  items: FindingComparisonItem[],
  b: ComparisonFindingInput,
  t: ComparisonFindingInput,
) {
  const changes = fieldChanges(b, t);
  items.push({
    category: changes.some(isRealChange) ? "changed" : "persistent",
    base: findingRef(b),
    target: findingRef(t),
    changes,
    reason: null,
  });
}

const FINDING_ORDER: Record<FindingChangeCategory, number> = {
  new: 0,
  changed: 1,
  fixed: 2,
  not_rechecked: 3,
  newly_checked: 4,
  persistent: 5,
};

const CATEGORY_ORDER = Object.fromEntries(CHANGE_CATEGORIES.map((c, i) => [c, i])) as Record<
  ChangeCategory,
  number
>;

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

const issueSide = (i: ComparisonIssueInput): ComparisonIssueSide => ({
  issueId: i.id,
  title: i.title,
  severity: i.severity,
  verdict: i.verdict,
  confidence: i.confidence,
  findingCount: i.findingIds.length,
  affectedUrls: i.affectedUrls,
});

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function stepSide(s: ComparisonStepInput): StepSide {
  const total = s.checks?.inconclusiveTotal;
  const list = s.checks?.inconclusive;
  return {
    status: s.status,
    reason: s.error ?? s.statusReason,
    findingCount: s.findingCount,
    inconclusiveChecks: typeof total === "number" ? total : Array.isArray(list) ? list.length : 0,
  };
}

function compareSteps(
  base: ComparisonScanInput,
  target: ComparisonScanInput,
): StepComparisonItem[] {
  const keys = [
    ...target.steps.map((s) => s.stepKey),
    ...base.steps.map((s) => s.stepKey).filter((k) => !target.steps.some((s) => s.stepKey === k)),
  ];
  return keys.map((stepKey) => {
    const b = base.steps.find((s) => s.stepKey === stepKey);
    const t = target.steps.find((s) => s.stepKey === stepKey);
    let direction: StepComparisonItem["direction"];
    if (!b) direction = "added";
    else if (!t) direction = "removed";
    else if (b.status === t.status) direction = "same";
    else if (t.status === "completed" && ["failed", "inconclusive"].includes(b.status))
      direction = "better";
    else if (b.status === "completed" && ["failed", "inconclusive"].includes(t.status))
      direction = "worse";
    else direction = "different";
    return {
      stepKey,
      label: stepLabel(stepKey),
      base: b ? stepSide(b) : null,
      target: t ? stepSide(t) : null,
      direction,
    };
  });
}

/** Why a scan has no issue records to compare (null when it has them). */
function missingIssuesReason(s: ComparisonScanInput): string | null {
  const grounding = s.steps.find((x) => x.stepKey === "grounding");
  if (!grounding)
    return `Scan #${s.number} ran before issue tracking existed, so it has no issue records (its findings are still available).`;
  if (grounding.status === "completed") return null;
  const why = grounding.error ?? grounding.statusReason;
  return `Scan #${s.number} has no issue records: evidence validation ${STEP_STATUS_WORDS[grounding.status] ?? grounding.status}${why ? ` (${why})` : ""}.`;
}

function settingWarnings(base: ComparisonScanInput, target: ComparisonScanInput): string[] {
  const w: string[] = [];
  const b = `#${base.number}`;
  const t = `#${target.number}`;
  if (base.websiteUrl && target.websiteUrl && base.websiteUrl !== target.websiteUrl)
    w.push(
      `The scans used different website URLs (${b}: ${base.websiteUrl}, ${t}: ${target.websiteUrl}). Pages are matched by path.`,
    );
  const onlyBase = base.scanners.filter((s) => !target.scanners.includes(s));
  const onlyTarget = target.scanners.filter((s) => !base.scanners.includes(s));
  if (onlyBase.length)
    w.push(
      `Scan ${t} did not run ${onlyBase.map(sourceLabel).join(", ")}; issues from ${onlyBase.length === 1 ? "it" : "them"} are not rechecked.`,
    );
  if (onlyTarget.length)
    w.push(
      `Scan ${b} did not run ${onlyTarget.map(sourceLabel).join(", ")}; issues from ${onlyTarget.length === 1 ? "it" : "them"} are newly checked, not new.`,
    );
  const vb = [...base.viewports].sort().join(", ");
  const vt = [...target.viewports].sort().join(", ");
  if (vb !== vt)
    w.push(
      `The scans captured different viewports (${b}: ${vb || "none"}; ${t}: ${vt || "none"}).`,
    );
  if (base.maxPages !== target.maxPages || base.maxDepth !== target.maxDepth)
    w.push(
      `Crawl limits differ (${b}: ${base.maxPages ?? "?"} pages / depth ${base.maxDepth ?? "?"}; ${t}: ${target.maxPages ?? "?"} pages / depth ${target.maxDepth ?? "?"}).`,
    );
  if (base.designSpecId !== target.designSpecId)
    w.push(
      `The design reference differs (${b}: ${base.designSpecVersion ? `version ${base.designSpecVersion}` : "none"}; ${t}: ${target.designSpecVersion ? `version ${target.designSpecVersion}` : "none"}); design issues that disappeared are not counted as resolved.`,
    );
  if (base.contentSnapshotHash !== target.contentSnapshotHash)
    w.push(
      "The approved content documents differ between the scans; content issues that disappeared are not counted as resolved.",
    );
  for (const s of [base, target])
    if (s.status !== "completed")
      w.push(
        `Scan #${s.number} ${s.status === "completed_with_failures" ? "completed with failures" : `was ${s.status}`}: what it could not check is listed as not rechecked or newly checked.`,
      );
  return w;
}

// ---------------------------------------------------------------------------------------------

/**
 * Compares `base` (earlier) with `target` (later). Both must belong to the same project and the
 * base scan must be older; callers check this and that both scans have finished.
 */
export function compareScans(
  base: ComparisonScanInput,
  target: ComparisonScanInput,
  tracks: ComparisonTrackInput[],
): ScanComparisonResult {
  if (base.projectId !== target.projectId) throw new Error("Scans belong to different projects");
  if (base.number >= target.number) throw new Error("The base scan must be older than the target");

  const notComparable = [missingIssuesReason(base), missingIssuesReason(target)].filter(
    (r): r is string => r !== null,
  );
  const comparable = notComparable.length === 0;
  const warnings = settingWarnings(base, target);
  const steps = compareSteps(base, target);
  const ref = (s: ComparisonScanInput): ComparisonScanRef => ({
    id: s.id,
    number: s.number,
    status: s.status,
    startedAt: iso(s.startedAt),
    finishedAt: iso(s.finishedAt),
    issuesAvailable: missingIssuesReason(s) === null,
    issueCount: s.issues.length,
  });

  const issues: IssueComparisonItem[] = [];
  if (comparable) {
    const baseCov = buildCoverage(base);
    const targetCov = buildCoverage(target);
    for (const [label, s] of [
      [`#${base.number}`, baseCov],
      [`#${target.number}`, targetCov],
    ] as const)
      for (const [key, g] of s.gaps)
        if (g.truncated)
          warnings.push(
            `Scan ${label} recorded more inconclusive ${sourceLabel(key)} checks than are stored; an affected page that is not in the stored list counts as re-checked.`,
          );
    const trackInfo = new Map(tracks.map((t) => [t.trackId, t]));
    const findingsOf = (s: ComparisonScanInput) => {
      const byId = new Map(s.findings.map((f) => [f.id, f]));
      return (i: ComparisonIssueInput) =>
        i.findingIds.map((id) => byId.get(id)).filter((f): f is ComparisonFindingInput => !!f);
    };
    const baseFindings = findingsOf(base);
    const targetFindings = findingsOf(target);
    const baseByTrack = new Map(base.issues.map((i) => [i.trackId, i]));
    const targetByTrack = new Map(target.issues.map((i) => [i.trackId, i]));
    const trackIds = [...new Set([...targetByTrack.keys(), ...baseByTrack.keys()])];

    for (const trackId of trackIds) {
      const b = baseByTrack.get(trackId) ?? null;
      const t = targetByTrack.get(trackId) ?? null;
      const info = trackInfo.get(trackId);
      const findings = compareFindings(
        b ? baseFindings(b) : [],
        t ? targetFindings(t) : [],
        baseCov,
        targetCov,
      ).sort((x, y) => FINDING_ORDER[x.category] - FINDING_ORDER[y.category]);
      const findingCounts = emptyCounts(FINDING_CHANGE_CATEGORIES);
      for (const f of findings) findingCounts[f.category] += 1;
      const changes: FieldChange[] = [];
      if (b && t) {
        if (b.severity !== t.severity)
          changes.push({ field: "severity", from: b.severity, to: t.severity });
        if (verdictClass(b.verdict) !== verdictClass(t.verdict))
          changes.push({ field: "verdict", from: b.verdict, to: t.verdict });
        const pb = new Set(b.affectedUrls.map((u) => pageKey(u) ?? u));
        const pt = new Set(t.affectedUrls.map((u) => pageKey(u) ?? u));
        if (pb.size !== pt.size || [...pb].some((p) => !pt.has(p)))
          changes.push({
            field: "pages",
            from: plural(pb.size, "page"),
            to: plural(pt.size, "page"),
          });
      }
      const { category, reason } = classify(
        b,
        t,
        info,
        findings,
        findingCounts,
        changes,
        base,
        target,
      );
      const main = t ?? b!;
      if (category !== "changed" && category !== "reopened") changes.length = 0;
      issues.push({
        category,
        trackId,
        displayNo: main.displayNo,
        source: main.category,
        ruleId: main.ruleId,
        title: main.title,
        trackStatus: info?.status ?? null,
        base: b ? issueSide(b) : null,
        target: t ? issueSide(t) : null,
        reason,
        changes,
        findings,
        findingCounts,
      });
    }
    issues.sort(
      (x, y) =>
        CATEGORY_ORDER[x.category] - CATEGORY_ORDER[y.category] ||
        SEVERITY_ORDER[(x.target ?? x.base)!.severity] -
          SEVERITY_ORDER[(y.target ?? y.base)!.severity] ||
        x.displayNo - y.displayNo,
    );
  }

  const counts = emptyCounts(CHANGE_CATEGORIES);
  const findingTotals = emptyCounts(FINDING_CHANGE_CATEGORIES);
  for (const i of issues) {
    counts[i.category] += 1;
    for (const k of FINDING_CHANGE_CATEGORIES) findingTotals[k] += i.findingCounts[k];
  }
  const summary: ComparisonSummary = {
    version: COMPARISON_VERSION,
    comparable,
    counts,
    findings: findingTotals,
    baseIssues: base.issues.length,
    targetIssues: target.issues.length,
    targetUnableToVerify: target.issues.filter((i) => verdictClass(i.verdict) === "inconclusive")
      .length,
    targetNeedsReview: target.issues.filter((i) => i.verdict === "potential").length,
    stepChanges: steps.filter((s) => s.direction !== "same").length,
    warnings: warnings.length,
  };
  return {
    version: COMPARISON_VERSION,
    projectId: base.projectId,
    base: ref(base),
    target: ref(target),
    comparable,
    notComparable,
    warnings,
    summary,
    issues,
    steps,
  };
}

function classify(
  b: ComparisonIssueInput | null,
  t: ComparisonIssueInput | null,
  info: ComparisonTrackInput | undefined,
  findings: FindingComparisonItem[],
  counts: Record<FindingChangeCategory, number>,
  changes: FieldChange[],
  base: ComparisonScanInput,
  target: ComparisonScanInput,
): { category: ChangeCategory; reason: string } {
  const B = `#${base.number}`;
  const T = `#${target.number}`;
  if (t && info?.reopenedByTarget)
    return {
      category: "reopened",
      reason: `It was marked resolved, and scan ${T} found it again, so its status was set to Reopened.`,
    };
  if (b && t) {
    // A different page list alone is not a change: it follows from findings that are new, no
    // longer found (both counted below) or could not be re-checked (not a change).
    if (changes.some((c) => c.field !== "pages") || counts.new || counts.fixed || counts.changed) {
      const parts = changes
        .filter((c) => c.field !== "pages")
        .map((c) =>
          c.field === "verdict"
            ? `verdict ${VERDICT_WORDING[c.from as Verdict]} → ${VERDICT_WORDING[c.to as Verdict]}`
            : `${c.field} ${c.from} → ${c.to}`,
        );
      if (counts.fixed) parts.push(`${plural(counts.fixed, "finding")} no longer found`);
      if (counts.new) parts.push(`${plural(counts.new, "new finding")}`);
      if (counts.changed) parts.push(`${plural(counts.changed, "finding")} with different values`);
      const pages = changes.find((c) => c.field === "pages");
      if (pages) parts.push(`affected pages ${pages.from} → ${pages.to}`);
      return { category: "changed", reason: `Found in both scans; ${parts.join("; ")}.` };
    }
    const measured = findings.some((f) => f.changes.some((c) => c.measurement))
      ? " Measured values differ between the scans (lab measurements vary between page loads)."
      : "";
    return {
      category: "persistent",
      reason:
        (counts.not_rechecked
          ? `Found in both scans with the same findings; ${plural(counts.not_rechecked, "finding")} could not be re-checked by scan ${T}.`
          : "Found in both scans with the same severity, verdict and findings.") + measured,
    };
  }
  if (b) {
    const gaps = findings.filter((f) => f.category === "not_rechecked");
    if (!gaps.length)
      return {
        category: "resolved",
        reason: `Not found by scan ${T}, which re-checked ${counts.fixed === 1 ? "its finding" : `all ${counts.fixed} of its findings`} (same scanner, pages analyzed).`,
      };
    return {
      category: "not_rechecked",
      reason:
        gaps.length === findings.length
          ? `Not found by scan ${T}, but it could not re-check it: ${gaps[0]!.reason}`
          : `Not found by scan ${T}, but ${gaps.length} of ${findings.length} findings could not be re-checked: ${gaps[0]!.reason}`,
    };
  }
  // Only in the target.
  const checkable = findings.filter((f) => f.category === "new");
  if (!checkable.length)
    return {
      category: "newly_checked",
      reason: `Scan ${B} could not have found it: ${findings[0]?.reason ?? "it did not check the same pages"}`,
    };
  if (info?.lastSeenBeforeBase !== null && info?.lastSeenBeforeBase !== undefined)
    return {
      category: "reopened",
      reason: `Found in scan #${info.lastSeenBeforeBase}, not found by scan ${B}, and found again by scan ${T}.`,
    };
  return {
    category: "new",
    reason: `Not found by scan ${B}, which checked the same ${checkable.length === 1 ? "page" : "pages"} with the same scanner.`,
  };
}
