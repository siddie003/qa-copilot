import "server-only";
import {
  AppError,
  compareScans,
  notFound,
  REPORTABLE_SCAN_STATUSES,
  validationError,
  type ComparisonSummary,
  type ScanComparisonResult,
} from "@qa/core";
import { comparisonsRepo, getDb, type Database, type HistoryScan } from "@qa/db";
import { z } from "zod";
import { getProject } from "./projects";

/**
 * Scan history and comparison (Phase 9). Comparisons are computed from the stored records of two
 * finished scans of one project (`compareScans`); the summary is cached in `scan_comparison`.
 */

const uuid = z.uuid();
const FINISHED = new Set<string>(REPORTABLE_SCAN_STATUSES);

const isComparable = comparisonsRepo.isComparable;

/** Computes the comparison of two scans (both already owner-checked and in one project). */
async function computeComparison(
  db: Database,
  projectId: string,
  base: HistoryScan,
  target: HistoryScan,
): Promise<ScanComparisonResult> {
  const [b, t] = await Promise.all([
    comparisonsRepo.loadComparisonScan(db, base.id),
    comparisonsRepo.loadComparisonScan(db, target.id),
  ]);
  if (!b || !t) throw notFound("Scan");
  const trackIds = [...new Set([...b.issues, ...t.issues].map((i) => i.trackId))];
  const tracks = await comparisonsRepo.loadComparisonTracks(db, trackIds, base, target);
  const result = compareScans(b, t, tracks);
  await comparisonsRepo.saveSummary(db, projectId, base.id, target.id, result.summary);
  return result;
}

function assertComparablePair(base: HistoryScan, target: HistoryScan) {
  if (base.id === target.id) throw validationError("Choose two different scans to compare");
  if (base.number > target.number)
    throw validationError(
      `The base scan must be older than the target scan (scan #${base.number} is newer than scan #${target.number})`,
    );
  for (const s of [base, target])
    if (!FINISHED.has(s.status))
      throw new AppError(
        "CONFLICT",
        `Scan #${s.number} has not finished yet; it can be compared once it is done`,
      );
}

export interface ComparisonPair {
  /** Every scan of the project, newest first (for the scan pickers). */
  scans: HistoryScan[];
  base: HistoryScan | null;
  target: HistoryScan | null;
  /** Why no pair could be chosen automatically (no or only one comparable scan). */
  missing: string | null;
}

/**
 * Resolves the scans to compare. Explicit ids must belong to the project (else 404). Without a
 * target, the latest scan with issue records is used; without a base, the latest such scan
 * before the target.
 */
export async function resolvePair(
  userId: string,
  projectId: string,
  params: { base?: string | null; target?: string | null },
): Promise<ComparisonPair> {
  const project = await getProject(userId, projectId);
  const scans = await comparisonsRepo.listProjectScans(getDb(), userId, project.id);
  const byId = (id: string | null | undefined, label: string) => {
    if (!id) return null;
    if (!uuid.safeParse(id).success) throw notFound(label);
    const s = scans.find((x) => x.id === id);
    if (!s) throw notFound(label);
    return s;
  };
  let target = byId(params.target, "Target scan");
  let base = byId(params.base, "Base scan");
  target ??= scans.find((s) => isComparable(s) && (!base || s.number > base.number)) ?? null;
  if (target && !base)
    base = scans.find((s) => s.number < target!.number && isComparable(s)) ?? null;
  const comparableCount = scans.filter(isComparable).length;
  const missing =
    base && target
      ? null
      : comparableCount === 0
        ? "No finished scan with issue records yet. Run a scan; the next one can be compared with it."
        : "Only one finished scan with issue records so far. Run another scan to compare the two.";
  return { scans, base, target, missing };
}

/** Full comparison of two scans of a project (owner-checked). */
export async function compareProjectScans(
  userId: string,
  projectId: string,
  baseId: string,
  targetId: string,
): Promise<ScanComparisonResult> {
  const pair = await resolvePair(userId, projectId, { base: baseId, target: targetId });
  assertComparablePair(pair.base!, pair.target!);
  return computeComparison(getDb(), projectId, pair.base!, pair.target!);
}

/** Comparison for the pair chosen by `resolvePair` (defaults included); null when there is none. */
export async function comparePair(projectId: string, pair: ComparisonPair) {
  if (!pair.base || !pair.target) return null;
  assertComparablePair(pair.base, pair.target);
  return computeComparison(getDb(), projectId, pair.base, pair.target);
}

export interface HistoryItem extends HistoryScan {
  comparable: boolean;
  /** The scan this one is compared with: the latest earlier finished scan with issue records. */
  previous: { id: string; number: number } | null;
  changes: ComparisonSummary | null;
  breakdown: {
    severity: Record<string, number>;
    confirmed: number;
    needsReview: number;
    unableToVerify: number;
  } | null;
}

export const TREND_SCANS = 20;

/**
 * Scan history of a project: each scan with its issue counts and its changes compared with the
 * previous comparable scan (cached summaries; missing ones are computed once and stored), plus
 * the trend over the latest comparable scans.
 */
export async function projectHistory(
  userId: string,
  projectId: string,
  opts: { page: number; pageSize: number },
) {
  const project = await getProject(userId, projectId);
  const db = getDb();
  const scans = await comparisonsRepo.listProjectScans(db, userId, project.id);
  const previousOf = (s: HistoryScan) =>
    scans.find((p) => p.number < s.number && isComparable(p)) ?? null;
  const pageItems = scans.slice((opts.page - 1) * opts.pageSize, opts.page * opts.pageSize);
  const trendScans = scans.filter(isComparable).slice(0, TREND_SCANS).reverse();
  const wanted = [...new Map([...pageItems, ...trendScans].map((s) => [s.id, s])).values()];

  const pairs = wanted
    .filter(isComparable)
    .map((s) => ({ target: s, base: previousOf(s) }))
    .filter((p): p is { target: HistoryScan; base: HistoryScan } => p.base !== null);
  const cached = await comparisonsRepo.cachedSummaries(
    db,
    pairs.map((p) => ({ baseScanId: p.base.id, targetScanId: p.target.id })),
  );
  const summaries = new Map<string, ComparisonSummary>();
  for (const p of pairs) {
    const key = `${p.base.id}:${p.target.id}`;
    summaries.set(
      p.target.id,
      cached.get(key) ?? (await computeComparison(db, project.id, p.base, p.target)).summary,
    );
  }
  const breakdown = await comparisonsRepo.issueBreakdown(
    db,
    wanted.map((s) => s.id),
  );
  const item = (s: HistoryScan): HistoryItem => {
    const previous = isComparable(s) ? previousOf(s) : null;
    return {
      ...s,
      comparable: isComparable(s),
      previous: previous ? { id: previous.id, number: previous.number } : null,
      changes: summaries.get(s.id) ?? null,
      breakdown: isComparable(s) ? (breakdown.get(s.id) ?? emptyBreakdown()) : null,
    };
  };
  return {
    project,
    /** Every scan of the project, newest first (scan pickers). */
    scans,
    total: scans.length,
    comparableCount: scans.filter(isComparable).length,
    items: pageItems.map(item),
    trend: trendScans.map(item),
  };
}

const emptyBreakdown = () => ({ severity: {}, confirmed: 0, needsReview: 0, unableToVerify: 0 });

/** The scan a finished scan is compared with by default (for "Compare with previous scan"). */
export async function previousComparable(projectId: string, scan: { number: number }) {
  return comparisonsRepo.previousComparableScan(getDb(), projectId, scan.number);
}
