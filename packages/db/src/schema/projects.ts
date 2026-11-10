import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { ScanDefaults } from "@qa/core";
import { user } from "./auth";
import {
  contentBlockTypeEnum,
  parseStatusEnum,
  referenceKindEnum,
  referenceStatusEnum,
} from "./enums";

export const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
// Both timestamps come from the database clock (not the app server's) so they stay comparable.
export const updatedAt = () =>
  timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => sql`now()`);

export const project = pgTable(
  "project",
  {
    id: uuid().primaryKey().defaultRandom(),
    ownerId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: varchar({ length: 120 }).notNull(),
    websiteUrl: text().notNull(),
    /** Demo projects live in the separate demo workspace and are excluded from real dashboards. */
    isDemo: boolean().notNull().default(false),
    scanDefaults: jsonb().$type<ScanDefaults>().notNull(),
    /** Per-project counters for human-readable numbers (Scan #3, ISSUE-104), incremented atomically. */
    scanCounter: integer().notNull().default(0),
    issueCounter: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index("project_owner_idx")
      .on(t.ownerId, t.createdAt)
      .where(sql`${t.deletedAt} is null`),
  ],
);

export const referenceSource = pgTable(
  "reference_source",
  {
    id: uuid().primaryKey().defaultRandom(),
    projectId: uuid()
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    kind: referenceKindEnum().notNull(),
    figmaUrl: text(),
    figmaFileKey: text(),
    figmaNodeIds: jsonb().$type<string[]>(),
    /** Uploaded guideline document (kind = guideline_document). */
    storageKey: text(),
    status: referenceStatusEnum().notNull().default("pending"),
    error: text(),
    /** File details (guideline documents) and the extraction report (what was read / skipped). */
    meta: jsonb().$type<Record<string, unknown>>(),
    /** Heartbeat while a worker processes the reference (stale values are recovered). */
    processingStartedAt: timestamp({ withTimezone: true }),
    fetchedAt: timestamp({ withTimezone: true }),
    /** When ready: completed | completed_with_warnings | partial. */
    outcome: varchar({ length: 32 }),
    /**
     * Figma processing manifest: file identity and version, pages discovered/processed/failed
     * with their frames, request counts, rate-limit details, warnings, timestamps.
     */
    manifest: jsonb().$type<Record<string, unknown>>(),
    /** Resume state of an interrupted Figma read (pinned version, pages still to read). */
    checkpoint: jsonb().$type<Record<string, unknown>>(),
    attempts: integer().notNull().default(0),
    cancelRequestedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("reference_source_project_idx").on(t.projectId)],
);

/** Versioned, normalized design tokens. Every value carries its provenance inside `tokens`. */
export const designSpec = pgTable(
  "design_spec",
  {
    id: uuid().primaryKey().defaultRandom(),
    projectId: uuid()
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    referenceSourceId: uuid().references(() => referenceSource.id, { onDelete: "set null" }),
    version: integer().notNull(),
    tokens: jsonb().$type<Record<string, unknown>>().notNull(),
    /** Values extracted from documents are drafts until the user confirms them. */
    confirmedByUser: boolean().notNull().default(false),
    /** How this version was produced: manual | figma | document. */
    origin: varchar({ length: 32 }).notNull().default("manual"),
    createdByUserId: text().references(() => user.id, { onDelete: "set null" }),
    confirmedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [unique("design_spec_project_version_uq").on(t.projectId, t.version)],
);

export const contentDocument = pgTable(
  "content_document",
  {
    id: uuid().primaryKey().defaultRandom(),
    projectId: uuid()
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    filename: varchar({ length: 255 }).notNull(),
    mimeType: varchar({ length: 127 }).notNull(),
    sizeBytes: integer().notNull(),
    sha256: varchar({ length: 64 }).notNull(),
    storageKey: text().notNull(),
    parseStatus: parseStatusEnum().notNull().default("pending"),
    parseError: text(),
    /** Website page the document describes (explicit user mapping, e.g. "/about"). */
    targetPath: text(),
    blockCount: integer().notNull().default(0),
    /** Extraction details: page count, warnings. */
    meta: jsonb().$type<Record<string, unknown>>(),
    /** Heartbeat while a worker processes the document (stale values are recovered). */
    processingStartedAt: timestamp({ withTimezone: true }),
    /** While parsing: extracting | indexing. */
    stage: varchar({ length: 32 }),
    /** When parsed: completed | completed_with_warnings | partial. */
    outcome: varchar({ length: 32 }),
    /** What was read: pages detected / with text / image-only / blank / failed / not processed. */
    coverage: jsonb().$type<Record<string, unknown>>(),
    /** Resume state of an interrupted or time-limited extraction (PDF: next page, collector). */
    checkpoint: jsonb().$type<Record<string, unknown>>(),
    /** Processing runs started (stale recovery stops re-queueing after a few). */
    attempts: integer().notNull().default(0),
    cancelRequestedAt: timestamp({ withTimezone: true }),
    chunkCount: integer().notNull().default(0),
    /** Extraction code version that produced the blocks (reuse/resume only within one version). */
    extractorVersion: varchar({ length: 32 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("content_document_project_idx").on(t.projectId),
    index("content_document_project_sha_idx").on(t.projectId, t.sha256),
  ],
);

export const contentBlock = pgTable(
  "content_block",
  {
    id: uuid().primaryKey().defaultRandom(),
    documentId: uuid()
      .notNull()
      .references(() => contentDocument.id, { onDelete: "cascade" }),
    order: integer().notNull(),
    type: contentBlockTypeEnum().notNull(),
    level: integer(),
    text: text().notNull(),
    normalizedText: text().notNull(),
    href: text(),
    pageHint: text(),
    /** Where the block came from in the document (page number, heading path). */
    location: jsonb().$type<Record<string, unknown>>(),
  },
  (t) => [index("content_block_document_idx").on(t.documentId, t.order)],
);

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

/**
 * Retrieval units of a content document: consecutive blocks of one section, sized for AI
 * requests, with their source location. `search` is a generated full-text index column
 * ('simple' configuration: no stemming, works for any language).
 */
export const contentChunk = pgTable(
  "content_chunk",
  {
    id: uuid().primaryKey().defaultRandom(),
    documentId: uuid()
      .notNull()
      .references(() => contentDocument.id, { onDelete: "cascade" }),
    projectId: uuid()
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    chunkIndex: integer().notNull(),
    text: text().notNull(),
    /** Heading path of the section, outermost first, joined with " › ". */
    headingText: text(),
    pageHint: text(),
    pageStart: integer(),
    pageEnd: integer(),
    /** First and last `content_block.order` in the chunk. */
    blockStart: integer().notNull(),
    blockEnd: integer().notNull(),
    /** Offsets in the document text (block texts joined by newlines). */
    charStart: integer().notNull(),
    charEnd: integer().notNull(),
    tokenEstimate: integer().notNull(),
    contentHash: varchar({ length: 64 }).notNull(),
    search: tsvector().generatedAlwaysAs(
      sql`to_tsvector('simple'::regconfig, coalesce(heading_text, '') || ' ' || text)`,
    ),
  },
  (t) => [
    unique("content_chunk_document_index_uq").on(t.documentId, t.chunkIndex),
    index("content_chunk_project_idx").on(t.projectId),
    index("content_chunk_search_idx").using("gin", t.search),
  ],
);

/**
 * Pages of the project's website the user wants included in every scan (in addition to the
 * crawl). `linkKey` is the duplicate-detection identity (host without www, path, sorted query).
 */
export const projectPageLink = pgTable(
  "project_page_link",
  {
    id: uuid().primaryKey().defaultRandom(),
    projectId: uuid()
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    url: text().notNull(),
    linkKey: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique("project_page_link_project_key_uq").on(t.projectId, t.linkKey)],
);

/**
 * Brand font files uploaded to a project. A row exists only after the file was validated and its
 * font tables were read (names, weight, style in `metadata`); invalid files are rejected, not
 * stored. Fonts are reference data for the Design Quality scanner; they are never served to
 * visitors or injected into scanned pages.
 */
export const projectFont = pgTable(
  "project_font",
  {
    id: uuid().primaryKey().defaultRandom(),
    projectId: uuid()
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    filename: varchar({ length: 255 }).notNull(),
    format: varchar({ length: 8 }).notNull(),
    mimeType: varchar({ length: 64 }).notNull(),
    sizeBytes: integer().notNull(),
    sha256: varchar({ length: 64 }).notNull(),
    storageKey: text().notNull(),
    /** What was read from the font file: family/style names, weight, italic, embedding bits. */
    metadata: jsonb().$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique("project_font_project_sha_uq").on(t.projectId, t.sha256)],
);

/**
 * Encrypted per-project secrets (AES-256-GCM with ENCRYPTION_KEY, bound to the project id).
 * `summary` is the non-secret description shown in the UI (type, username, header/cookie names).
 */
export const projectSecret = pgTable(
  "project_secret",
  {
    projectId: uuid()
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    kind: varchar({ length: 32 }).notNull(),
    ciphertext: text().notNull(),
    summary: jsonb().$type<Record<string, unknown>>().notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [unique("project_secret_project_kind_uq").on(t.projectId, t.kind)],
);
