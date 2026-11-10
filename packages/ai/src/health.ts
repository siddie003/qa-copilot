import { z } from "zod";
import { AIProviderError, type AIErrorCode, type AIProvider } from "./providers/types";
import { toStructuredOutputSchema } from "./schema";

const healthSchema = z.object({ status: z.enum(["ok"]), echo: z.string() });

export interface AIHealthResult {
  ok: boolean;
  provider: string;
  model: string;
  /** Model that answered (may differ from the configured id, e.g. a dated version). */
  servedModel: string | null;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  attempts: number | null;
  error: { code: AIErrorCode | "unexpected"; message: string } | null;
  /** What the result means for scans, in plain words. */
  advice: string;
}

const ADVICE: Partial<Record<AIErrorCode, string>> = {
  not_configured:
    "AI is off (AI_PROVIDER=none). Scans still run; issues use the scanners' wording.",
  auth: "The API key was rejected. Check the key variable for this provider and that the key is active.",
  not_found: "The model was not found. Check AI_MODEL against the provider's model list.",
  bad_request:
    "The provider rejected the request format. If this model has no strict JSON-schema support, set AI_STRUCTURED_OUTPUT=json_object.",
  too_large: "The request does not fit the provider's limits; lower AI_MAX_INPUT_TOKENS.",
  rate_limit:
    "The provider's rate limit was hit. Set AI_REQUESTS_PER_MINUTE / AI_TOKENS_PER_MINUTE to your plan's limits.",
  quota_exhausted:
    "The quota is used up. AI analysis is skipped until it resets (scans still run with the scanners' wording).",
  timeout: "The provider did not answer in time (AI_TIMEOUT_MS).",
  network: "The provider could not be reached from this machine.",
  unavailable: "The provider reported a server error; try again later.",
  invalid_output:
    "The model answered, but not with JSON matching the schema. Try AI_STRUCTURED_OUTPUT=json_object or another model.",
  truncated: "The answer was cut off; raise AI_MAX_OUTPUT_TOKENS.",
  refusal: "The model declined the test request.",
};

/**
 * Sends one tiny structured request to check credentials, model and structured output. It uses
 * one request of the provider's quota; nothing from any scan is sent.
 */
export async function checkAIProvider(
  provider: AIProvider,
  signal?: AbortSignal,
): Promise<AIHealthResult> {
  const base = { provider: provider.id, model: provider.model };
  if (provider.id === "none")
    return {
      ...base,
      ok: false,
      servedModel: null,
      latencyMs: null,
      inputTokens: null,
      outputTokens: null,
      attempts: null,
      error: { code: "not_configured", message: "No AI provider is configured" },
      advice: ADVICE.not_configured!,
    };
  try {
    const r = await provider.generateStructured({
      system:
        'You are a connectivity check. Reply with JSON: {"status":"ok","echo":"<the word you were given>"}.',
      input: "The word is: qa-copilot",
      schema: healthSchema,
      jsonSchema: toStructuredOutputSchema(healthSchema),
      schemaName: "health_check",
      signal,
    });
    return {
      ...base,
      ok: true,
      servedModel: r.model,
      latencyMs: r.latencyMs,
      inputTokens: r.usage.inputTokens,
      outputTokens: r.usage.outputTokens,
      attempts: r.attempts ?? 1,
      error: null,
      advice:
        "The provider answered with valid structured output. AI analysis will run on the next scan.",
    };
  } catch (err) {
    const e =
      err instanceof AIProviderError
        ? { code: err.code, message: err.message }
        : { code: "unexpected" as const, message: (err as Error).message };
    return {
      ...base,
      ok: false,
      servedModel: null,
      latencyMs: null,
      inputTokens: null,
      outputTokens: null,
      attempts: null,
      error: e,
      advice:
        (e.code !== "unexpected" && ADVICE[e.code]) || "Unexpected error; see the message above.",
    };
  }
}
