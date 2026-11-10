import { buildBatchInput, SYSTEM_PROMPT, type PreparedGroup } from "./prompt";
import {
  AIProviderError,
  FATAL_AI_ERRORS,
  NO_USAGE,
  type AIProvider,
  type AIUsage,
} from "./providers/types";
import { AI_BATCH_JSON_SCHEMA, AI_BATCH_SCHEMA_NAME, aiBatchSchema, type AiIssue } from "./schema";

export const MAX_GROUPS_PER_BATCH = 10;
export const MAX_BATCH_INPUT_CHARS = 60_000;
/** Issues beyond this count keep the scanners' wording (bounds cost and time on huge scans). */
export const MAX_AI_GROUPS = 200;

export interface InterpretationBatch {
  index: number;
  category: string;
  groups: PreparedGroup[];
  input: string;
  /** A single group whose input alone exceeds the limit: not sent (it keeps the scanners' wording). */
  oversize?: boolean;
}

/**
 * Splits the groups into requests: one category per batch (batching by category), at most
 * MAX_GROUPS_PER_BATCH groups and MAX_BATCH_INPUT_CHARS characters of input each (both
 * configurable; the character limit follows AI_MAX_INPUT_TOKENS in the worker).
 */
export function planBatches(
  prepared: PreparedGroup[],
  limits: { maxGroups?: number; maxChars?: number; maxTotal?: number } = {},
): InterpretationBatch[] {
  const maxGroups = limits.maxGroups ?? MAX_GROUPS_PER_BATCH;
  const maxChars = limits.maxChars ?? MAX_BATCH_INPUT_CHARS;
  const byCategory = new Map<string, PreparedGroup[]>();
  for (const p of prepared.slice(0, limits.maxTotal ?? MAX_AI_GROUPS))
    byCategory.set(p.group.category, [...(byCategory.get(p.group.category) ?? []), p]);
  const batches: InterpretationBatch[] = [];
  const flush = (category: string, groups: PreparedGroup[]) => {
    if (!groups.length) return;
    const input = buildBatchInput(groups);
    batches.push({
      index: batches.length,
      category,
      groups,
      input,
      ...(input.length > maxChars ? { oversize: true } : {}),
    });
  };
  for (const [category, list] of byCategory) {
    let current: PreparedGroup[] = [];
    for (const p of list) {
      const candidate = [...current, p];
      if (
        current.length &&
        (candidate.length > maxGroups || buildBatchInput(candidate).length > maxChars)
      ) {
        flush(category, current);
        current = [p];
      } else current = candidate;
    }
    flush(category, current);
  }
  return batches;
}

export type BatchStatus = "completed" | "failed" | "skipped";

export interface BatchResult {
  index: number;
  category: string;
  groupIds: string[];
  status: BatchStatus;
  /** Structurally valid AI issues (not yet grounded); empty unless completed. */
  issues: AiIssue[];
  error: { code: string; message: string } | null;
  usage: AIUsage;
  latencyMs: number | null;
  /** Model that answered (may be a refusal fallback model). */
  model: string | null;
  stopReason: string | null;
  fallbackUsed: boolean;
  inputChars: number;
  /** HTTP attempts including retries (null when not sent). */
  attempts?: number | null;
}

export interface InterpretOptions {
  provider: AIProvider;
  prepared: PreparedGroup[];
  concurrency: number;
  /** Aborts outstanding requests (scan cancelled or the AI time budget used up). */
  signal?: AbortSignal;
  /** Called as each batch finishes (e.g. to record the AI run). */
  onBatch?: (result: BatchResult) => void | Promise<void>;
  limits?: { maxGroups?: number; maxChars?: number; maxTotal?: number };
}

/**
 * Sends each batch to the provider. A failing batch affects only its own groups (they keep the
 * scanners' wording); after a configuration error (credentials, model, rejected request) the
 * remaining batches are not sent because they would fail the same way.
 */
export async function interpretGroups(opts: InterpretOptions): Promise<BatchResult[]> {
  const batches = planBatches(opts.prepared, opts.limits);
  const results: BatchResult[] = [];
  let fatal: AIProviderError | null = null;
  let next = 0;
  const base = (b: InterpretationBatch) => ({
    index: b.index,
    category: b.category,
    groupIds: b.groups.map((g) => g.group.id),
    issues: [] as AiIssue[],
    error: null,
    usage: NO_USAGE,
    latencyMs: null,
    model: null,
    stopReason: null,
    fallbackUsed: false,
    inputChars: b.input.length,
    attempts: null,
  });
  const worker = async () => {
    while (next < batches.length) {
      const b = batches[next++]!;
      if (b.oversize) {
        results[b.index] = {
          ...base(b),
          status: "skipped",
          error: {
            code: "too_large_input",
            message: `Not sent: this issue's data (${b.input.length} characters) exceeds the request size limit (AI_MAX_INPUT_TOKENS)`,
          },
        };
        await opts.onBatch?.(results[b.index]!);
        continue;
      }
      if (fatal || opts.signal?.aborted) {
        results[b.index] = {
          ...base(b),
          status: "skipped",
          error: {
            code: fatal ? "not_sent" : "aborted",
            message: fatal
              ? `Not sent after an earlier request failed: ${fatal.message}`
              : "Not sent: the AI time budget was used up or the scan was cancelled",
          },
        };
        await opts.onBatch?.(results[b.index]!);
        continue;
      }
      const started = Date.now();
      try {
        const r = await opts.provider.generateStructured({
          system: SYSTEM_PROMPT,
          input: b.input,
          schema: aiBatchSchema,
          jsonSchema: AI_BATCH_JSON_SCHEMA,
          schemaName: AI_BATCH_SCHEMA_NAME,
          signal: opts.signal,
        });
        results[b.index] = {
          ...base(b),
          status: "completed",
          issues: r.data.issues,
          usage: r.usage,
          latencyMs: r.latencyMs,
          model: r.model,
          stopReason: r.stopReason,
          fallbackUsed: r.fallbackUsed,
          attempts: r.attempts ?? 1,
        };
      } catch (err) {
        const e =
          err instanceof AIProviderError
            ? err
            : new AIProviderError(
                "invalid_output",
                `Unexpected AI error: ${(err as Error).message}`,
              );
        if (FATAL_AI_ERRORS.has(e.code)) fatal ??= e;
        results[b.index] = {
          ...base(b),
          status: "failed",
          error: { code: e.code, message: e.message },
          usage: e.usage ?? NO_USAGE,
          latencyMs: Date.now() - started,
        };
      }
      await opts.onBatch?.(results[b.index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(opts.concurrency, batches.length)) }, worker),
  );
  return results;
}
