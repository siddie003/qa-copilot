import path from "node:path";
import { z } from "zod";
import { findRepoRoot, loadEnv } from "./env";

const bool = z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1");

const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

const postgresUrl = z
  .string()
  .url()
  .refine((v) => /^postgres(ql)?:\/\//.test(v), "must start with postgres:// or postgresql://");

export const configSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    APP_URL: z.string().url().default("http://localhost:3000"),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),

    DATABASE_URL: postgresUrl,
    DATABASE_POOL_MAX: int(1, 100).default(10),

    BETTER_AUTH_SECRET: z.string().min(32, "must be at least 32 characters"),
    AUTH_ALLOW_SIGNUP: bool.default(true),
    /**
     * Reverse proxies (IPs or CIDR ranges) in front of the web app. The client IP used for sign-in
     * rate limits is then the rightmost CLIENT_IP_HEADER entry that is not one of them. Without
     * it, only a single-value header is trusted (anyone who reaches the app directly can set it).
     */
    TRUSTED_PROXIES: z
      .string()
      .default("")
      .transform((v) =>
        v
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      )
      .pipe(
        z.array(
          z.union([z.ipv4(), z.ipv6(), z.cidrv4(), z.cidrv6()], {
            error: "must be a comma-separated list of IP addresses or CIDR ranges",
          }),
        ),
      ),
    /** Header carrying the client IP set by your reverse proxy (e.g. x-real-ip). */
    CLIENT_IP_HEADER: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9-]{1,64}$/, "must be an HTTP header name")
      .default("x-forwarded-for"),
    /** Per-user API rate limits (see docs/DEPLOYMENT.md). Sign-in limits always apply. */
    RATE_LIMIT_ENABLED: bool.default(true),
    ENCRYPTION_KEY: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, "must be 64 hex characters (32 bytes)")
      .optional(),

    STORAGE_DIR: z.string().default("./storage"),
    MAX_UPLOAD_MB: int(1, 200).default(20),
    /**
     * Time one processing run of a content document may take. A PDF stopped by it keeps the
     * pages read so far (partial) and can continue with Retry.
     */
    DOCUMENT_EXTRACTION_TIMEOUT_MS: int(10_000, 3_600_000).default(300_000),
    /** Heap limit of the document parsing thread. */
    DOCUMENT_PARSER_MEMORY_MB: int(128, 4_096).default(512),
    /** Blocks stored per document; beyond it the document is partial (never silently cut). */
    DOCUMENT_MAX_BLOCKS: int(100, 500_000).default(50_000),
    /** Target size of indexed sections (also capped at a quarter of AI_MAX_INPUT_TOKENS). */
    DOCUMENT_CHUNK_TOKENS: int(100, 4_000).default(600),

    AI_PROVIDER: z
      .enum(["none", "anthropic", "openai-compatible", "gemini", "groq"])
      .default("none"),
    AI_MODEL: z.string().optional(),
    /**
     * Sampling temperature for OpenAI-style providers (current Claude models reject it). Unset:
     * openai-compatible uses 0, gemini/groq send none (Google recommends Gemini 3's default).
     */
    AI_TEMPERATURE: z.coerce.number().min(0).max(2).optional(),
    /** Per request. Thinking models can take minutes for a batch of issues. */
    AI_TIMEOUT_MS: int(1_000, 600_000).default(300_000),
    /** Includes thinking tokens on models that think. */
    AI_MAX_OUTPUT_TOKENS: int(256, 64_000).default(16_000),
    /** Anthropic effort level; unset = the model's default. Not supported by every model. */
    AI_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
    /** Anthropic: retry safety-classifier refusals on Anthropic's recommended fallback model. */
    AI_REFUSAL_FALLBACK: bool.default(true),
    /** AI requests (batches of issues) sent in parallel per scan. */
    AI_CONCURRENCY: int(1, 8).default(3),
    /** Retries per request after rate limits (429), server errors and network failures. */
    AI_MAX_RETRIES: int(0, 8).default(3),
    /** Longest Retry-After wait honoured; a longer requested wait ends the request. */
    AI_MAX_RETRY_WAIT_MS: int(0, 600_000).default(60_000),
    /** Client-side pacing per worker process (0 = none). Set to your plan's limits on free tiers. */
    AI_REQUESTS_PER_MINUTE: int(0, 100_000).default(0),
    AI_TOKENS_PER_MINUTE: int(0, 100_000_000).default(0),
    /** Estimated input tokens per request (batches of issues are cut to fit). */
    AI_MAX_INPUT_TOKENS: int(1_000, 1_000_000).default(20_000),
    /** Issues per scan sent to AI; the rest keep the scanners' wording. */
    AI_MAX_ISSUES_PER_SCAN: int(0, 5_000).default(200),
    /** OpenAI-style providers: strict json_schema, or json_object for models without it. */
    AI_STRUCTURED_OUTPUT: z.enum(["json_schema", "json_object"]).default("json_schema"),
    ANTHROPIC_API_KEY: z.string().optional(),
    OPENAI_API_KEY: z.string().optional(),
    OPENAI_BASE_URL: z.string().url().optional(),
    GEMINI_API_KEY: z.string().optional(),
    GROQ_API_KEY: z.string().optional(),

    FIGMA_ACCESS_TOKEN: z.string().optional(),
    /** Largest Figma response read; bigger files are read page by page. */
    FIGMA_MAX_RESPONSE_MB: int(1, 500).default(50),
    /** Pages per /nodes request when a file is read page by page (fewer requests = less quota). */
    FIGMA_PAGES_PER_REQUEST: int(1, 100).default(10),
    FIGMA_TIMEOUT_MS: int(5_000, 600_000).default(120_000),
    /** Retries after 429 (short Retry-After only) and 5xx/network errors. */
    FIGMA_MAX_RETRIES: int(0, 6).default(3),
    /** Longest Retry-After honoured; longer waits stop the read (it can be continued later). */
    FIGMA_MAX_RETRY_WAIT_MS: int(0, 600_000).default(60_000),

    SCAN_MAX_PAGES: int(1, 500).default(25),
    /**
     * Pages the accessibility scanner analyzes per scan; 0 = all pages of the scan (its page
     * limit). Pages not reached within the step's time budget are reported as not analyzed.
     */
    SCAN_ACCESSIBILITY_MAX_PAGES: int(0, 500).default(0),
    SCAN_MAX_DEPTH: int(0, 10).default(3),
    SCAN_PAGE_TIMEOUT_MS: int(1_000, 300_000).default(30_000),
    SCAN_SCANNER_TIMEOUT_MS: int(10_000, 3_600_000).default(600_000),
    SCAN_CONCURRENCY: int(1, 16).default(3),
    LINK_CHECK_RETRIES: int(0, 10).default(3),
    SCAN_USER_AGENT: z.string().default("QACopilotBot/0.1 (+website QA scanner)"),
    SCAN_RESPECT_ROBOTS: bool.default(true),
    SCAN_ALLOWED_PRIVATE_HOSTS: z
      .string()
      .default("")
      .transform((v) =>
        v
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean),
      ),

    WORKER_HEALTH_PORT: int(0, 65_535).default(3001),
    /** Interface of the worker health endpoint; 0.0.0.0 inside containers so probes reach it. */
    WORKER_HEALTH_HOST: z.string().trim().min(1).default("127.0.0.1"),
    /** Scans one worker process runs in parallel (each uses its own browser). */
    WORKER_CONCURRENCY: int(1, 8).default(1),
    /**
     * On SIGTERM/SIGINT, running scans may continue this long; then they are stopped and recorded
     * as failed ("the worker was shut down"). Keep it below the orchestrator's kill timeout.
     */
    WORKER_SHUTDOWN_GRACE_MS: int(0, 600_000).default(20_000),

    DEMO_MODE_ENABLED: bool.default(true),
    DEMO_SITE_PORT: int(1, 65_535).default(4100),
  })
  .superRefine((cfg, ctx) => {
    const require = (variable: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [variable], message });

    if (cfg.NODE_ENV === "production" && !cfg.ENCRYPTION_KEY)
      require("ENCRYPTION_KEY", "required in production");
    if (cfg.AI_PROVIDER === "anthropic" && !cfg.ANTHROPIC_API_KEY)
      require("ANTHROPIC_API_KEY", "required when AI_PROVIDER=anthropic");
    if (cfg.AI_PROVIDER === "openai-compatible" && !cfg.OPENAI_API_KEY)
      require("OPENAI_API_KEY", "required when AI_PROVIDER=openai-compatible");
    if (cfg.AI_PROVIDER === "gemini" && !cfg.GEMINI_API_KEY)
      require("GEMINI_API_KEY", "required when AI_PROVIDER=gemini");
    if (cfg.AI_PROVIDER === "groq" && !cfg.GROQ_API_KEY)
      require("GROQ_API_KEY", "required when AI_PROVIDER=groq");
    if (cfg.AI_PROVIDER !== "none" && !cfg.AI_MODEL)
      require("AI_MODEL", "required when an AI provider is configured");
  });

export type AppConfig = z.infer<typeof configSchema> & { storageDirAbsolute: string };

export interface ConfigIssue {
  variable: string;
  message: string;
}

/** Thrown when environment configuration is invalid. Lists variable names only, never values. */
export class ConfigError extends Error {
  readonly issues: ConfigIssue[];
  constructor(issues: ConfigIssue[]) {
    super(
      `Invalid environment configuration:\n${issues
        .map((i) => `  - ${i.variable}: ${i.message}`)
        .join("\n")}`,
    );
    this.name = "ConfigError";
    this.issues = issues;
  }
}

/** Pure parser (no caching, no .env loading). Used by tests and by getConfig(). */
export function parseConfig(env: Record<string, string | undefined>): AppConfig {
  // Treat empty strings as unset so `.env` placeholders like `FOO=` don't fail validation.
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v !== ""),
  );
  const result = configSchema.safeParse(cleaned);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((i) => ({
        variable: i.path.join(".") || "(root)",
        message: i.code === "invalid_type" && i.input === undefined ? "is required" : i.message,
      })),
    );
  }
  const root = findRepoRoot() ?? process.cwd();
  return { ...result.data, storageDirAbsolute: path.resolve(root, result.data.STORAGE_DIR) };
}

let cached: AppConfig | undefined;

/** Loads root `.env`, validates and caches the configuration. Throws ConfigError when invalid. */
export function getConfig(): AppConfig {
  if (cached) return cached;
  loadEnv();
  cached = parseConfig(process.env);
  return cached;
}

/** Test helper: clears the cached configuration. */
export function resetConfigCache(): void {
  cached = undefined;
}

/**
 * Valid but risky production settings (empty outside production). Logged at startup by both
 * processes and shown on the Settings page; they never stop the application.
 */
export function configWarnings(cfg: AppConfig): string[] {
  if (cfg.NODE_ENV !== "production") return [];
  const warnings: string[] = [];
  if (!cfg.APP_URL.startsWith("https://"))
    warnings.push(
      "APP_URL is not HTTPS: session cookies are sent without the Secure flag and HSTS is off. Serve the app over HTTPS (e.g. TLS at a reverse proxy) and set APP_URL to the https:// address.",
    );
  if (cfg.SCAN_ALLOWED_PRIVATE_HOSTS.length)
    warnings.push(
      `SCAN_ALLOWED_PRIVATE_HOSTS lets users scan internal addresses (${cfg.SCAN_ALLOWED_PRIVATE_HOSTS.join(", ")}). Remove entries that are not authorized scan targets.`,
    );
  if (cfg.AUTH_ALLOW_SIGNUP)
    warnings.push(
      "AUTH_ALLOW_SIGNUP=true: anyone who can reach the app can create an account and start scans. Set it to false once your accounts exist.",
    );
  if (!cfg.RATE_LIMIT_ENABLED)
    warnings.push("RATE_LIMIT_ENABLED=false: per-user API rate limits are off.");
  if (!cfg.TRUSTED_PROXIES.length)
    warnings.push(
      "TRUSTED_PROXIES is empty: per-IP sign-in limits trust a single X-Forwarded-For value, which clients can set themselves unless a reverse proxy overwrites it. List your proxy addresses (per-account sign-in limits apply either way).",
    );
  return warnings;
}

/**
 * What leaves the installation when AI is on. Provider terms as published on 2026-10-09
 * (see LLM_PROVIDER_SETUP.md); they can change, so the wording points to the terms.
 */
const AI_DATA_NOTICES: Partial<Record<AppConfig["AI_PROVIDER"], string>> = {
  gemini:
    "Scan findings (website text, HTML excerpts, URLs) and brand-guideline lines are sent to the Google Gemini API. On Google's unpaid tier, submitted content may be used to improve Google's products and read by human reviewers; Google asks not to submit confidential or personal information there. Use a paid (billing-enabled) project for confidential sites.",
  groq: "Scan findings (website text, HTML excerpts, URLs) and brand-guideline lines are sent to the Groq API. Groq states it does not retain inference data by default, except for up to 30 days for troubleshooting or abuse investigation; Zero Data Retention can be enabled in Groq's data controls.",
  "openai-compatible":
    "Scan findings (website text, HTML excerpts, URLs) and brand-guideline lines are sent to the configured OpenAI-compatible server. Check that provider's data-use terms.",
  anthropic:
    "Scan findings (website text, HTML excerpts, URLs) and brand-guideline lines are sent to the Anthropic API. Check Anthropic's commercial data-use terms.",
};

/** Non-secret summary suitable for logs and the settings UI. */
export function describeConfig(cfg: AppConfig) {
  return {
    nodeEnv: cfg.NODE_ENV,
    appUrl: cfg.APP_URL,
    storageDir: cfg.storageDirAbsolute,
    aiProvider: cfg.AI_PROVIDER,
    aiModel: cfg.AI_MODEL ?? null,
    aiConfigured: cfg.AI_PROVIDER !== "none",
    aiEffort: cfg.AI_EFFORT ?? null,
    aiRefusalFallback: cfg.AI_PROVIDER === "anthropic" && cfg.AI_REFUSAL_FALLBACK,
    aiLimits: {
      requestsPerMinute: cfg.AI_REQUESTS_PER_MINUTE,
      tokensPerMinute: cfg.AI_TOKENS_PER_MINUTE,
      maxInputTokens: cfg.AI_MAX_INPUT_TOKENS,
      maxOutputTokens: cfg.AI_MAX_OUTPUT_TOKENS,
      maxIssuesPerScan: cfg.AI_MAX_ISSUES_PER_SCAN,
      concurrency: cfg.AI_CONCURRENCY,
      maxRetries: cfg.AI_MAX_RETRIES,
    },
    /** Whether scan evidence is sent to a provider whose free tier may use it (shown in Settings). */
    aiDataNotice: AI_DATA_NOTICES[cfg.AI_PROVIDER] ?? null,
    figmaConfigured: Boolean(cfg.FIGMA_ACCESS_TOKEN),
    signupEnabled: cfg.AUTH_ALLOW_SIGNUP,
    encryptionKeyConfigured: Boolean(cfg.ENCRYPTION_KEY),
    scanLimits: {
      maxPages: cfg.SCAN_MAX_PAGES,
      maxDepth: cfg.SCAN_MAX_DEPTH,
      pageTimeoutMs: cfg.SCAN_PAGE_TIMEOUT_MS,
      concurrency: cfg.SCAN_CONCURRENCY,
    },
    demoModeEnabled: cfg.DEMO_MODE_ENABLED,
  };
}
