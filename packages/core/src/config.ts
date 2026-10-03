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
    ENCRYPTION_KEY: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, "must be 64 hex characters (32 bytes)")
      .optional(),

    STORAGE_DIR: z.string().default("./storage"),
    MAX_UPLOAD_MB: int(1, 200).default(20),

    AI_PROVIDER: z.enum(["none", "anthropic", "openai-compatible"]).default("none"),
    AI_MODEL: z.string().optional(),
    AI_TEMPERATURE: z.coerce.number().min(0).max(1).default(0),
    AI_TIMEOUT_MS: int(1_000, 600_000).default(120_000),
    AI_MAX_OUTPUT_TOKENS: int(256, 64_000).default(8_000),
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

/** Non-secret summary suitable for logs and the settings UI. */
export function describeConfig(cfg: AppConfig) {
  return {
    nodeEnv: cfg.NODE_ENV,
    appUrl: cfg.APP_URL,
    storageDir: cfg.storageDirAbsolute,
    aiProvider: cfg.AI_PROVIDER,
    aiModel: cfg.AI_MODEL ?? null,
    aiConfigured: cfg.AI_PROVIDER !== "none",
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
