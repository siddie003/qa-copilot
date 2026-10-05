import http from "node:http";
import type { AddressInfo } from "node:net";
import { parseConfig } from "@qa/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  AnthropicProvider,
  createAIProvider,
  NoAIProvider,
  OpenAICompatibleProvider,
  REFUSAL_FALLBACK_BETA,
  type AIProviderError,
} from "./providers";
import { AI_BATCH_JSON_SCHEMA, AI_BATCH_SCHEMA_NAME, aiBatchSchema } from "./schema";

/**
 * Providers against local mock servers that follow the documented wire formats (Anthropic
 * Messages API with server-sent events; OpenAI Chat Completions). No real API is called.
 */

interface Recorded {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => {
      s.closeAllConnections();
      return new Promise((r) => s.close(r));
    }),
  );
});

async function mockServer(
  respond: (req: Recorded, res: http.ServerResponse, n: number) => void,
): Promise<{ url: string; requests: Recorded[] }> {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const rec = {
        method: req.method!,
        url: req.url!,
        headers: req.headers,
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
      };
      requests.push(rec);
      respond(rec, res, requests.length);
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

const VALID = JSON.stringify({ issues: [] });

function sseMessage(
  res: http.ServerResponse,
  text: string,
  opts: {
    stopReason?: string;
    stopDetails?: Record<string, unknown> | null;
    model?: string;
    iterations?: Array<Record<string, unknown>>;
  } = {},
) {
  res.writeHead(200, { "content-type": "text/event-stream", "request-id": "req_test" });
  const send = (event: string, data: Record<string, unknown>) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
  send("message_start", {
    message: {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: opts.model ?? "claude-opus-5-5",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      stop_details: null,
      usage: { input_tokens: 1200, output_tokens: 1, cache_read_input_tokens: 800 },
    },
  });
  send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
  for (const part of [text.slice(0, 5), text.slice(5)])
    if (part) send("content_block_delta", { index: 0, delta: { type: "text_delta", text: part } });
  send("content_block_stop", { index: 0 });
  send("message_delta", {
    delta: {
      stop_reason: opts.stopReason ?? "end_turn",
      stop_sequence: null,
      stop_details: opts.stopDetails ?? null,
    },
    usage: { output_tokens: 345, ...(opts.iterations ? { iterations: opts.iterations } : {}) },
  });
  send("message_stop", {});
  res.end();
}

const request = (signal?: AbortSignal) => ({
  system: "SYSTEM",
  input: "INPUT",
  schema: aiBatchSchema,
  jsonSchema: AI_BATCH_JSON_SCHEMA,
  schemaName: AI_BATCH_SCHEMA_NAME,
  signal,
});

const anthropic = (
  url: string,
  extra: Partial<ConstructorParameters<typeof AnthropicProvider>[0]> = {},
) =>
  new AnthropicProvider({
    apiKey: "sk-ant-test-key",
    model: "claude-opus-5-5",
    maxOutputTokens: 16_000,
    timeoutMs: 5_000,
    refusalFallback: true,
    baseURL: url,
    maxRetries: 0,
    ...extra,
  });

describe("Anthropic provider (mock Messages API)", () => {
  it("sends a structured-output request and returns validated data with usage", async () => {
    const api = await mockServer((_req, res) => sseMessage(res, VALID));
    const r = await anthropic(api.url, { effort: "medium" }).generateStructured(request());
    expect(r.data).toEqual({ issues: [] });
    expect(r).toMatchObject({
      model: "claude-opus-5-5",
      stopReason: "end_turn",
      fallbackUsed: false,
      usage: { inputTokens: 1200, outputTokens: 345, cacheReadTokens: 800 },
    });
    const req = api.requests[0]!;
    expect(req.url).toMatch(/^\/v1\/messages/);
    expect(req.headers["x-api-key"]).toBe("sk-ant-test-key");
    expect(req.headers["anthropic-version"]).toBe("2023-06-01");
    expect(req.headers["anthropic-beta"]).toBe(REFUSAL_FALLBACK_BETA);
    expect(req.body).toMatchObject({
      model: "claude-opus-5-5",
      max_tokens: 16_000,
      stream: true,
      fallbacks: "default",
      system: [{ type: "text", text: "SYSTEM", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "INPUT" }],
      output_config: {
        effort: "medium",
        format: { type: "json_schema", schema: AI_BATCH_JSON_SCHEMA },
      },
    });
    // Current Claude models reject sampling parameters; no thinking override is sent.
    expect(req.body).not.toHaveProperty("temperature");
    expect(req.body).not.toHaveProperty("thinking");
    expect(req.body).not.toHaveProperty("betas");
  });

  it("opts into refusal fallbacks only for supported models and when enabled", async () => {
    const api = await mockServer((_req, res) => sseMessage(res, VALID));
    await anthropic(api.url, { model: "claude-haiku-4-5" }).generateStructured(request());
    await anthropic(api.url, { refusalFallback: false }).generateStructured(request());
    for (const r of api.requests) {
      expect(r.headers["anthropic-beta"]).toBeUndefined();
      expect(r.body).not.toHaveProperty("fallbacks");
      expect(r.body.output_config).not.toHaveProperty("effort");
    }
  });

  it("reports the serving model and sums all attempts when a fallback answered", async () => {
    const api = await mockServer((_req, res) =>
      sseMessage(res, VALID, {
        model: "claude-opus-4-8",
        iterations: [
          {
            type: "message",
            model: "claude-opus-5-5",
            input_tokens: 1000,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          {
            type: "fallback_message",
            model: "claude-opus-4-8",
            input_tokens: 1100,
            output_tokens: 300,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        ],
      }),
    );
    const r = await anthropic(api.url).generateStructured(request());
    expect(r).toMatchObject({
      model: "claude-opus-4-8",
      fallbackUsed: true,
      usage: { inputTokens: 2100, outputTokens: 300 },
    });
  });

  it("turns refusals, truncation and invalid output into typed errors", async () => {
    const outcomes = [
      () => ({
        text: "",
        opts: {
          stopReason: "refusal",
          stopDetails: { type: "refusal", category: "cyber", explanation: null },
        },
      }),
      () => ({ text: '{"issues": [', opts: { stopReason: "max_tokens" } }),
      () => ({ text: "not json", opts: {} }),
      () => ({ text: JSON.stringify({ issues: [{ groupId: "G1" }] }), opts: {} }),
    ];
    const api = await mockServer((_req, res, n) => {
      const o = outcomes[n - 1]!();
      sseMessage(res, o.text, o.opts);
    });
    const p = anthropic(api.url);
    const errors: AIProviderError[] = [];
    for (let i = 0; i < outcomes.length; i++)
      errors.push(
        await p.generateStructured(request()).then(
          () => {
            throw new Error("expected failure");
          },
          (e: AIProviderError) => e,
        ),
      );
    expect(errors.map((e) => e.code)).toEqual([
      "refusal",
      "truncated",
      "invalid_output",
      "invalid_output",
    ]);
    expect(errors[0]!.message).toMatch(/safety category: cyber.*no fallback model accepted it/);
    expect(errors[0]!.usage).toMatchObject({ inputTokens: 1200 });
    expect(errors[1]!.message).toMatch(/AI_MAX_OUTPUT_TOKENS=16000/);
    expect(errors[3]!.message).toMatch(/does not match the expected structure \(issues\.0\./);
    // Response text never appears in errors.
    expect(errors.map((e) => e.message).join(" ")).not.toContain("not json");
  });

  it("maps HTTP errors to stable codes without leaking the key", async () => {
    const statuses = [401, 404, 400, 429, 529];
    const api = await mockServer((_req, res, n) => {
      res.writeHead(statuses[n - 1]!, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          type: "error",
          error: { type: "invalid_request_error", message: "nope" },
        }),
      );
    });
    const p = anthropic(api.url);
    const codes: string[] = [];
    for (let i = 0; i < statuses.length; i++)
      codes.push(
        await p.generateStructured(request()).then(
          () => "ok",
          (e: AIProviderError) => {
            expect(e.message).not.toContain("sk-ant-test-key");
            return e.code;
          },
        ),
      );
    expect(codes).toEqual(["auth", "not_found", "bad_request", "rate_limit", "unavailable"]);
  });

  it("times out and distinguishes a timeout from a cancellation", async () => {
    const api = await mockServer(() => {
      /* never answers */
    });
    const slow = anthropic(api.url, { timeoutMs: 200 });
    await expect(slow.generateStructured(request())).rejects.toMatchObject({ code: "timeout" });
    const controller = new AbortController();
    const pending = anthropic(api.url).generateStructured(request(controller.signal));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
  });
});

describe("OpenAI-compatible provider (mock Chat Completions API)", () => {
  const openai = (url: string) =>
    new OpenAICompatibleProvider({
      apiKey: "sk-openai-test",
      model: "gpt-test",
      baseUrl: `${url}/v1`,
      temperature: 0,
      maxOutputTokens: 4000,
      timeoutMs: 5_000,
    });
  const completion = (content: string | null, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      model: "gpt-test-2026",
      choices: [{ finish_reason: "stop", message: { content }, ...extra }],
      usage: { prompt_tokens: 900, completion_tokens: 120 },
    });

  it("sends a strict JSON-schema request and validates the response", async () => {
    const api = await mockServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(completion(VALID));
    });
    const r = await openai(api.url).generateStructured(request());
    expect(r).toMatchObject({
      data: { issues: [] },
      model: "gpt-test-2026",
      usage: { inputTokens: 900, outputTokens: 120 },
    });
    const req = api.requests[0]!;
    expect(req.url).toBe("/v1/chat/completions");
    expect(req.headers.authorization).toBe("Bearer sk-openai-test");
    expect(req.body).toMatchObject({
      model: "gpt-test",
      temperature: 0,
      max_tokens: 4000,
      messages: [
        { role: "system", content: "SYSTEM" },
        { role: "user", content: "INPUT" },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: AI_BATCH_SCHEMA_NAME, strict: true, schema: AI_BATCH_JSON_SCHEMA },
      },
    });
  });

  it("retries rate limits and server errors, then succeeds", async () => {
    const api = await mockServer((_req, res, n) => {
      if (n <= 2) {
        res.writeHead(n === 1 ? 429 : 503, { "retry-after": "0" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(completion(VALID));
    });
    await expect(openai(api.url).generateStructured(request())).resolves.toMatchObject({
      data: { issues: [] },
    });
    expect(api.requests).toHaveLength(3);
  });

  it("maps refusals, truncation and credential errors", async () => {
    const replies: Array<[number, string]> = [
      [200, completion(null, { message: { refusal: "I can't help with that" } })],
      [200, JSON.stringify({ choices: [{ finish_reason: "length", message: { content: "{" } }] })],
      [401, "{}"],
    ];
    const api = await mockServer((_req, res, n) => {
      res.writeHead(replies[n - 1]![0], { "content-type": "application/json" });
      res.end(replies[n - 1]![1]);
    });
    const p = openai(api.url);
    const codes = [];
    for (let i = 0; i < replies.length; i++)
      codes.push(
        await p.generateStructured(request()).then(
          () => "ok",
          (e: AIProviderError) => e.code,
        ),
      );
    expect(codes).toEqual(["refusal", "truncated", "auth"]);
  });
});

describe("provider selection", () => {
  const base = {
    DATABASE_URL: "postgres://qa:pw@localhost:5432/qa_test",
    BETTER_AUTH_SECRET: "x".repeat(40),
  };
  it("uses no AI by default", async () => {
    const p = createAIProvider(parseConfig(base));
    expect(p).toBeInstanceOf(NoAIProvider);
    await expect((p as NoAIProvider).generateStructured()).rejects.toMatchObject({
      code: "not_configured",
    });
  });

  it("builds the configured provider", () => {
    const a = createAIProvider(
      parseConfig({
        ...base,
        AI_PROVIDER: "anthropic",
        AI_MODEL: "claude-opus-5-5",
        ANTHROPIC_API_KEY: "k",
      }),
    );
    expect(a).toBeInstanceOf(AnthropicProvider);
    expect((a as AnthropicProvider).refusalFallback).toBe(true);
    const off = createAIProvider(
      parseConfig({
        ...base,
        AI_PROVIDER: "anthropic",
        AI_MODEL: "claude-opus-5-5",
        ANTHROPIC_API_KEY: "k",
        AI_REFUSAL_FALLBACK: "false",
      }),
    );
    expect((off as AnthropicProvider).refusalFallback).toBe(false);
    const o = createAIProvider(
      parseConfig({
        ...base,
        AI_PROVIDER: "openai-compatible",
        AI_MODEL: "m",
        OPENAI_API_KEY: "k",
      }),
    );
    expect(o).toBeInstanceOf(OpenAICompatibleProvider);
    expect(o.model).toBe("m");
  });
});
