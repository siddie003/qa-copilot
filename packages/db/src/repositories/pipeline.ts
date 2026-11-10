import { and, asc, count, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import type { Database } from "../client";
import { createHash } from "node:crypto";
import {
  evidence,
  networkRequest,
  page,
  pageCapture,
  project,
  rawFinding,
  scan,
  scannerRun,
} from "../schema";
import { ownedProjects } from "./owned";

export const SCAN_EVENTS_CHANNEL = "scan_events";

type StepStatus = "pending" | "running" | "completed" | "failed" | "inconclusive" | "skipped";

/** Tells listeners (SSE endpoints) that something about this scan changed. */
export async function notifyScan(db: Database, scanId: string) {
  await db.execute(sql`select pg_notify(${SCAN_EVENTS_CHANNEL}, ${scanId})`);
}

export interface NewScanStep {
  stepKey: string;
  status?: StepStatus;
  statusReason?: string;
}

/** Thrown by createScan when the project already has a queued or running scan. */
export class ActiveScanExistsError extends Error {
  constructor() {
    super("A scan of this project is already queued or running");
    this.name = "ActiveScanExistsError";
  }
}

const ACTIVE_SCAN_INDEX = "scan_one_active_per_project_uq";

/** True for the unique violation of the one-active-scan-per-project index (drizzle wraps it). */
function isActiveScanConflict(err: unknown): boolean {
  for (let e = err as { code?: unknown; constraint?: unknown; cause?: unknown } | undefined; e;) {
    if (e.code === "23505" && e.constraint === ACTIVE_SCAN_INDEX) return true;
    e = e.cause as typeof e;
  }
  return false;
}

/**
 * Creates a queued scan with its pipeline steps in one transaction. The per-project scan number
 * comes from an atomic counter update. Returns null if the project is not owned by the user;
 * throws ActiveScanExistsError if another scan of the project is queued or running (enforced by
 * a unique index, so concurrent requests cannot both succeed).
 */
export async function createScan(
  db: Database,
  ownerId: string,
  projectId: string,
  values: {
    configSnapshot: Record<string, unknown>;
    steps: NewScanStep[];
    triggeredByUserId: string;
    /** Frozen reference inputs: confirmed design spec version and content documents hash. */
    designSpecId?: string | null;
    contentSnapshotHash?: string | null;
  },
) {
  let created;
  try {
    created = await db.transaction(async (tx) => {
      const [counter] = await tx
        .update(project)
        .set({ scanCounter: sql`${project.scanCounter} + 1` })
        .where(and(eq(project.id, projectId), ownedProjects(ownerId)))
        .returning({ number: project.scanCounter, isDemo: project.isDemo });
      if (!counter) return null;
      const [row] = await tx
        .insert(scan)
        .values({
          projectId,
          number: counter.number,
          status: "queued",
          configSnapshot: values.configSnapshot,
          isDemo: counter.isDemo,
          triggeredByUserId: values.triggeredByUserId,
          designSpecId: values.designSpecId ?? null,
          contentSnapshotHash: values.contentSnapshotHash ?? null,
        })
        .returning();
      await tx.insert(scannerRun).values(
        values.steps.map((s, i) => ({
          scanId: row!.id,
          stepKey: s.stepKey,
          position: i + 1,
          status: s.status ?? ("pending" as const),
          statusReason: s.statusReason ?? null,
        })),
      );
      return row!;
    });
  } catch (err) {
    if (isActiveScanConflict(err)) throw new ActiveScanExistsError();
    throw err;
  }
  if (created) await db.execute(sql`select pg_notify('scan_queued', ${created.id})`);
  return created;
}

/** True if the project already has a scan that is queued or running. */
export async function hasActiveScan(db: Database, projectId: string) {
  const [row] = await db
    .select({ n: count() })
    .from(scan)
    .where(and(eq(scan.projectId, projectId), inArray(scan.status, ["queued", "running"])));
  return (row?.n ?? 0) > 0;
}

/**
 * Atomically claims the oldest queued scan for this worker (FOR UPDATE SKIP LOCKED), so several
 * workers can run safely in parallel. Returns null when there is nothing to do.
 */
export async function claimNextScan(db: Database, workerId: string) {
  const rows = await db.execute<{ id: string }>(sql`
    update ${scan} set status = 'running', worker_id = ${workerId}, started_at = now(), heartbeat_at = now()
    where id = (
      select id from ${scan} where status = 'queued' and cancel_requested_at is null
      order by created_at for update skip locked limit 1
    )
    returning id`);
  const id = rows.rows[0]?.id;
  if (!id) return null;
  const [row] = await db.select().from(scan).where(eq(scan.id, id));
  await notifyScan(db, id);
  return row ?? null;
}

/**
 * Heartbeat; returns whether cancellation was requested. `lost` means the scan is no longer
 * running under this worker (e.g. it was recovered as stale by another worker after a database
 * outage): the caller must stop and must not write its results.
 */
export async function heartbeat(db: Database, scanId: string, workerId?: string | null) {
  const [row] = await db
    .update(scan)
    .set({ heartbeatAt: sql`now()` })
    .where(
      and(
        eq(scan.id, scanId),
        eq(scan.status, "running"),
        workerId ? eq(scan.workerId, workerId) : undefined,
      ),
    )
    .returning({ cancelRequestedAt: scan.cancelRequestedAt });
  return { cancelRequested: Boolean(row?.cancelRequestedAt), lost: !row };
}

/** Cancels queued scans immediately; running scans are cancelled by their worker. Owner-checked. */
export async function requestCancel(db: Database, ownerId: string, scanId: string) {
  const [target] = await db
    .select({ id: scan.id, status: scan.status })
    .from(scan)
    .innerJoin(project, eq(project.id, scan.projectId))
    .where(and(eq(scan.id, scanId), ownedProjects(ownerId)));
  if (!target) return null;
  if (target.status === "queued") {
    await db.transaction(async (tx) => {
      await tx
        .update(scan)
        .set({ status: "cancelled", cancelRequestedAt: sql`now()`, finishedAt: sql`now()` })
        .where(eq(scan.id, scanId));
      await tx
        .update(scannerRun)
        .set({ status: "skipped", statusReason: "Scan cancelled before it started" })
        .where(and(eq(scannerRun.scanId, scanId), eq(scannerRun.status, "pending")));
    });
  } else if (target.status === "running") {
    await db
      .update(scan)
      .set({ cancelRequestedAt: sql`now()` })
      .where(eq(scan.id, scanId));
  }
  await notifyScan(db, scanId);
  const [after] = await db.select({ status: scan.status }).from(scan).where(eq(scan.id, scanId));
  return { status: after!.status, previousStatus: target.status };
}

export async function updateStep(
  db: Database,
  scanId: string,
  stepKey: string,
  patch: {
    status: StepStatus;
    statusReason?: string | null;
    error?: string | null;
    findingCount?: number;
    toolName?: string | null;
    toolVersion?: string | null;
    checks?: Record<string, unknown> | null;
    started?: boolean;
    finished?: boolean;
  },
) {
  await db
    .update(scannerRun)
    .set({
      status: patch.status,
      ...(patch.statusReason !== undefined ? { statusReason: patch.statusReason } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {}),
      ...(patch.findingCount !== undefined ? { findingCount: patch.findingCount } : {}),
      ...(patch.toolName !== undefined ? { toolName: patch.toolName } : {}),
      ...(patch.toolVersion !== undefined ? { toolVersion: patch.toolVersion } : {}),
      ...(patch.checks !== undefined ? { checks: patch.checks } : {}),
      ...(patch.started ? { startedAt: sql`now()` } : {}),
      ...(patch.finished
        ? {
            finishedAt: sql`now()`,
            durationMs: sql`(extract(epoch from (now() - coalesce(${scannerRun.startedAt}, now()))) * 1000)::int`,
          }
        : {}),
    })
    .where(and(eq(scannerRun.scanId, scanId), eq(scannerRun.stepKey, stepKey)));
  await notifyScan(db, scanId);
}

/** Step keys of a scan that are still waiting to run. */
export async function pendingStepKeys(db: Database, scanId: string) {
  const rows = await db
    .select({ stepKey: scannerRun.stepKey })
    .from(scannerRun)
    .where(and(eq(scannerRun.scanId, scanId), eq(scannerRun.status, "pending")));
  return new Set(rows.map((r) => r.stepKey));
}

/** Marks steps that are still `running` as failed (the scan stopped while they ran). */
export async function failRunningSteps(db: Database, scanId: string, error: string) {
  await db
    .update(scannerRun)
    .set({
      status: "failed",
      error,
      finishedAt: sql`now()`,
      durationMs: sql`(extract(epoch from (now() - coalesce(${scannerRun.startedAt}, now()))) * 1000)::int`,
    })
    .where(and(eq(scannerRun.scanId, scanId), eq(scannerRun.status, "running")));
}

/** Marks every still-pending step as skipped with a reason (e.g. after a fatal failure). */
export async function skipPendingSteps(db: Database, scanId: string, reason: string) {
  await db
    .update(scannerRun)
    .set({ status: "skipped", statusReason: reason })
    .where(and(eq(scannerRun.scanId, scanId), eq(scannerRun.status, "pending")));
  await notifyScan(db, scanId);
}

/**
 * Records the final status of a running scan. Only a scan that is still `running` changes (and,
 * with `workerId`, only while this worker owns it), so a scan that was recovered or finished
 * elsewhere is never overwritten. Returns whether the scan was updated.
 */
export async function finishScan(
  db: Database,
  scanId: string,
  status: "completed" | "completed_with_failures" | "failed" | "cancelled",
  error?: string | null,
  workerId?: string | null,
) {
  const rows = await db
    .update(scan)
    .set({ status, finishedAt: sql`now()`, error: error ?? null })
    .where(
      and(
        eq(scan.id, scanId),
        eq(scan.status, "running"),
        workerId ? eq(scan.workerId, workerId) : undefined,
      ),
    )
    .returning({ id: scan.id });
  await notifyScan(db, scanId);
  return rows.length > 0;
}

export async function setTechnology(
  db: Database,
  scanId: string,
  technology: Record<string, unknown>,
) {
  await db.update(scan).set({ technology }).where(eq(scan.id, scanId));
}

/**
 * Scans whose worker stopped sending heartbeats (crash, restart, a worker that never came back)
 * are marked failed so they never stay "running" forever and never block the project's next
 * scan. Safe to run periodically and from several workers at once: each scan is re-checked and
 * updated in its own transaction, so a scan is recovered once and a live scan is never touched.
 * Returns the ids that were recovered.
 */
export async function failStaleScans(db: Database, staleAfterMs: number) {
  const staleBefore = sql`now() - (${staleAfterMs} || ' milliseconds')::interval`;
  const candidates = await db
    .select({ id: scan.id })
    .from(scan)
    .where(and(eq(scan.status, "running"), lt(scan.heartbeatAt, staleBefore)));
  const recovered: string[] = [];
  for (const { id } of candidates) {
    const done = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(scan)
        .set({
          status: "failed",
          finishedAt: sql`now()`,
          error: "The worker stopped responding during this scan. Start a new scan.",
        })
        .where(and(eq(scan.id, id), eq(scan.status, "running"), lt(scan.heartbeatAt, staleBefore)))
        .returning({ id: scan.id });
      if (!row) return false;
      await tx
        .update(scannerRun)
        .set({
          status: "failed",
          error: "Worker stopped while this step was running",
          finishedAt: sql`now()`,
        })
        .where(and(eq(scannerRun.scanId, id), eq(scannerRun.status, "running")));
      await tx
        .update(scannerRun)
        .set({ status: "skipped", statusReason: "Scan was interrupted (worker stopped)" })
        .where(and(eq(scannerRun.scanId, id), eq(scannerRun.status, "pending")));
      return true;
    });
    if (done) {
      recovered.push(id);
      await notifyScan(db, id);
    }
  }
  return recovered;
}

export interface NewPage {
  /** Optional pre-generated id so artifact keys can be derived before the insert. */
  id?: string;
  url: string;
  normalizedUrl: string;
  finalUrl: string | null;
  httpStatus: number | null;
  redirectChain: Array<{ url: string; status: number }> | null;
  depth: number;
  discoveredFrom: string | null;
  /** "user" for page links the user added; "crawl" (default) for everything else. */
  origin?: "crawl" | "user";
  title: string | null;
  contentType: string | null;
  responseHeaders: Record<string, string | string[]> | null;
  rawHtmlKey: string | null;
  crawlError: string | null;
}

export async function insertPage(db: Database, scanId: string, values: NewPage) {
  const [row] = await db
    .insert(page)
    .values({ scanId, ...values })
    .onConflictDoNothing({ target: [page.scanId, page.normalizedUrl] })
    .returning({ id: page.id });
  return row?.id ?? null;
}

export async function setPageRawHtmlKey(db: Database, pageId: string, key: string) {
  await db.update(page).set({ rawHtmlKey: key }).where(eq(page.id, pageId));
}

/** Pages to capture with the browser: same-site HTML pages that returned < 400. */
export async function listCapturablePages(db: Database, scanId: string) {
  return db
    .select({
      id: page.id,
      url: page.url,
      finalUrl: page.finalUrl,
      redirectChain: page.redirectChain,
    })
    .from(page)
    .where(
      and(
        eq(page.scanId, scanId),
        isNull(page.crawlError),
        lt(page.httpStatus, 400),
        sql`(${page.contentType} ilike 'text/html%' or ${page.contentType} ilike 'application/xhtml%')`,
      ),
    )
    .orderBy(asc(page.depth), asc(page.createdAt));
}

export async function insertCapture(
  db: Database,
  values: {
    pageId: string;
    viewport: string;
    width: number;
    height: number;
    screenshotKey: string | null;
    domSnapshotKey: string | null;
    computedStylesKey?: string | null;
    textContentKey?: string | null;
    qualityKey?: string | null;
    consoleMessages: Array<Record<string, unknown>>;
    timings: Record<string, unknown>;
    metrics: Record<string, unknown> | null;
    error: string | null;
    requests: Array<{
      url: string;
      resourceType: string;
      method: string;
      status: number | null;
      transferSize: number | null;
      decodedSize: number | null;
      durationMs: number | null;
      failureText: string | null;
      fromCache: boolean | null;
      isMixedContent: boolean;
    }>;
  },
) {
  const { requests, ...capture } = values;
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(pageCapture).values(capture).returning({ id: pageCapture.id });
    for (let i = 0; i < requests.length; i += 500) {
      const batch = requests
        .slice(i, i + 500)
        .map((r) => ({ ...r, url: r.url.slice(0, 4000), pageCaptureId: row!.id }));
      if (batch.length) await tx.insert(networkRequest).values(batch);
    }
    return row!.id;
  });
}

export async function countPages(db: Database, scanId: string) {
  const [row] = await db.select({ n: count() }).from(page).where(eq(page.scanId, scanId));
  return row?.n ?? 0;
}

/** Full scan view for the UI/API (owner-checked): scan, steps, page and capture counts. */
export async function getScanDetail(db: Database, ownerId: string, scanId: string) {
  const [row] = await db
    .select({
      id: scan.id,
      number: scan.number,
      status: scan.status,
      projectId: scan.projectId,
      projectName: project.name,
      configSnapshot: scan.configSnapshot,
      technology: scan.technology,
      error: scan.error,
      cancelRequestedAt: scan.cancelRequestedAt,
      createdAt: scan.createdAt,
      startedAt: scan.startedAt,
      finishedAt: scan.finishedAt,
      isDemo: scan.isDemo,
    })
    .from(scan)
    .innerJoin(project, eq(project.id, scan.projectId))
    .where(and(eq(scan.id, scanId), ownedProjects(ownerId)));
  if (!row) return null;
  const [runs, [pages], [captures]] = await Promise.all([
    db
      .select()
      .from(scannerRun)
      .where(eq(scannerRun.scanId, scanId))
      .orderBy(asc(scannerRun.position)),
    db.select({ n: count() }).from(page).where(eq(page.scanId, scanId)),
    db
      .select({ n: count() })
      .from(pageCapture)
      .innerJoin(page, eq(page.id, pageCapture.pageId))
      .where(eq(page.scanId, scanId)),
  ]);
  return { ...row, runs, pageCount: pages?.n ?? 0, captureCount: captures?.n ?? 0 };
}

/** Captures (screenshots per viewport) for the pages of a scan, owner-checked. */
export async function listCapturesForScan(db: Database, ownerId: string, scanId: string) {
  return db
    .select({
      pageId: page.id,
      url: page.url,
      viewport: pageCapture.viewport,
      width: pageCapture.width,
      height: pageCapture.height,
      screenshotKey: pageCapture.screenshotKey,
      error: pageCapture.error,
    })
    .from(pageCapture)
    .innerJoin(page, eq(page.id, pageCapture.pageId))
    .innerJoin(scan, eq(scan.id, page.scanId))
    .innerJoin(project, eq(project.id, scan.projectId))
    .where(and(eq(scan.id, scanId), ownedProjects(ownerId)))
    .orderBy(asc(page.depth), asc(page.url), asc(pageCapture.viewport));
}

/** Resolves which scan an artifact key belongs to and whether the user may read it. */
export async function canReadScanArtifacts(db: Database, ownerId: string, scanId: string) {
  const [row] = await db
    .select({ id: scan.id })
    .from(scan)
    .innerJoin(project, eq(project.id, scan.projectId))
    .where(and(eq(scan.id, scanId), ownedProjects(ownerId)));
  return Boolean(row);
}

export async function latestScanIdForProject(db: Database, projectId: string) {
  const [row] = await db
    .select({ id: scan.id })
    .from(scan)
    .where(eq(scan.projectId, projectId))
    .orderBy(desc(scan.createdAt))
    .limit(1);
  return row?.id ?? null;
}

export interface NewFinding {
  ruleId: string;
  title: string;
  message: string;
  category: string;
  subcategory: string | null;
  pageId: string | null;
  /** Site-relative identity of the page/URL the finding belongs to (for fingerprints). */
  locationKey: string;
  selector: string | null;
  viewport: string | null;
  severity: "critical" | "high" | "medium" | "low" | "info";
  verdict: "confirmed" | "potential" | "inconclusive" | "unable_to_verify";
  confidence: number;
  expected: string | null;
  actual: string | null;
  fingerprintKey: string | null;
  evidence: Array<{ kind: string; data: Record<string, unknown>; storageKey?: string | null }>;
}

/**
 * Stable identity of a finding across scans: scanner, rule, location and element. Used later to
 * classify issues as new / persistent / resolved / reopened.
 */
export function findingFingerprint(
  scanner: string,
  f: Pick<NewFinding, "ruleId" | "locationKey" | "selector" | "viewport" | "fingerprintKey">,
) {
  const viewportClass = f.viewport ? (/mobile|phone/i.test(f.viewport) ? "touch" : f.viewport) : "";
  return createHash("sha256")
    .update(
      [scanner, f.ruleId, f.locationKey, f.fingerprintKey ?? f.selector ?? "", viewportClass].join(
        "\n",
      ),
    )
    .digest("hex");
}

/** Inserts a scanner's findings and their evidence in one transaction; returns display ids. */
export async function insertFindings(
  db: Database,
  scanId: string,
  scanner: string,
  idPrefix: string,
  findings: NewFinding[],
) {
  if (!findings.length) return [];
  return db.transaction(async (tx) => {
    const [run] = await tx
      .select({ id: scannerRun.id })
      .from(scannerRun)
      .where(and(eq(scannerRun.scanId, scanId), eq(scannerRun.stepKey, scanner)));
    if (!run) throw new Error(`No pipeline step ${scanner} for scan ${scanId}`);
    const rows = await tx
      .insert(rawFinding)
      .values(
        findings.map((f, i) => ({
          scanId,
          scannerRunId: run.id,
          pageId: f.pageId,
          displayId: `${idPrefix}-${String(i + 1).padStart(3, "0")}`,
          scanner,
          ruleId: f.ruleId,
          category: f.category,
          subcategory: f.subcategory,
          title: f.title.slice(0, 300),
          message: f.message,
          proposedSeverity: f.severity,
          verdict: f.verdict,
          selector: f.selector,
          viewport: f.viewport,
          confidence: f.confidence,
          expected: f.expected,
          actual: f.actual,
          fingerprint: findingFingerprint(scanner, f),
        })),
      )
      .returning({ id: rawFinding.id, displayId: rawFinding.displayId });
    const evidenceRows = rows.flatMap((r, i) =>
      findings[i]!.evidence.map((e) => ({
        rawFindingId: r.id,
        kind: e.kind,
        data: e.data,
        storageKey: e.storageKey ?? null,
      })),
    );
    for (let i = 0; i < evidenceRows.length; i += 500)
      await tx.insert(evidence).values(evidenceRows.slice(i, i + 500));
    return rows.map((r) => r.displayId);
  });
}

/** Stored outcome of one step of a scan (read by later steps that cross-reference it). */
export async function getStepResult(db: Database, scanId: string, stepKey: string) {
  const [row] = await db
    .select({
      status: scannerRun.status,
      statusReason: scannerRun.statusReason,
      error: scannerRun.error,
      findingCount: scannerRun.findingCount,
      checks: scannerRun.checks,
    })
    .from(scannerRun)
    .where(and(eq(scannerRun.scanId, scanId), eq(scannerRun.stepKey, stepKey)));
  return row ?? null;
}

/** Everything scanners need about a scan's pages: headers, artifact keys, captures, requests. */
export async function loadScanData(db: Database, scanId: string) {
  const pages = await db
    .select()
    .from(page)
    .where(eq(page.scanId, scanId))
    .orderBy(asc(page.depth), asc(page.createdAt));
  const captures = pages.length
    ? await db
        .select()
        .from(pageCapture)
        .where(
          inArray(
            pageCapture.pageId,
            pages.map((p) => p.id),
          ),
        )
    : [];
  const requests = captures.length
    ? await db
        .select()
        .from(networkRequest)
        .where(
          inArray(
            networkRequest.pageCaptureId,
            captures.map((c) => c.id),
          ),
        )
    : [];
  return { pages, captures, requests };
}

const SEVERITY_VALUES = ["critical", "high", "medium", "low", "info"] as const;
type SeverityValue = (typeof SEVERITY_VALUES)[number];

type FindingFilter = { scanner?: string; severity?: string[] };

function findingConditions(scanId: string, filter: FindingFilter) {
  const conditions = [eq(rawFinding.scanId, scanId)];
  if (filter.scanner) conditions.push(eq(rawFinding.scanner, filter.scanner));
  const severities = (filter.severity ?? []).filter((s): s is SeverityValue =>
    (SEVERITY_VALUES as readonly string[]).includes(s),
  );
  if (severities.length) conditions.push(inArray(rawFinding.proposedSeverity, severities));
  return and(...conditions);
}

const EVIDENCE_ID_CHUNK = 10_000;

const FINDING_ORDER = [
  asc(rawFinding.proposedSeverity),
  asc(rawFinding.scanner),
  asc(rawFinding.displayId),
];

/**
 * Display ids of a scan's findings in list order (owner-checked): cheap enough for thousands of
 * findings, used to count and to find the page a linked finding is on.
 */
export async function listFindingDisplayIds(
  db: Database,
  ownerId: string,
  scanId: string,
  filter: FindingFilter = {},
) {
  if (!(await canReadScanArtifacts(db, ownerId, scanId))) return null;
  const rows = await db
    .select({ displayId: rawFinding.displayId })
    .from(rawFinding)
    .where(findingConditions(scanId, filter))
    .orderBy(...FINDING_ORDER);
  return rows.map((r) => r.displayId);
}

/**
 * Raw findings of a scan (owner-checked) with their evidence, for the findings view and API.
 * `paging` returns one slice in list order (the view shows 100 per page).
 */
export async function listFindingsForScan(
  db: Database,
  ownerId: string,
  scanId: string,
  filter: FindingFilter = {},
  paging?: { offset: number; limit: number },
) {
  if (!(await canReadScanArtifacts(db, ownerId, scanId))) return null;
  const where = findingConditions(scanId, filter);
  const query = db
    .select({
      id: rawFinding.id,
      displayId: rawFinding.displayId,
      scanner: rawFinding.scanner,
      ruleId: rawFinding.ruleId,
      category: rawFinding.category,
      subcategory: rawFinding.subcategory,
      title: rawFinding.title,
      message: rawFinding.message,
      severity: rawFinding.proposedSeverity,
      verdict: rawFinding.verdict,
      selector: rawFinding.selector,
      viewport: rawFinding.viewport,
      confidence: rawFinding.confidence,
      expected: rawFinding.expected,
      actual: rawFinding.actual,
      pageUrl: page.url,
    })
    .from(rawFinding)
    .leftJoin(page, eq(page.id, rawFinding.pageId))
    .where(where)
    .orderBy(...FINDING_ORDER);
  const rows = paging ? await query.limit(paging.limit).offset(paging.offset) : await query;
  const columns = {
    rawFindingId: evidence.rawFindingId,
    kind: evidence.kind,
    data: evidence.data,
    storageKey: evidence.storageKey,
  };
  // Ids in chunks: one list for a whole very large scan could exceed PostgreSQL's 65,535
  // parameters. (Evidence keeps the stored order, as before.)
  const ev = [];
  for (let i = 0; i < rows.length; i += EVIDENCE_ID_CHUNK)
    ev.push(
      ...(await db
        .select(columns)
        .from(evidence)
        .where(
          inArray(
            evidence.rawFindingId,
            rows.slice(i, i + EVIDENCE_ID_CHUNK).map((r) => r.id),
          ),
        )),
    );
  const byFinding = new Map<
    string,
    Array<{ kind: string; data: unknown; storageKey: string | null }>
  >();
  for (const e of ev) {
    const list = byFinding.get(e.rawFindingId) ?? [];
    list.push({ kind: e.kind, data: e.data, storageKey: e.storageKey });
    byFinding.set(e.rawFindingId, list);
  }
  return rows.map((r) => ({ ...r, evidence: byFinding.get(r.id) ?? [] }));
}

/** Finding counts per scanner and severity for a scan. */
export async function findingCounts(db: Database, scanId: string) {
  return db
    .select({ scanner: rawFinding.scanner, severity: rawFinding.proposedSeverity, n: count() })
    .from(rawFinding)
    .where(eq(rawFinding.scanId, scanId))
    .groupBy(rawFinding.scanner, rawFinding.proposedSeverity);
}
