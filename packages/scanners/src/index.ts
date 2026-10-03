import type { ScannerKey } from "@qa/core";
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

/** Registry: adding a scanner = a new module + one entry here (and its key in IMPLEMENTED_STEPS). */
export const SCANNERS: Record<ScannerKey, Scanner> = {
  accessibility: accessibilityScanner,
  security: securityScanner,
  seo: seoScanner,
  links: linksScanner,
  performance: performanceScanner,
  responsive: responsiveScanner,
};
