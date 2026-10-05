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
  "design",
  "content",
]);

const NOT_IMPLEMENTED_REASON: Record<string, string> = {
  scanner: "Scanner module not implemented yet (planned for Phase 5)",
  ai: "AI interpretation not implemented yet (planned for Phase 7)",
  report: "Report generation not implemented yet (planned for Phase 8)",
};

/** Reasons used when a comparison has nothing to compare against (never shown as "completed"). */
export const NO_REFERENCE_REASON = {
  design:
    "No confirmed design reference: design values are unable to verify. Add Figma, manual values or a brand guideline on the References page.",
  content:
    "No processed content documents: website copy is unable to verify. Upload approved content on the References page.",
} as const;

export interface PlannedStep {
  stepKey: string;
  status?: "pending" | "skipped";
  statusReason?: string;
}

/** Which references a scan has (decided when the scan is created). */
export interface ReferenceAvailability {
  designSpec: boolean;
  content: boolean;
}

export function planScanSteps(
  scanners: ScanDefaults["scanners"],
  refs: ReferenceAvailability = { designSpec: false, content: false },
): PlannedStep[] {
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
  const available: Record<string, boolean> = { design: refs.designSpec, content: refs.content };
  for (const key of ["design", "content", "ai", "report"]) {
    if (!IMPLEMENTED_STEPS.has(key))
      steps.push({ stepKey: key, status: "skipped", statusReason: NOT_IMPLEMENTED_REASON[key] });
    else if (key in available && !available[key])
      steps.push({
        stepKey: key,
        status: "skipped",
        statusReason: NO_REFERENCE_REASON[key as keyof typeof NO_REFERENCE_REASON],
      });
    else steps.push({ stepKey: key });
  }
  return steps;
}

/** A content document frozen into a scan (blocks are read by id when the comparison runs). */
export interface ScanContentDocument {
  id: string;
  filename: string;
  sha256: string;
  targetPath: string | null;
  blockCount: number;
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
  /** Version of the confirmed design spec the scan compares against (id is on scan.designSpecId). */
  designSpecVersion?: number | null;
  /** Processed content documents the scan compares against. */
  contentDocuments?: ScanContentDocument[];
}
