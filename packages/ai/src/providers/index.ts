import type { AppConfig } from "@qa/core";
import { AnthropicProvider } from "./anthropic";
import { OpenAICompatibleProvider } from "./openai-compatible";
import { sharedPacer } from "./pacing";
import { AIProviderError, type AIProvider, type StructuredResult } from "./types";

export * from "./types";
export { AnthropicProvider, REFUSAL_FALLBACK_BETA, REFUSAL_FALLBACK_MODELS } from "./anthropic";
export {
  classifyHttpError,
  OpenAICompatibleProvider,
  parseErrorBody,
  parseRetryAfter,
  sanitizeProviderMessage,
  type StructuredOutputMode,
} from "./openai-compatible";
export {
  abortableSleep,
  CHARS_PER_TOKEN_ESTIMATE,
  estimateTokens,
  RequestPacer,
  sharedPacer,
  type PacingLimits,
} from "./pacing";

/** Google Gemini API, OpenAI-compatible endpoint (ai.google.dev/gemini-api/docs/openai). */
export const GEMINI_OPENAI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
/** Groq API, OpenAI-compatible (console.groq.com/docs/openai). */
export const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

/** AI_PROVIDER=none: interpretation is skipped and issues use the scanners' own wording. */
export class NoAIProvider implements AIProvider {
  readonly id = "none" as const;
  readonly label = "No AI provider";
  readonly model = "";
  async generateStructured(): Promise<StructuredResult<never>> {
    throw new AIProviderError("not_configured", "No AI provider is configured (AI_PROVIDER=none)");
  }
}

export interface ProviderOverrides {
  /** Base URLs for tests (local mock servers). */
  anthropicBaseUrl?: string;
  openaiBaseUrl?: string;
  geminiBaseUrl?: string;
  groqBaseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Tests: shorter backoff steps. */
  retryBaseMs?: number;
}

/** AI_EFFORT mapped to the OpenAI-style `reasoning_effort` (low | medium | high). */
function reasoningEffort(effort: AppConfig["AI_EFFORT"]) {
  if (!effort) return undefined;
  return effort === "low" || effort === "medium" ? effort : "high";
}

/** The provider configured by environment variables (validated by @qa/core's config schema). */
export function createAIProvider(config: AppConfig, overrides: ProviderOverrides = {}): AIProvider {
  if (config.AI_PROVIDER === "anthropic")
    return new AnthropicProvider({
      apiKey: config.ANTHROPIC_API_KEY!,
      model: config.AI_MODEL!,
      maxOutputTokens: config.AI_MAX_OUTPUT_TOKENS,
      timeoutMs: config.AI_TIMEOUT_MS,
      effort: config.AI_EFFORT,
      refusalFallback: config.AI_REFUSAL_FALLBACK,
      baseURL: overrides.anthropicBaseUrl,
      maxRetries: config.AI_MAX_RETRIES,
    });
  if (config.AI_PROVIDER === "none") return new NoAIProvider();

  const preset = {
    "openai-compatible": {
      label: "OpenAI-compatible Chat Completions API",
      apiKey: config.OPENAI_API_KEY,
      apiKeyVariable: "OPENAI_API_KEY",
      baseUrl: overrides.openaiBaseUrl ?? config.OPENAI_BASE_URL,
      // Unchanged default for generic servers; the presets leave temperature to the provider.
      temperature: config.AI_TEMPERATURE ?? 0,
    },
    gemini: {
      label: "Google Gemini API",
      apiKey: config.GEMINI_API_KEY,
      apiKeyVariable: "GEMINI_API_KEY",
      baseUrl: overrides.geminiBaseUrl ?? GEMINI_OPENAI_BASE_URL,
      temperature: config.AI_TEMPERATURE,
    },
    groq: {
      label: "Groq API",
      apiKey: config.GROQ_API_KEY,
      apiKeyVariable: "GROQ_API_KEY",
      baseUrl: overrides.groqBaseUrl ?? GROQ_BASE_URL,
      temperature: config.AI_TEMPERATURE,
    },
  }[config.AI_PROVIDER];
  return new OpenAICompatibleProvider({
    id: config.AI_PROVIDER,
    label: preset.label,
    apiKey: preset.apiKey!,
    apiKeyVariable: preset.apiKeyVariable,
    baseUrl: preset.baseUrl,
    model: config.AI_MODEL!,
    temperature: preset.temperature,
    maxOutputTokens: config.AI_MAX_OUTPUT_TOKENS,
    timeoutMs: config.AI_TIMEOUT_MS,
    maxRetries: config.AI_MAX_RETRIES,
    maxRetryWaitMs: config.AI_MAX_RETRY_WAIT_MS,
    retryBaseMs: overrides.retryBaseMs,
    structuredOutput: config.AI_STRUCTURED_OUTPUT,
    reasoningEffort: reasoningEffort(config.AI_EFFORT),
    pacer: sharedPacer(`${config.AI_PROVIDER}:${config.AI_MODEL}`, {
      requestsPerMinute: config.AI_REQUESTS_PER_MINUTE,
      tokensPerMinute: config.AI_TOKENS_PER_MINUTE,
    }),
    fetchImpl: overrides.fetchImpl,
  });
}
