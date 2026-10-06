import pino, { type DestinationStream, type Logger, type LoggerOptions } from "pino";
import { stripQueryParams } from "./errors";
import { REDACT_PATHS } from "./redact";

export type { Logger };

const LEVELS = new Set(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);

export function buildLoggerOptions(level?: string): LoggerOptions {
  return {
    level: level && LEVELS.has(level) ? level : "info",
    base: { service: "qa-copilot" },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
    formatters: { level: (label) => ({ level: label }) },
  };
}

/**
 * Creates a structured JSON logger. Reads LOG_LEVEL directly from the environment so logging
 * still works when the rest of the configuration is invalid.
 */
export function createLogger(
  bindings: Record<string, unknown> = {},
  destination?: DestinationStream,
): Logger {
  const options = buildLoggerOptions(process.env.LOG_LEVEL);
  const root = destination ? pino(options, destination) : pino(options);
  return Object.keys(bindings).length ? root.child(bindings) : root;
}

let rootLogger: Logger | undefined;

export function getLogger(): Logger {
  rootLogger ??= createLogger();
  return rootLogger;
}

/**
 * Serializes an unknown thrown value into log fields. Bound query parameters (drizzle's
 * "Failed query … params: …" errors) are removed from the message and the stack; the cause's
 * message and code (e.g. the PostgreSQL error) are kept.
 */
export function errorFields(err: unknown): {
  errName: string;
  errMessage: string;
  errCode?: string;
  errStack?: string;
  errCause?: string;
} {
  if (err instanceof Error) {
    const cause = err.cause as { code?: unknown; message?: unknown } | undefined;
    const code = (err as { code?: unknown }).code ?? cause?.code;
    return {
      errName: err.name,
      errMessage: stripQueryParams(err.message),
      ...(typeof code === "string" ? { errCode: code } : {}),
      ...(err.stack ? { errStack: stripQueryParams(err.stack) } : {}),
      ...(cause && typeof cause.message === "string"
        ? { errCause: stripQueryParams(cause.message) }
        : {}),
    };
  }
  return { errName: "NonError", errMessage: String(err) };
}
