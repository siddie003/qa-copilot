import { pgEnum } from "drizzle-orm/pg-core";

export const severityEnum = pgEnum("severity", ["critical", "high", "medium", "low", "info"]);

export const issueStatusEnum = pgEnum("issue_status", [
  "open",
  "in_progress",
  "resolved",
  "reopened",
  "ignored",
  "inconclusive",
]);

export const scanStatusEnum = pgEnum("scan_status", [
  "queued",
  "running",
  "completed",
  "completed_with_failures",
  "failed",
  "cancelled",
]);

/** Status of one pipeline step (a scanner or a stage such as crawl, ai, report). */
export const stepStatusEnum = pgEnum("step_status", [
  "pending",
  "running",
  "completed",
  "failed",
  "inconclusive",
  "skipped",
]);

export const findingVerdictEnum = pgEnum("finding_verdict", [
  "confirmed",
  "potential",
  "inconclusive",
  "unable_to_verify",
]);

export const referenceKindEnum = pgEnum("reference_kind", [
  "figma",
  "manual",
  "guideline_document",
]);

export const referenceStatusEnum = pgEnum("reference_status", [
  "pending",
  "processing",
  "ready",
  "failed",
  "unavailable",
]);

export const parseStatusEnum = pgEnum("parse_status", ["pending", "parsing", "parsed", "failed"]);

export const contentBlockTypeEnum = pgEnum("content_block_type", [
  "heading",
  "paragraph",
  "list_item",
  "cta",
  "link",
  "emphasis",
]);

export const issueOriginEnum = pgEnum("issue_origin", ["ai", "deterministic"]);

export const groundingStatusEnum = pgEnum("grounding_status", [
  "passed",
  "partial",
  "rejected",
  "not_applicable",
]);

export const reportFormatEnum = pgEnum("report_format", ["pdf", "md", "json"]);

export const jobStatusEnum = pgEnum("job_status", ["pending", "running", "completed", "failed"]);
