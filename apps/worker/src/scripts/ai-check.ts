/**
 * AI provider check: validates the AI configuration and sends one tiny structured request.
 *
 *   npm run ai:check
 *
 * Uses one request of the provider's quota. No scan data is sent. The API key is never printed.
 * Exit code 0 = the provider answered correctly (or AI is off), 1 = it did not, 2 = invalid config.
 */
import { checkAIProvider, createAIProvider } from "@qa/ai";
import { ConfigError, describeConfig, getConfig } from "@qa/core";

let config;
try {
  config = getConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(2);
  }
  throw err;
}

const summary = describeConfig(config);
console.log(`AI provider:  ${summary.aiProvider}${summary.aiModel ? ` · ${summary.aiModel}` : ""}`);
if (summary.aiConfigured) {
  const l = summary.aiLimits;
  console.log(
    `Limits:       ${l.requestsPerMinute || "no"} requests/min, ${l.tokensPerMinute || "no"} tokens/min (client-side), ` +
      `${l.maxInputTokens} input / ${l.maxOutputTokens} output tokens per request, ${l.maxIssuesPerScan} issues per scan, ` +
      `concurrency ${l.concurrency}, ${l.maxRetries} retries`,
  );
  if (summary.aiDataNotice) console.log(`Data use:     ${summary.aiDataNotice}`);
}

const result = await checkAIProvider(createAIProvider(config), AbortSignal.timeout(120_000));
if (result.ok) {
  console.log(
    `Result:       OK — answered by ${result.servedModel} in ${result.latencyMs} ms` +
      ` (${result.inputTokens ?? "?"} input / ${result.outputTokens ?? "?"} output tokens, ${result.attempts} attempt(s))`,
  );
} else if (result.error?.code === "not_configured") {
  console.log("Result:       AI is off");
} else {
  console.log(`Result:       FAILED (${result.error?.code}) — ${result.error?.message}`);
}
console.log(`Meaning:      ${result.advice}`);
process.exit(result.ok || result.error?.code === "not_configured" ? 0 : 1);
