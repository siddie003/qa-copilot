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
  "design_quality",
  "ai",
  "grounding",
]);

/**
 * Scanners that run after the reference comparisons instead of with the other scanners, because
 * they read the comparisons' results (Design Quality reports them by cross-reference).
 */
export const LATE_SCANNERS = new Set<string>(["design_quality"]);

const NOT_IMPLEMENTED_REASON: Record<string, string> = {
  scanner: "Scanner module not implemented yet (planned for Phase 5)",
};

/** Reason the AI step is skipped when no provider is configured (issues are still created). */
export const NO_AI_PROVIDER_REASON =
  "No AI provider configured (AI_PROVIDER=none): issues are created from the scanner findings with the scanners' own wording and the rule catalog's fix guidance.";

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
    if (!scanners.includes(key) || LATE_SCANNERS.has(key)) continue;
    steps.push(
      IMPLEMENTED_STEPS.has(key)
        ? { stepKey: key }
        : { stepKey: key, status: "skipped", statusReason: NOT_IMPLEMENTED_REASON.scanner },
    );
  }
  const available: Record<string, boolean> = { design: refs.designSpec, content: refs.content };
  // ai: interprets the findings (skipped by the worker when no provider is configured);
  // grounding: validates AI text against the evidence and creates the issues (always runs).
  // Reports are not a scan step: they are generated on demand for finished scans (Phase 8).
  for (const key of ["design", "content", "ai", "grounding"]) {
    if (key === "ai")
      for (const late of SCANNER_KEYS)
        if (scanners.includes(late) && LATE_SCANNERS.has(late)) steps.push({ stepKey: late });
    if (key in available && !available[key])
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
  /** Blocks at scan start; the comparison reads only these (a document may be continued later). */
  blockCount: number;
  /** completed | completed_with_warnings | partial (absent on scans before Phase 13). */
  outcome?: string | null;
  /** What was not read, for partial documents (shown as an inconclusive check). */
  coverageNote?: string | null;
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
  /** Pages the user added as page links (scanned even if the crawler would not reach them). */
  pageLinks?: string[];
  /** Brand font files uploaded to the project (names read from the font files). */
  approvedFonts?: ScanFontReference[];
}

/** An uploaded brand font frozen into a scan: the names CSS can refer to it by. */
export interface ScanFontReference {
  id: string;
  filename: string;
  /** Family names read from the font file (typographic family, family, full name, PostScript). */
  families: string[];
  weight: number | null;
  italic: boolean | null;
}
