import { AIProviderError } from "./types";

/** Characters per token used for estimates before a request is sent (JSON-heavy input). */
export const CHARS_PER_TOKEN_ESTIMATE = 3;

export const estimateTokens = (chars: number) => Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE);

export interface PacingLimits {
  /** Requests per rolling minute; 0 = no client-side limit. */
  requestsPerMinute: number;
  /** Input + output tokens per rolling minute; 0 = no client-side limit. */
  tokensPerMinute: number;
}

interface Entry {
  at: number;
  tokens: number;
}

const WINDOW_MS = 60_000;

/**
 * Client-side pacing for providers with per-minute limits (free tiers): a request waits until it
 * fits into the rolling minute instead of being sent and rejected with HTTP 429. It never
 * replaces the provider's own limits (429 + Retry-After are still handled by the provider), and
 * it only covers requests made by this process.
 */
export class RequestPacer {
  private entries: Entry[] = [];
  private queue: Promise<void> = Promise.resolve();

  constructor(
    readonly limits: PacingLimits,
    private readonly now: () => number = Date.now,
  ) {}

  get enabled() {
    return this.limits.requestsPerMinute > 0 || this.limits.tokensPerMinute > 0;
  }

  /**
   * Waits for a slot for a request of about `tokens` tokens. Requests are admitted in order.
   * Returns the entry, so the estimate can be replaced by the real usage afterwards.
   */
  async acquire(tokens: number, signal?: AbortSignal): Promise<Entry | null> {
    if (!this.enabled) return null;
    const { tokensPerMinute: tpm } = this.limits;
    if (tpm > 0 && tokens > tpm)
      throw new AIProviderError(
        "too_large",
        `One request needs about ${tokens} tokens, more than AI_TOKENS_PER_MINUTE=${tpm}; lower AI_MAX_INPUT_TOKENS (and AI_MAX_OUTPUT_TOKENS) so a request fits into the per-minute budget`,
      );
    const turn = this.queue.then(() => this.waitForSlot(tokens, signal));
    // A cancelled waiter must not block the ones behind it.
    this.queue = turn.then(
      () => undefined,
      () => undefined,
    );
    return turn;
  }

  /** Replaces a request's estimate with its actual token usage. */
  settle(entry: Entry | null, actualTokens: number | null) {
    if (entry && actualTokens !== null && Number.isFinite(actualTokens))
      entry.tokens = actualTokens;
  }

  /** Milliseconds until a request of `tokens` tokens fits (0 = now). */
  waitTime(tokens: number): number {
    const t = this.now();
    this.entries = this.entries.filter((e) => t - e.at < WINDOW_MS);
    const { requestsPerMinute: rpm, tokensPerMinute: tpm } = this.limits;
    let wait = 0;
    if (rpm > 0 && this.entries.length >= rpm) {
      const oldest = this.entries[this.entries.length - rpm]!;
      wait = Math.max(wait, oldest.at + WINDOW_MS - t);
    }
    if (tpm > 0) {
      let used = this.entries.reduce((s, e) => s + e.tokens, 0);
      // Drop the oldest entries until the request fits; it fits once they leave the window.
      for (const e of this.entries) {
        if (used + tokens <= tpm) break;
        used -= e.tokens;
        wait = Math.max(wait, e.at + WINDOW_MS - t);
      }
    }
    return wait;
  }

  private async waitForSlot(tokens: number, signal?: AbortSignal): Promise<Entry> {
    for (;;) {
      if (signal?.aborted)
        throw new AIProviderError("aborted", "The AI request was cancelled while waiting");
      const wait = this.waitTime(tokens);
      if (wait <= 0) {
        const entry = { at: this.now(), tokens };
        this.entries.push(entry);
        return entry;
      }
      await abortableSleep(wait + 25, signal);
    }
  }
}

/** Sleeps `ms`, resolving early (without throwing) when `signal` aborts. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

const pacers = new Map<string, RequestPacer>();

/**
 * One pacer per provider + model + limits in this process, so concurrent scans and reference
 * jobs of one worker share the same per-minute budget.
 */
export function sharedPacer(key: string, limits: PacingLimits): RequestPacer {
  const full = `${key}|${limits.requestsPerMinute}|${limits.tokensPerMinute}`;
  let p = pacers.get(full);
  if (!p) pacers.set(full, (p = new RequestPacer(limits)));
  return p;
}
