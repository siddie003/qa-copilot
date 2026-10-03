import type { ScannerKey, Severity } from "@qa/core";
import type { FetchOptions, RobotsRules } from "@qa/crawler";
import type { Page as PwPage } from "playwright";
import { z } from "zod";

export type Verdict = "confirmed" | "potential" | "inconclusive" | "unable_to_verify";

export const EVIDENCE_KINDS = [
  "html_snippet",
  "header",
  "network",
  "screenshot",
  "measurement",
  "computed_style",
  "axe_node",
  "console",
  "document",
  "link_check",
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const evidenceDraftSchema = z.object({
  kind: z.enum(EVIDENCE_KINDS),
  /** Plain, factual data observed by the scanner (never interpretation). */
  data: z.record(z.string(), z.unknown()),
  /** Stored artifact backing the evidence (e.g. the page screenshot). */
  storageKey: z.string().max(512).nullable().optional(),
});
export type EvidenceDraft = z.infer<typeof evidenceDraftSchema>;

/**
 * A scanner result. Every finding must carry at least one piece of evidence; findings without
 * evidence are rejected before they reach the database.
 */
export const findingDraftSchema = z.object({
  ruleId: z.string().min(1).max(128),
  title: z.string().min(1).max(300),
  message: z.string().min(1).max(4000),
  subcategory: z.string().max(64).nullable().optional(),
  /** Page the finding belongs to; null for site-wide findings (e.g. missing sitemap). */
  pageId: z.string().nullable().optional(),
  pageUrl: z.string().nullable().optional(),
  selector: z.string().max(2000).nullable().optional(),
  viewport: z.string().max(32).nullable().optional(),
  severity: z.enum(["critical", "high", "medium", "low", "info"]),
  verdict: z.enum(["confirmed", "potential", "inconclusive", "unable_to_verify"]),
  confidence: z.number().min(0).max(1),
  expected: z.string().max(2000).nullable().optional(),
  actual: z.string().max(2000).nullable().optional(),
  /** Extra identity for de-duplication across scans (e.g. the broken link target). */
  fingerprintKey: z.string().max(2000).nullable().optional(),
  evidence: z.array(evidenceDraftSchema).min(1, "a finding needs at least one piece of evidence"),
});
export type FindingDraft = z.infer<typeof findingDraftSchema>;

/** What a scanner checked, including checks it could not verify (reported, never hidden). */
export interface CheckSummary {
  /** Number of individual checks evaluated (pages × rules, links checked, ...). */
  evaluated: number;
  /** Checks that could not be verified, with the reason. Shown as "Inconclusive checks". */
  inconclusive: Array<{ check: string; reason: string; pageUrl?: string | null }>;
  notes?: string[];
}

export interface ScannerResult {
  status: "completed" | "failed" | "inconclusive";
  statusReason?: string;
  findings: FindingDraft[];
  checks: CheckSummary;
  toolName: string;
  toolVersion: string;
}

export interface NetworkRecord {
  url: string;
  resourceType: string;
  method: string;
  status: number | null;
  transferSize: number | null;
  decodedSize: number | null;
  durationMs: number | null;
  failureText: string | null;
  isMixedContent: boolean;
}

export interface CaptureRecord {
  pageId: string;
  viewport: string;
  width: number;
  height: number;
  screenshotKey: string | null;
  error: string | null;
  timings: Record<string, unknown>;
  metrics: Record<string, unknown> | null;
  consoleMessages: Array<{ type?: unknown; text?: unknown; location?: unknown }>;
  requests: NetworkRecord[];
  /** Rendered DOM (after JavaScript) for this viewport. */
  loadDom(): Promise<string | null>;
}

export interface PageRecord {
  id: string;
  url: string;
  finalUrl: string | null;
  httpStatus: number | null;
  depth: number;
  title: string | null;
  contentType: string | null;
  crawlError: string | null;
  redirectChain: Array<{ url: string; status: number }> | null;
  responseHeaders: Record<string, string | string[]> | null;
  /** HTML as served (before JavaScript), or null for non-HTML/failed pages. */
  loadRawHtml(): Promise<string | null>;
  captures: CaptureRecord[];
}

export interface LivePage {
  page: PwPage;
  close(): Promise<void>;
}

export interface ScannerContext {
  scanId: string;
  siteUrl: string;
  viewports: Array<{ name: string; width: number; height: number }>;
  pages: PageRecord[];
  robots: RobotsRules | null;
  fetch: FetchOptions;
  signal: AbortSignal;
  /** Opens the URL in a guarded browser context (scan policy and credentials applied). */
  openPage(
    url: string,
    viewport: { name: string; width: number; height: number },
  ): Promise<LivePage>;
  pageTimeoutMs: number;
  log: (msg: string, data?: Record<string, unknown>) => void;
}

export interface Scanner {
  key: ScannerKey;
  /** Prefix of human-readable finding ids, e.g. SEO → SEO-001. */
  idPrefix: string;
  version: string;
  run(ctx: ScannerContext): Promise<ScannerResult>;
}

export type { Severity };
