import { SCANNER_KEYS, type ScanDefaults } from "./domain";

/**
 * Steps a scan goes through, in order. Each becomes a `scanner_run` row so the UI shows real
 * progress. Steps whose implementation does not exist yet are created as "skipped" with an
 * explicit reason instead of pretending to run.
 */
export const IMPLEMENTED_STEPS = new Set<string>([
  "preflight",
  "crawl",
  "capture",
  "accessibility",
  "security",
  "seo",
  "links",
  "performance",
  "responsive",
]);

const NOT_IMPLEMENTED_REASON: Record<string, string> = {
  scanner: "Scanner module not implemented yet (planned for Phase 5)",
  design: "Design comparison not implemented yet (planned for Phase 6)",
  content: "Content comparison not implemented yet (planned for Phase 6)",
  ai: "AI interpretation not implemented yet (planned for Phase 7)",
  report: "Report generation not implemented yet (planned for Phase 8)",
};

export interface PlannedStep {
  stepKey: string;
  status?: "pending" | "skipped";
  statusReason?: string;
}

export function planScanSteps(scanners: ScanDefaults["scanners"]): PlannedStep[] {
  const steps: PlannedStep[] = [
    { stepKey: "preflight" },
    { stepKey: "crawl" },
    { stepKey: "capture" },
  ];
  for (const key of SCANNER_KEYS) {
    if (!scanners.includes(key)) continue;
    steps.push(
      IMPLEMENTED_STEPS.has(key)
        ? { stepKey: key }
        : { stepKey: key, status: "skipped", statusReason: NOT_IMPLEMENTED_REASON.scanner },
    );
  }
  for (const key of ["design", "content", "ai", "report"]) {
    steps.push(
      IMPLEMENTED_STEPS.has(key)
        ? { stepKey: key }
        : { stepKey: key, status: "skipped", statusReason: NOT_IMPLEMENTED_REASON[key] },
    );
  }
  return steps;
}

/** Immutable configuration a scan runs with (stored on the scan row). */
export interface ScanConfigSnapshot {
  websiteUrl: string;
  scanners: ScanDefaults["scanners"];
  viewports: ScanDefaults["viewports"];
  maxPages: number;
  maxDepth: number;
  respectRobots: boolean;
  pageTimeoutMs: number;
  concurrency: number;
  userAgent: string;
  authorizationAttestedAt: string;
  /** Type of site credentials used (never the credentials themselves); null = none. */
  authType?: "basic" | "header" | "cookies" | null;
}
