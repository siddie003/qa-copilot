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

    AI_PROVIDER: z.enum(["none", "anthropic", "openai-compatible"]).default("none"),
    AI_MODEL: z.string().optional(),
    /** Sampling temperature for the OpenAI-compatible provider (current Claude models reject it). */
    AI_TEMPERATURE: z.coerce.number().min(0).max(1).default(0),
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
    ANTHROPIC_API_KEY: z.string().optional(),
    OPENAI_API_KEY: z.string().optional(),
    OPENAI_BASE_URL: z.string().url().optional(),

    FIGMA_ACCESS_TOKEN: z.string().optional(),

    SCAN_MAX_PAGES: int(1, 500).default(25),
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
