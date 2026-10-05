import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaMessage,
  BetaMessageStreamParams,
} from "@anthropic-ai/sdk/resources/beta/messages";
import {
  AIProviderError,
  deadlineSignal,
  parseStructured,
  type AIProvider,
  type AIUsage,
  type StructuredRequest,
  type StructuredResult,
} from "./types";

/**
 * Models that accept server-side refusal fallbacks in the "default" form: a request declined by
 * a safety classifier is re-run on the model Anthropic recommends for that refusal category
 * (security findings can trip the cyber classifier on benign QA data).
 */
export const REFUSAL_FALLBACK_MODELS = new Set([
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-sonnet-5-5",
]);
export const REFUSAL_FALLBACK_BETA = "server-side-fallback-2026-07-01";

export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  maxOutputTokens: number;
  timeoutMs: number;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  refusalFallback: boolean;
  /** API base URL (tests point it at a local mock). */
  baseURL?: string;
  maxRetries?: number;
}

/** Sums all attempts when a fallback served the response (top-level usage covers only the last). */
function usageOf(message: BetaMessage): AIUsage {
  const u = message.usage;
  const iterations = u.iterations ?? [];
  if (iterations.length > 1)
    return {
      inputTokens: iterations.reduce((s, i) => s + (i.input_tokens ?? 0), 0),
      outputTokens: iterations.reduce((s, i) => s + (i.output_tokens ?? 0), 0),
      cacheReadTokens: iterations.reduce(
        (s, i) => s + ("cache_read_input_tokens" in i ? (i.cache_read_input_tokens ?? 0) : 0),
        0,
      ),
    };
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadTokens: u.cache_read_input_tokens ?? null,
  };
}

function toProviderError(err: unknown, timedOut: boolean): AIProviderError {
  if (err instanceof AIProviderError) return err;
  const status = err instanceof Anthropic.APIError ? (err.status ?? null) : null;
  const opts = { status, cause: err };
  if (err instanceof Anthropic.APIUserAbortError)
    return timedOut
      ? new AIProviderError("timeout", "The AI request timed out", opts)
      : new AIProviderError("aborted", "The AI request was cancelled", opts);
  if (err instanceof Anthropic.APIConnectionTimeoutError)
    return new AIProviderError("timeout", "The AI request timed out", opts);
  if (err instanceof Anthropic.APIConnectionError)
    return new AIProviderError("network", "The Anthropic API could not be reached", opts);
  if (
    err instanceof Anthropic.AuthenticationError ||
    err instanceof Anthropic.PermissionDeniedError
  )
    return new AIProviderError(
      "auth",
      `The Anthropic API rejected the credentials (HTTP ${status}); check ANTHROPIC_API_KEY`,
      opts,
    );
  if (err instanceof Anthropic.NotFoundError)
    return new AIProviderError(
      "not_found",
      "The Anthropic API returned HTTP 404; check AI_MODEL",
      opts,
    );
  if (err instanceof Anthropic.RateLimitError)
    return new AIProviderError("rate_limit", "The Anthropic API rate limit was exceeded", opts);
  if (err instanceof Anthropic.BadRequestError || err instanceof Anthropic.UnprocessableEntityError)
    return new AIProviderError(
      "bad_request",
      `The Anthropic API rejected the request (HTTP ${status}): ${(err as Error).message.slice(0, 300)}`,
      opts,
    );
  if (err instanceof Anthropic.APIError)
    return new AIProviderError(
      "unavailable",
      `The Anthropic API is unavailable (HTTP ${status ?? "error"})`,
      opts,
    );
  return new AIProviderError("invalid_output", `Unexpected AI error: ${(err as Error).message}`, {
    cause: err,
  });
}

/** Claude through the official SDK, with structured JSON output validated by zod. */
export class AnthropicProvider implements AIProvider {
  readonly id = "anthropic" as const;
  readonly label = "Anthropic Messages API";
  readonly model: string;
  private readonly client: Anthropic;

  constructor(private readonly opts: AnthropicProviderOptions) {
    this.model = opts.model;
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
      maxRetries: opts.maxRetries ?? 2,
      timeout: opts.timeoutMs,
    });
  }

  /** Whether requests opt into server-side refusal fallbacks (AI_REFUSAL_FALLBACK + model). */
  get refusalFallback(): boolean {
    return this.opts.refusalFallback && REFUSAL_FALLBACK_MODELS.has(this.model);
  }

  async generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const started = Date.now();
    const deadline = deadlineSignal(this.opts.timeoutMs, req.signal);
    try {
      // No temperature (current models reject sampling parameters) and no thinking setting
      // (each model's default applies; adaptive thinking on the models that think).
      const params: BetaMessageStreamParams = {
        model: this.model,
        max_tokens: this.opts.maxOutputTokens,
        system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: req.input }],
        output_config: {
          format: { type: "json_schema", schema: req.jsonSchema },
          ...(this.opts.effort ? { effort: this.opts.effort } : {}),
        },
        ...(this.refusalFallback
          ? { betas: [REFUSAL_FALLBACK_BETA], fallbacks: "default" as const }
          : {}),
      };
      // Streaming keeps long generations (thinking + a batch of issues) clear of HTTP timeouts.
      const message = await this.client.beta.messages
        .stream(params, { signal: deadline.signal })
        .finalMessage();
      const usage = usageOf(message);
      if (message.stop_reason === "refusal") {
        const category = message.stop_details?.category;
        throw new AIProviderError(
          "refusal",
          `The model declined the request${category ? ` (safety category: ${category})` : ""}${this.refusalFallback ? " and no fallback model accepted it" : ""}`,
          { usage },
        );
      }
      if (
        message.stop_reason === "max_tokens" ||
        message.stop_reason === "model_context_window_exceeded"
      )
        throw new AIProviderError(
          "truncated",
          `The AI response was cut off at the output limit (AI_MAX_OUTPUT_TOKENS=${this.opts.maxOutputTokens})`,
          { usage },
        );
      const text = message.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
      const data = parseStructured(text, req.schema, usage);
      return {
        data,
        usage,
        model: message.model,
        latencyMs: Date.now() - started,
        stopReason: message.stop_reason,
        fallbackUsed: (message.usage.iterations ?? []).some((i) => i.type === "fallback_message"),
      };
    } catch (err) {
      throw toProviderError(err, deadline.timedOut());
    } finally {
      deadline.dispose();
    }
  }
}
