export * from "./types";
export {
  buildReportData,
  categoryLabel,
  REPORT_SCHEMA_VERSION,
  SEVERITY_LABELS,
  STATUS_LABELS,
  VERDICT_LABELS,
} from "./build";
export { mdBlock, mdCode, mdText, renderMarkdown } from "./markdown";
export { esc, renderHtml } from "./html";

import type { ReportData } from "./types";

/** Serialized JSON report (stable key order as built, 2-space indent). */
export const renderJson = (d: ReportData) => `${JSON.stringify(d, null, 2)}\n`;

export type ReportFormat = "pdf" | "md" | "json";

export const REPORT_EXTENSIONS: Record<ReportFormat, string> = {
  pdf: "pdf",
  md: "md",
  json: "json",
};
