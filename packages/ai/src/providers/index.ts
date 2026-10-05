import type { AppConfig } from "@qa/core";
import { AnthropicProvider } from "./anthropic";
import { OpenAICompatibleProvider } from "./openai-compatible";
import { AIProviderError, type AIProvider, type StructuredResult } from "./types";

export * from "./types";
export { AnthropicProvider, REFUSAL_FALLBACK_BETA, REFUSAL_FALLBACK_MODELS } from "./anthropic";
export { OpenAICompatibleProvider } from "./openai-compatible";

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
  fetchImpl?: typeof fetch;
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
    });
  if (config.AI_PROVIDER === "openai-compatible")
    return new OpenAICompatibleProvider({
      apiKey: config.OPENAI_API_KEY!,
      model: config.AI_MODEL!,
      baseUrl: overrides.openaiBaseUrl ?? config.OPENAI_BASE_URL,
      temperature: config.AI_TEMPERATURE,
      maxOutputTokens: config.AI_MAX_OUTPUT_TOKENS,
      timeoutMs: config.AI_TIMEOUT_MS,
      fetchImpl: overrides.fetchImpl,
    });
  return new NoAIProvider();
}
