import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import {
  findingVerdictEnum,
  groundingStatusEnum,
  issueOriginEnum,
  issueStatusEnum,
  jobStatusEnum,
  reportFormatEnum,
  severityEnum,
} from "./enums";
import { createdAt, project, updatedAt } from "./projects";
import { page, scan, scannerRun } from "./scans";

/** A deterministic, evidence-backed result produced by a scanner. Never written by AI. */
export const rawFinding = pgTable(
  "raw_finding",
  {
    id: uuid().primaryKey().defaultRandom(),
    scanId: uuid()
      .notNull()
      .references(() => scan.id, { onDelete: "cascade" }),
    scannerRunId: uuid()
      .notNull()
      .references(() => scannerRun.id, { onDelete: "cascade" }),
    pageId: uuid().references(() => page.id, { onDelete: "set null" }),
    /** Human-readable id unique within the scan, e.g. SEO-023. */
    displayId: varchar({ length: 32 }).notNull(),
    scanner: varchar({ length: 64 }).notNull(),
    ruleId: varchar({ length: 128 }).notNull(),
    category: varchar({ length: 64 }).notNull(),
    subcategory: varchar({ length: 64 }),
    title: text().notNull(),
    message: text().notNull(),
    proposedSeverity: severityEnum().notNull(),
    verdict: findingVerdictEnum().notNull(),
    selector: text(),
    viewport: varchar({ length: 32 }),
    confidence: real().notNull(),
    expected: text(),
    actual: text(),
    fingerprint: varchar({ length: 64 }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("raw_finding_scan_display_uq").on(t.scanId, t.displayId),
    index("raw_finding_scan_fingerprint_idx").on(t.scanId, t.fingerprint),
    index("raw_finding_page_idx").on(t.pageId),
  ],
);

export const evidence = pgTable(
  "evidence",
  {
    id: uuid().primaryKey().defaultRandom(),
    rawFindingId: uuid()
      .notNull()
      .references(() => rawFinding.id, { onDelete: "cascade" }),
    kind: varchar({ length: 32 }).notNull(),
    data: jsonb().$type<Record<string, unknown>>().notNull(),
    storageKey: text(),
    createdAt: createdAt(),
  },
  (t) => [index("evidence_finding_idx").on(t.rawFindingId)],
);

/**
 * A problem tracked across scans (keyed by fingerprint). Holds the developer workflow status
 * so "Resolved" or "Ignored" survives rescans, and enables new/resolved/persistent/reopened.
 */
export const issueTrack = pgTable(
  "issue_track",
  {
    id: uuid().primaryKey().defaultRandom(),
    projectId: uuid()
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    /** Stable human-readable number: ISSUE-<displayNo>. */
    displayNo: integer().notNull(),
    fingerprint: varchar({ length: 64 }).notNull(),
    status: issueStatusEnum().notNull().default("open"),
    /** Denormalized from the latest occurrence for fast filtering and counts. */
    severity: severityEnum().notNull(),
    category: varchar({ length: 64 }).notNull(),
    title: text().notNull(),
    firstSeenScanId: uuid().references(() => scan.id, { onDelete: "set null" }),
    lastSeenScanId: uuid().references(() => scan.id, { onDelete: "set null" }),
    resolvedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("issue_track_project_fingerprint_uq").on(t.projectId, t.fingerprint),
    unique("issue_track_project_display_uq").on(t.projectId, t.displayNo),
    index("issue_track_project_status_idx").on(t.projectId, t.status, t.severity),
  ],
);

/** One occurrence of a tracked issue in a specific scan. Immutable once the scan completes. */
export const issue = pgTable(
  "issue",
  {
    id: uuid().primaryKey().defaultRandom(),
    trackId: uuid()
      .notNull()
      .references(() => issueTrack.id, { onDelete: "cascade" }),
    scanId: uuid()
      .notNull()
      .references(() => scan.id, { onDelete: "cascade" }),
    category: varchar({ length: 64 }).notNull(),
    subcategory: varchar({ length: 64 }),
    severity: severityEnum().notNull(),
    title: text().notNull(),
    description: text().notNull(),
    affectedUrls: jsonb().$type<string[]>().notNull(),
    affectedElement: text(),
    expected: text(),
    actual: text(),
    recommendation: text(),
    confidence: real().notNull(),
    origin: issueOriginEnum().notNull(),
    groundingStatus: groundingStatusEnum().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("issue_track_scan_uq").on(t.trackId, t.scanId),
    index("issue_scan_idx").on(t.scanId, t.severity),
  ],
);

/** Every issue must reference at least one real scanner finding (enforced in the service layer). */
export const issueFinding = pgTable(
  "issue_finding",
  {
    issueId: uuid()
      .notNull()
      .references(() => issue.id, { onDelete: "cascade" }),
    rawFindingId: uuid()
      .notNull()
      .references(() => rawFinding.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.issueId, t.rawFindingId] })],
);

export const issueStatusEvent = pgTable(
  "issue_status_event",
  {
    id: uuid().primaryKey().defaultRandom(),
    trackId: uuid()
      .notNull()
      .references(() => issueTrack.id, { onDelete: "cascade" }),
    fromStatus: issueStatusEnum(),
    toStatus: issueStatusEnum().notNull(),
    /** Null when the system changed the status (e.g. reopened by a rescan). */
    userId: text().references(() => user.id, { onDelete: "set null" }),
    note: text(),
    createdAt: createdAt(),
  },
  (t) => [index("issue_status_event_track_idx").on(t.trackId, t.createdAt)],
);

export const groundingCheck = pgTable(
  "grounding_check",
  {
    id: uuid().primaryKey().defaultRandom(),
    issueId: uuid()
      .notNull()
      .references(() => issue.id, { onDelete: "cascade" }),
    checkType: varchar({ length: 64 }).notNull(),
    passed: boolean().notNull(),
    detail: jsonb().$type<Record<string, unknown>>(),
  },
  (t) => [index("grounding_check_issue_idx").on(t.issueId)],
);

export const aiRun = pgTable("ai_run", {
  id: uuid().primaryKey().defaultRandom(),
  scanId: uuid()
    .notNull()
    .references(() => scan.id, { onDelete: "cascade" }),
  provider: varchar({ length: 64 }).notNull(),
  model: varchar({ length: 128 }).notNull(),
  status: jobStatusEnum().notNull(),
  inputTokens: integer(),
  outputTokens: integer(),
  latencyMs: integer(),
  error: text(),
  createdAt: createdAt(),
});

export const report = pgTable(
  "report",
  {
    id: uuid().primaryKey().defaultRandom(),
    scanId: uuid()
      .notNull()
      .references(() => scan.id, { onDelete: "cascade" }),
    format: reportFormatEnum().notNull(),
    status: jobStatusEnum().notNull().default("pending"),
    storageKey: text(),
    sizeBytes: integer(),
    error: text(),
    createdByUserId: text().references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    completedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index("report_scan_idx").on(t.scanId)],
);

/** Cached comparison result; always recomputable from issue/scan records. */
export const scanComparison = pgTable(
  "scan_comparison",
  {
    id: uuid().primaryKey().defaultRandom(),
    projectId: uuid()
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    baseScanId: uuid()
      .notNull()
      .references(() => scan.id, { onDelete: "cascade" }),
    targetScanId: uuid()
      .notNull()
      .references(() => scan.id, { onDelete: "cascade" }),
    summary: jsonb().$type<Record<string, unknown>>().notNull(),
    computedAt: createdAt(),
  },
  (t) => [unique("scan_comparison_pair_uq").on(t.baseScanId, t.targetScanId)],
);
