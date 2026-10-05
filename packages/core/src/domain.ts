import { z } from "zod";

/** The six QA scanners. Design/content comparison run additionally when references exist. */
export const SCANNER_KEYS = [
  "accessibility",
  "security",
  "seo",
  "links",
  "performance",
  "responsive",
] as const;
export type ScannerKey = (typeof SCANNER_KEYS)[number];

export const SCANNER_LABELS: Record<ScannerKey, string> = {
  accessibility: "Accessibility",
  security: "Security",
  seo: "SEO",
  links: "Broken links / mixed content",
  performance: "Performance",
  responsive: "Responsive / visual",
};

/** Reference comparisons: run in addition to the scanners when the project has references. */
export const COMPARISON_KEYS = ["design", "content"] as const;
export type ComparisonKey = (typeof COMPARISON_KEYS)[number];

export const COMPARISON_LABELS: Record<ComparisonKey, string> = {
  design: "Design comparison",
  content: "Content comparison",
};

/** Everything that produces findings: the six scanners plus the reference comparisons. */
export const FINDING_SOURCES = [...SCANNER_KEYS, ...COMPARISON_KEYS] as const;
export const FINDING_SOURCE_LABELS: Record<string, string> = {
  ...SCANNER_LABELS,
  ...COMPARISON_LABELS,
};

/** Labels for every pipeline step stored in scanner_run.step_key (unknown keys fall back to the key). */
export const PIPELINE_STEP_LABELS: Record<string, string> = {
  preflight: "Preparing website",
  crawl: "Crawling pages",
  capture: "Browser capture",
  ...SCANNER_LABELS,
  ...COMPARISON_LABELS,
  ai: "AI analysis",
  grounding: "Evidence validation",
  report: "Report generation",
};

export const stepLabel = (key: string) => PIPELINE_STEP_LABELS[key] ?? key;

export const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const ISSUE_STATUSES = [
  "open",
  "in_progress",
  "resolved",
  "reopened",
  "ignored",
  "inconclusive",
] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

/** Statuses that count as outstanding work. */
export const ACTIVE_ISSUE_STATUSES: IssueStatus[] = ["open", "in_progress", "reopened"];

export const viewportSchema = z.object({
  name: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]{1,32}$/, "use lowercase letters, digits and dashes"),
  width: z.number().int().min(240).max(3840),
  height: z.number().int().min(240).max(4320),
});
export type Viewport = z.infer<typeof viewportSchema>;

export const DEFAULT_VIEWPORTS: Viewport[] = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "mobile", width: 390, height: 844 },
];

export const scanDefaultsSchema = z.object({
  scanners: z
    .array(z.enum(SCANNER_KEYS))
    .min(1, "select at least one scanner")
    .transform((list) => SCANNER_KEYS.filter((k) => list.includes(k))),
  viewports: z
    .array(viewportSchema)
    .min(1, "add at least one viewport")
    .max(6)
    .refine(
      (v) => new Set(v.map((x) => x.name)).size === v.length,
      "viewport names must be unique",
    ),
  maxPages: z.number().int().min(1).max(500),
  maxDepth: z.number().int().min(0).max(10),
  respectRobots: z.boolean(),
});
export type ScanDefaults = z.infer<typeof scanDefaultsSchema>;

export function defaultScanDefaults(limits?: {
  maxPages?: number;
  maxDepth?: number;
}): ScanDefaults {
  return {
    scanners: [...SCANNER_KEYS],
    viewports: DEFAULT_VIEWPORTS.map((v) => ({ ...v })),
    maxPages: limits?.maxPages ?? 25,
    maxDepth: limits?.maxDepth ?? 3,
    respectRobots: true,
  };
}

const projectName = z
  .string()
  .trim()
  .min(1, "project name is required")
  .max(120, "project name must be at most 120 characters");

const websiteUrlInput = z.string().trim().min(1, "website URL is required").max(2048);

export const projectCreateSchema = z.object({
  name: projectName,
  websiteUrl: websiteUrlInput,
  scanDefaults: scanDefaultsSchema.optional(),
  /** Optional Figma design link captured in the setup wizard (processed in a later step). */
  figmaUrl: z.string().trim().max(2048).optional(),
});

export const figmaReferenceSchema = z.object({
  figmaUrl: z.string().trim().min(1, "Figma link is required").max(2048),
});

export const websiteUrlCheckSchema = z.object({ websiteUrl: websiteUrlInput });
export type ProjectCreateInput = z.infer<typeof projectCreateSchema>;

export const projectUpdateSchema = z
  .object({
    name: projectName.optional(),
    websiteUrl: websiteUrlInput.optional(),
    scanDefaults: scanDefaultsSchema.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), "no changes supplied");
export type ProjectUpdateInput = z.infer<typeof projectUpdateSchema>;

export const listQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListQuery = z.infer<typeof listQuerySchema>;

/** Converts zod issues into a client-safe list for problem+json `errors`. */
export function zodIssues(error: z.ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}
