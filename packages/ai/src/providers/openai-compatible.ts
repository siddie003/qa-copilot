import {
  AIProviderError,
  deadlineSignal,
  NO_USAGE,
  parseStructured,
  type AIErrorCode,
  type AIProvider,
  type AIUsage,
  type StructuredRequest,
  type StructuredResult,
} from "./types";

export interface OpenAICompatibleOptions {
  apiKey: string;
  model: string;
  /** e.g. https://api.openai.com/v1 or a self-hosted server's /v1 URL. */
  baseUrl?: string;
  temperature: number;
  maxOutputTokens: number;
  timeoutMs: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
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
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

const STATUS_CODES: Array<[(s: number) => boolean, AIErrorCode]> = [
  [(s) => s === 401 || s === 403, "auth"],
  [(s) => s === 404, "not_found"],
  [(s) => s === 429, "rate_limit"],
  [(s) => s === 400 || s === 413 || s === 422, "bad_request"],
  [(s) => s >= 500, "unavailable"],
];

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

/**
 * Any server that implements the OpenAI Chat Completions API with JSON-schema response formats
 * (OpenAI, Azure OpenAI, vLLM, LM Studio, Ollama, ...). Plain HTTP, no SDK.
 */
export class OpenAICompatibleProvider implements AIProvider {
  readonly id = "openai-compatible" as const;
  readonly label = "OpenAI-compatible Chat Completions API";
  readonly model: string;
  private readonly baseUrl: string;

  constructor(private readonly opts: OpenAICompatibleOptions) {
    this.model = opts.model;
    this.baseUrl = (opts.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  }

  async generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const started = Date.now();
    const deadline = deadlineSignal(this.opts.timeoutMs, req.signal);
    const doFetch = this.opts.fetchImpl ?? fetch;
    const body = JSON.stringify({
      model: this.model,
      temperature: this.opts.temperature,
      max_tokens: this.opts.maxOutputTokens,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.input },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: req.schemaName, strict: true, schema: req.jsonSchema },
      },
    });
    const retries = this.opts.maxRetries ?? 2;
    try {
      for (let attempt = 0; ; attempt++) {
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
          if (deadline.signal.aborted)
            throw deadline.timedOut()
              ? new AIProviderError("timeout", "The AI request timed out", { cause: err })
              : new AIProviderError("aborted", "The AI request was cancelled", { cause: err });
          if (attempt < retries) {
            await sleep(500 * 3 ** attempt, deadline.signal);
            continue;
          }
          throw new AIProviderError("network", "The AI API could not be reached", { cause: err });
        }
        if (!res.ok) {
          const code = STATUS_CODES.find(([test]) => test(res.status))?.[1] ?? "unavailable";
          const detail = (await res.text().catch(() => "")).slice(0, 300);
          if ((code === "rate_limit" || code === "unavailable") && attempt < retries) {
            const after = Number(res.headers.get("retry-after"));
            await sleep(
              Number.isFinite(after) && after > 0
                ? Math.min(after * 1000, 10_000)
                : 500 * 3 ** attempt,
              deadline.signal,
            );
            continue;
          }
          throw new AIProviderError(
            code,
            code === "auth"
              ? `The AI API rejected the credentials (HTTP ${res.status}); check OPENAI_API_KEY`
              : code === "not_found"
                ? `The AI API returned HTTP 404; check AI_MODEL and OPENAI_BASE_URL`
                : `The AI API returned HTTP ${res.status}${detail ? `: ${detail}` : ""}`,
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
        };
      }
    } finally {
      deadline.dispose();
    }
  }
}
