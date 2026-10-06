import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { scanStatusEnum, stepStatusEnum } from "./enums";
import { createdAt, designSpec, project } from "./projects";

export const scan = pgTable(
  "scan",
  {
    id: uuid().primaryKey().defaultRandom(),
    projectId: uuid()
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    /** Per-project sequence number (Scan #1, #2, ...). */
    number: integer().notNull(),
    status: scanStatusEnum().notNull().default("queued"),
    /** Frozen copy of the scan configuration (scanners, viewports, limits, target URL). */
    configSnapshot: jsonb().$type<Record<string, unknown>>().notNull(),
    designSpecId: uuid().references(() => designSpec.id, { onDelete: "set null" }),
    contentSnapshotHash: varchar({ length: 64 }),
    /** Detected technology with signals and confidence; null until detection ran. */
    technology: jsonb().$type<Record<string, unknown>>(),
    isDemo: boolean().notNull().default(false),
    triggeredByUserId: text().references(() => user.id, { onDelete: "set null" }),
    error: text(),
    /** The scan row is the durable job: the worker claims queued rows with SKIP LOCKED. */
    workerId: varchar({ length: 128 }),
    heartbeatAt: timestamp({ withTimezone: true }),
    cancelRequestedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    startedAt: timestamp({ withTimezone: true }),
    finishedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    unique("scan_project_number_uq").on(t.projectId, t.number),
    index("scan_project_created_idx").on(t.projectId, t.createdAt),
    index("scan_status_created_idx").on(t.status, t.createdAt),
    // At most one queued or running scan per project, enforced by the database (concurrent
    // "Start QA Scan" requests cannot both pass the application check).
    uniqueIndex("scan_one_active_per_project_uq")
      .on(t.projectId)
      .where(sql`status in ('queued', 'running')`),
  ],
);

/** One row per pipeline step: preflight, crawl, capture, each scanner, ai, grounding, report. */
export const scannerRun = pgTable(
  "scanner_run",
  {
    id: uuid().primaryKey().defaultRandom(),
    scanId: uuid()
      .notNull()
      .references(() => scan.id, { onDelete: "cascade" }),
    /** Free text (not an enum) so new scanners can be added without a type migration. */
    stepKey: varchar({ length: 64 }).notNull(),
    position: integer().notNull(),
    status: stepStatusEnum().notNull().default("pending"),
    statusReason: text(),
    error: text(),
    findingCount: integer().notNull().default(0),
    toolName: varchar({ length: 128 }),
    toolVersion: varchar({ length: 64 }),
    /** What the scanner checked: counts and checks that could not be verified (inconclusive). */
    checks: jsonb().$type<Record<string, unknown>>(),
    startedAt: timestamp({ withTimezone: true }),
    finishedAt: timestamp({ withTimezone: true }),
    durationMs: integer(),
  },
  (t) => [unique("scanner_run_scan_step_uq").on(t.scanId, t.stepKey)],
);

export const page = pgTable(
  "page",
  {
    id: uuid().primaryKey().defaultRandom(),
    scanId: uuid()
      .notNull()
      .references(() => scan.id, { onDelete: "cascade" }),
    url: text().notNull(),
    normalizedUrl: text().notNull(),
    finalUrl: text(),
    httpStatus: integer(),
    redirectChain: jsonb().$type<Array<{ url: string; status: number }>>(),
    depth: integer().notNull(),
    discoveredFrom: text(),
    title: text(),
    contentType: varchar({ length: 255 }),
    /** Response headers of the final response (Set-Cookie values redacted, flags kept). */
    responseHeaders: jsonb().$type<Record<string, string | string[]>>(),
    /** Raw HTML as served (before JavaScript), stored as an artifact. */
    rawHtmlKey: text(),
    crawlError: text(),
    createdAt: createdAt(),
  },
  (t) => [unique("page_scan_url_uq").on(t.scanId, t.normalizedUrl)],
);

export const pageCapture = pgTable(
  "page_capture",
  {
    id: uuid().primaryKey().defaultRandom(),
    pageId: uuid()
      .notNull()
      .references(() => page.id, { onDelete: "cascade" }),
    viewport: varchar({ length: 32 }).notNull(),
    width: integer().notNull(),
    height: integer().notNull(),
    screenshotKey: text(),
    domSnapshotKey: text(),
    /** Computed styles of design roles (collected only when the scan has a design reference). */
    computedStylesKey: text(),
    /** Visible text blocks and links (collected only when the scan has content documents). */
    textContentKey: text(),
    consoleMessages: jsonb().$type<Array<Record<string, unknown>>>(),
    timings: jsonb().$type<Record<string, unknown>>(),
    /** In-page measurements: web vitals, layout (overflow, overlaps, tap targets), images. */
    metrics: jsonb().$type<Record<string, unknown>>(),
    error: text(),
    createdAt: createdAt(),
  },
  (t) => [unique("page_capture_page_viewport_uq").on(t.pageId, t.viewport)],
);

export const networkRequest = pgTable(
  "network_request",
  {
    id: uuid().primaryKey().defaultRandom(),
    pageCaptureId: uuid()
      .notNull()
      .references(() => pageCapture.id, { onDelete: "cascade" }),
    url: text().notNull(),
    resourceType: varchar({ length: 32 }).notNull(),
    method: varchar({ length: 16 }).notNull(),
    status: integer(),
    transferSize: bigint({ mode: "number" }),
    decodedSize: bigint({ mode: "number" }),
    durationMs: integer(),
    failureText: text(),
    /** Null: not observable (Playwright does not expose HTTP cache hits). */
    fromCache: boolean(),
    isMixedContent: boolean().notNull().default(false),
  },
  (t) => [index("network_request_capture_idx").on(t.pageCaptureId)],
);
