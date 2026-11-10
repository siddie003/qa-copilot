import type { z } from "zod";

export type AIProviderId = "anthropic" | "openai-compatible" | "gemini" | "groq" | "none";

export type AIErrorCode =
  | "not_configured"
  | "auth"
  | "not_found"
  | "bad_request"
  /** The request is larger than the provider (or its per-minute token budget) accepts. */
  | "too_large"
  | "rate_limit"
  /** A daily or billing quota is used up; waiting seconds will not help. */
  | "quota_exhausted"
  | "unavailable"
  | "timeout"
  | "network"
  | "aborted"
  | "refusal"
  | "truncated"
  | "invalid_output";

/**
 * Errors after which every further request would fail the same way (configuration problems or
 * an exhausted quota), so the remaining requests of a run are not sent.
 */
export const FATAL_AI_ERRORS: ReadonlySet<AIErrorCode> = new Set([
  "not_configured",
  "auth",
  "not_found",
  "bad_request",
  "too_large",
  "quota_exhausted",
]);

export interface AIUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
}

export const NO_USAGE: AIUsage = { inputTokens: null, outputTokens: null, cacheReadTokens: null };

/** A provider failure with a stable code. Messages never contain credentials or prompt text. */
export class AIProviderError extends Error {
  readonly code: AIErrorCode;
  readonly status: number | null;
  /** Tokens already billed when the failure happened after a response (refusal, truncation). */
  readonly usage: AIUsage | null;
  constructor(
    code: AIErrorCode,
    message: string,
    opts: { status?: number | null; usage?: AIUsage | null; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = "AIProviderError";
    this.code = code;
    this.status = opts.status ?? null;
    this.usage = opts.usage ?? null;
  }
}

export interface StructuredRequest<T> {
  system: string;
  /** User message (the batch data). */
  input: string;
  /** Validates the parsed response. */
  schema: z.ZodType<T>;
  /** JSON Schema of `schema` in the form structured-output APIs accept. */
  jsonSchema: Record<string, unknown>;
  schemaName: string;
  signal?: AbortSignal;
}

export interface StructuredResult<T> {
  data: T;
  usage: AIUsage;
  /** Model that produced the answer (differs from the configured one after a refusal fallback). */
  model: string;
  latencyMs: number;
  stopReason: string | null;
  fallbackUsed: boolean;
  /** HTTP attempts made, including retries (providers that retry themselves report 1). */
  attempts?: number;
}

export interface AIProvider {
  readonly id: AIProviderId;
  readonly model: string;
  /** Name of the API, shown as the step's tool. */
  readonly label: string;
  generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>>;
}

/** Removes a Markdown code fence around a JSON answer (some models add one in JSON mode). */
export function stripJsonFence(text: string): string {
  const m = /^\s*```(?:json)?\s*\n([\s\S]*?)\n?\s*```\s*$/i.exec(text);
  return m ? m[1]! : text;
}

/** Parses and validates a JSON response; the response text is never included in errors. */
export function parseStructured<T>(text: string, schema: z.ZodType<T>, usage: AIUsage | null): T {
  let raw: unknown;
  try {
    raw = JSON.parse(stripJsonFence(text));
  } catch {
    throw new AIProviderError(
      "invalid_output",
      text.trim() ? "The AI response is not valid JSON" : "The AI response was empty",
      { usage },
    );
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AIProviderError(
      "invalid_output",
      `The AI response does not match the expected structure${issue ? ` (${issue.path.join(".") || "root"}: ${issue.message})` : ""}`,
      { usage },
    );
  }
  return parsed.data;
}

/**
 * A signal that aborts after `ms` or when `outer` aborts, and remembers which one happened (a
 * request deadline is a timeout; an outer abort is a cancellation or the step deadline).
 */
export function deadlineSignal(ms: number, outer?: AbortSignal) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("AI request timed out"));
  }, ms);
  const onAbort = () => controller.abort(outer?.reason);
  if (outer?.aborted) onAbort();
  else outer?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onAbort);
    },
  };
}
