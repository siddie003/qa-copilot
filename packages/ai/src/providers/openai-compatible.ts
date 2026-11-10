import { abortableSleep, estimateTokens, type RequestPacer } from "./pacing";
import {
  AIProviderError,
  deadlineSignal,
  NO_USAGE,
  parseStructured,
  type AIErrorCode,
  type AIProvider,
  type AIProviderId,
  type AIUsage,
  type StructuredRequest,
  type StructuredResult,
} from "./types";

export type StructuredOutputMode = "json_schema" | "json_object";

export interface OpenAICompatibleOptions {
  apiKey: string;
  model: string;
  /** e.g. https://api.openai.com/v1 or a self-hosted server's /v1 URL. */
  baseUrl?: string;
  /** Omitted from requests when undefined (the provider's default applies). */
  temperature?: number;
  maxOutputTokens: number;
  timeoutMs: number;
  /** Retries after rate limits, server errors and network failures (default 3). */
  maxRetries?: number;
  /** Longest wait honoured before a retry (Retry-After); longer waits give up (default 60 s). */
  maxRetryWaitMs?: number;
  /** First backoff step; doubles per attempt, with full jitter (default 1 s). */
  retryBaseMs?: number;
  /** json_schema: strict schema-constrained output; json_object: JSON mode + schema in the prompt. */
  structuredOutput?: StructuredOutputMode;
  /** Sent as `reasoning_effort` when set (thinking models on Gemini, Groq, OpenAI). */
  reasoningEffort?: "low" | "medium" | "high";
  /** Client-side per-minute pacing shared by this process. */
  pacer?: RequestPacer;
  /** Identity used in step records and messages. */
  id?: AIProviderId;
  label?: string;
  /** Name of the environment variable holding the key (named in credential errors). */
  apiKeyVariable?: string;
  fetchImpl?: typeof fetch;
  /** Tests: deterministic jitter. */
  random?: () => number;
}

interface ChatCompletion {
  model?: string;
  choices?: Array<{
    finish_reason?: string | null;
    message?: { content?: string | null; refusal?: string | null };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

/** What an error response says, reduced to the fields used for classification. */
export interface ProviderErrorInfo {
  message: string;
  /** Provider status/code strings (e.g. RESOURCE_EXHAUSTED, insufficient_quota, rate_limit_exceeded). */
  codes: string[];
  /** Quota ids and reasons from structured details (Google APIs). */
  details: string[];
  /** Retry delay stated in the body (Google RetryInfo), in ms. */
  retryDelayMs: number | null;
}

/** Extracts message, codes and retry hints from an error body (object or array form). */
export function parseErrorBody(text: string): ProviderErrorInfo {
  const info: ProviderErrorInfo = { message: "", codes: [], details: [], retryDelayMs: null };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    info.message = text;
    return info;
  }
  if (Array.isArray(body)) body = body[0];
  const err = (body as { error?: unknown } | null)?.error ?? body;
  if (!err || typeof err !== "object") return info;
  const e = err as Record<string, unknown>;
  if (typeof e.message === "string") info.message = e.message;
  for (const k of ["status", "code", "type"])
    if (typeof e[k] === "string" || typeof e[k] === "number") info.codes.push(String(e[k]));
  for (const d of Array.isArray(e.details) ? e.details : []) {
    if (!d || typeof d !== "object") continue;
    const detail = d as Record<string, unknown>;
    if (typeof detail.reason === "string") info.details.push(detail.reason);
    for (const v of Array.isArray(detail.violations) ? detail.violations : []) {
      const q = (v as Record<string, unknown>)?.quotaId;
      if (typeof q === "string") info.details.push(q);
    }
    if (typeof detail.retryDelay === "string") {
      const s = Number.parseFloat(detail.retryDelay);
      if (Number.isFinite(s)) info.retryDelayMs = Math.round(s * 1000);
    }
  }
  return info;
}

/** Retry-After as seconds or an HTTP date, in ms (null when absent or invalid). */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const date = Date.parse(v);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

const DAILY_QUOTA =
  /per\s*day|perday|daily|\btpd\b|\brpd\b|insufficient_quota|quota.*(plan|billing)|(plan|billing).*quota|credit balance|exceeded your current quota/i;
/** Structured quota ids (Google QuotaFailure), e.g. GenerateRequestsPerMinutePerProjectPerModel-FreeTier. */
const QUOTA_PER_DAY = /per\s*day/i;
const QUOTA_SHORT_WINDOW = /per\s*(second|minute|hour)/i;
const SCHEMA_MISMATCH =
  /json_validate_failed|does not match the expected schema|failed to generate json/i;
const INVALID_KEY = /api_key_invalid|api key not valid|invalid api key|invalid_api_key/i;

/**
 * Classifies an HTTP error. Per-minute rate limits are retryable; exhausted daily/billing quotas,
 * credentials, unknown models and oversized requests are not.
 */
export function classifyHttpError(status: number, info: ProviderErrorInfo): AIErrorCode {
  const text = [info.message, ...info.codes, ...info.details].join(" ");
  if (status === 401 || status === 403 || INVALID_KEY.test(text)) return "auth";
  if (status === 404) return "not_found";
  if (status === 413) return "too_large";
  if (status === 429) {
    // Google sends the same "exceeded your current quota … plan and billing" text for per-minute
    // and per-day limits; the quota ids say which one it is (seen live on 2026-10-10).
    const ids = info.details.join(" ");
    if (QUOTA_PER_DAY.test(ids)) return "quota_exhausted";
    if (QUOTA_SHORT_WINDOW.test(ids)) return "rate_limit";
    return DAILY_QUOTA.test(text) ? "quota_exhausted" : "rate_limit";
  }
  if (status === 408) return "unavailable";
  if (status === 400 && SCHEMA_MISMATCH.test(text)) return "invalid_output";
  if (status === 400 || status === 422) return "bad_request";
  return "unavailable";
}

const RETRYABLE: ReadonlySet<AIErrorCode> = new Set(["rate_limit", "unavailable"]);

/** One line, bounded, with the API key removed — provider messages may echo request data. */
export function sanitizeProviderMessage(message: string, apiKey: string): string {
  let m = message.replace(/\s+/g, " ").trim();
  if (apiKey) m = m.split(apiKey).join("[redacted]");
  m = m.replace(/\b(sk|gsk|AIza)[-_A-Za-z0-9]{12,}/g, "[redacted]");
  return m.length > 200 ? `${m.slice(0, 200)}…` : m;
}

/**
 * Any server that implements the OpenAI Chat Completions API with JSON-schema or JSON-object
 * response formats: OpenAI, Google Gemini's OpenAI-compatible endpoint, Groq, Azure OpenAI, vLLM,
 * LM Studio, Ollama, ... Plain HTTP, no SDK.
 */
export class OpenAICompatibleProvider implements AIProvider {
  readonly id: AIProviderId;
  readonly label: string;
  readonly model: string;
  private readonly baseUrl: string;

  constructor(private readonly opts: OpenAICompatibleOptions) {
    this.model = opts.model;
    this.id = opts.id ?? "openai-compatible";
    this.label = opts.label ?? "OpenAI-compatible Chat Completions API";
    this.baseUrl = (opts.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  }

  private requestBody<T>(req: StructuredRequest<T>): string {
    const jsonObject = this.opts.structuredOutput === "json_object";
    const system = jsonObject
      ? `${req.system}\n\nRespond with a single JSON object (no prose, no code fences) that matches this JSON Schema exactly:\n${JSON.stringify(req.jsonSchema)}`
      : req.system;
    return JSON.stringify({
      model: this.model,
      ...(this.opts.temperature !== undefined ? { temperature: this.opts.temperature } : {}),
      max_tokens: this.opts.maxOutputTokens,
      ...(this.opts.reasoningEffort ? { reasoning_effort: this.opts.reasoningEffort } : {}),
      messages: [
        { role: "system", content: system },
        { role: "user", content: req.input },
      ],
      response_format: jsonObject
        ? { type: "json_object" }
        : {
            type: "json_schema",
            json_schema: { name: req.schemaName, strict: true, schema: req.jsonSchema },
          },
    });
  }

  /** Full-jitter exponential backoff: a random wait in [0, base·2^attempt], capped. */
  private backoff(attempt: number): number {
    const base = this.opts.retryBaseMs ?? 1_000;
    const cap = Math.min(this.opts.maxRetryWaitMs ?? 60_000, 30_000);
    const rnd = (this.opts.random ?? Math.random)();
    return Math.round(rnd * Math.min(cap, base * 2 ** attempt));
  }

  async generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const started = Date.now();
    const deadline = deadlineSignal(this.opts.timeoutMs, req.signal);
    const doFetch = this.opts.fetchImpl ?? fetch;
    const body = this.requestBody(req);
    const retries = this.opts.maxRetries ?? 3;
    const maxWait = this.opts.maxRetryWaitMs ?? 60_000;
    const keyVar = this.opts.apiKeyVariable ?? "OPENAI_API_KEY";
    const estimate = estimateTokens(body.length) + this.opts.maxOutputTokens;
    const aborted = (err?: unknown) =>
      deadline.timedOut()
        ? new AIProviderError("timeout", "The AI request timed out", { cause: err })
        : new AIProviderError("aborted", "The AI request was cancelled", { cause: err });
    try {
      for (let attempt = 0; ; attempt++) {
        const slot = await this.opts.pacer?.acquire(estimate, deadline.signal);
        if (deadline.signal.aborted) throw aborted();
        let res: Response;
        try {
          res = await doFetch(`${this.baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${this.opts.apiKey}`,
            },
            body,
            redirect: "error",
            signal: deadline.signal,
          });
        } catch (err) {
          if (deadline.signal.aborted) throw aborted(err);
          if (attempt < retries) {
            await abortableSleep(this.backoff(attempt), deadline.signal);
            continue;
          }
          throw new AIProviderError(
            "network",
            `The ${this.label} could not be reached after ${attempt + 1} attempt(s)`,
            { cause: err },
          );
        }
        if (!res.ok) {
          const info = parseErrorBody(await res.text().catch(() => ""));
          const code = classifyHttpError(res.status, info);
          if (RETRYABLE.has(code) && attempt < retries) {
            const stated = parseRetryAfter(res.headers.get("retry-after")) ?? info.retryDelayMs;
            if (stated !== null && stated > maxWait)
              throw new AIProviderError(
                code === "rate_limit" && stated > 10 * 60_000 ? "quota_exhausted" : code,
                `The ${this.label} asked to wait ${Math.ceil(stated / 1000)} s before retrying (HTTP ${res.status}), longer than AI_MAX_RETRY_WAIT_MS=${maxWait}`,
                { status: res.status },
              );
            await abortableSleep(stated ?? this.backoff(attempt), deadline.signal);
            continue;
          }
          const detail = sanitizeProviderMessage(info.message, this.opts.apiKey);
          const messages: Partial<Record<AIErrorCode, string>> = {
            auth: `The ${this.label} rejected the credentials (HTTP ${res.status}); check ${keyVar}`,
            not_found: `The ${this.label} returned HTTP 404; check AI_MODEL${this.id === "openai-compatible" ? " and OPENAI_BASE_URL" : ""}`,
            too_large: `The request is larger than the ${this.label} accepts (HTTP ${res.status}), often the per-minute token limit of a free tier; lower AI_MAX_INPUT_TOKENS`,
            quota_exhausted: `The ${this.label} quota is used up (HTTP ${res.status}); AI analysis resumes when the quota resets or the plan is upgraded`,
            rate_limit: `The ${this.label} rate limit was still exceeded after ${attempt + 1} attempt(s) (HTTP ${res.status})`,
            invalid_output: `The ${this.label} could not produce output matching the schema (HTTP ${res.status})`,
          };
          throw new AIProviderError(
            code,
            `${messages[code] ?? `The ${this.label} returned HTTP ${res.status}`}${detail ? `: ${detail}` : ""}`,
            { status: res.status },
          );
        }
        const data = (await res.json().catch(() => null)) as ChatCompletion | null;
        const usage: AIUsage = data?.usage
          ? {
              inputTokens: data.usage.prompt_tokens ?? null,
              outputTokens: data.usage.completion_tokens ?? null,
              cacheReadTokens: data.usage.prompt_tokens_details?.cached_tokens ?? null,
            }
          : NO_USAGE;
        this.opts.pacer?.settle(
          slot ?? null,
          data?.usage?.total_tokens ??
            (usage.inputTokens !== null && usage.outputTokens !== null
              ? usage.inputTokens + usage.outputTokens
              : null),
        );
        const choice = data?.choices?.[0];
        if (!choice?.message)
          throw new AIProviderError("invalid_output", "The AI API returned no message", { usage });
        if (choice.message.refusal || choice.finish_reason === "content_filter")
          throw new AIProviderError("refusal", "The model declined the request", { usage });
        if (choice.finish_reason === "length")
          throw new AIProviderError(
            "truncated",
            `The AI response was cut off at the output limit (AI_MAX_OUTPUT_TOKENS=${this.opts.maxOutputTokens})`,
            { usage },
          );
        return {
          data: parseStructured(choice.message.content ?? "", req.schema, usage),
          usage,
          model: data?.model ?? this.model,
          latencyMs: Date.now() - started,
          stopReason: choice.finish_reason ?? null,
          fallbackUsed: false,
          attempts: attempt + 1,
        };
      }
    } finally {
      deadline.dispose();
    }
  }
}
