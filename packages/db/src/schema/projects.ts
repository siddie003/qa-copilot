import { sql } from "drizzle-orm";
import {
  boolean,
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
    fetchedAt: timestamp({ withTimezone: true }),
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
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("content_document_project_idx").on(t.projectId)],
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
