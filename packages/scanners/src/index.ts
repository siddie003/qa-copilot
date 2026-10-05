import type { ComparisonKey, ScannerKey } from "@qa/core";
import { contentScanner } from "./content";
import { designScanner } from "./design";
import { accessibilityScanner } from "./accessibility";
import { linksScanner } from "./links";
import { performanceScanner } from "./performance";
import { responsiveScanner } from "./responsive";
import { securityScanner } from "./security";
import { seoScanner } from "./seo";
import type { Scanner } from "./types";

export * from "./types";
export { analyzablePages } from "./util";
export { classifyLink } from "./links";
export { parseCsp, maskSecret } from "./security";
export { buildTargets, compareValue } from "./design";
export { mapSection } from "./content";

/** Registry: adding a scanner = a new module + one entry here (and its key in IMPLEMENTED_STEPS). */
export const SCANNERS: Record<ScannerKey, Scanner> = {
  accessibility: accessibilityScanner,
  security: securityScanner,
  seo: seoScanner,
  links: linksScanner,
  performance: performanceScanner,
  responsive: responsiveScanner,
};

/** Reference comparisons, run after the scanners when the scan has references. */
export const COMPARISON_SCANNERS: Record<ComparisonKey, Scanner> = {
  design: designScanner,
  content: contentScanner,
};
