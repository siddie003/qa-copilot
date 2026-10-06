import { AppError, getConfig } from "@qa/core";

/**
 * In-memory sliding-window rate limiting. State is per web process: with several web instances
 * each enforces its own limits (see docs/DEPLOYMENT.md). Keys are user ids or normalized email
 * addresses, never client IPs, so spoofed forwarding headers cannot bypass these limits.
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly maxKeys = 50_000) {}

  /** Records a hit unless the key is over its limit. `retryAfterMs` > 0 when refused. */
  hit(key: string, limit: number, windowMs: number, now = Date.now()) {
    const recent = this.recent(key, windowMs, now);
    if (recent.length >= limit)
      return { allowed: false, retryAfterMs: recent[0]! + windowMs - now, count: recent.length };
    recent.push(now);
    this.hits.set(key, recent);
    this.prune(windowMs, now);
    return { allowed: true, retryAfterMs: 0, count: recent.length };
  }

  /** Number of hits of `key` inside the window (does not record one). */
  count(key: string, windowMs: number, now = Date.now()) {
    return this.recent(key, windowMs, now).length;
  }

  /** When the oldest hit inside the window expires (ms from now), or 0. */
  retryAfterMs(key: string, windowMs: number, now = Date.now()) {
    const recent = this.recent(key, windowMs, now);
    return recent.length ? recent[0]! + windowMs - now : 0;
  }

  reset(key: string) {
    this.hits.delete(key);
  }

  private recent(key: string, windowMs: number, now: number) {
    return (this.hits.get(key) ?? []).filter((t) => t > now - windowMs);
  }

  private prune(windowMs: number, now: number) {
    if (this.hits.size <= this.maxKeys) return;
    for (const [key, times] of this.hits)
      if (!times.some((t) => t > now - windowMs)) this.hits.delete(key);
    // Still too many active keys: drop the oldest entries (insertion order).
    for (const key of this.hits.keys()) {
      if (this.hits.size <= this.maxKeys) break;
      this.hits.delete(key);
    }
  }
}

/**
 * Per-user limits for authenticated API requests. `api` applies to every request; the others
 * protect expensive operations (each scan runs a browser for minutes, uploads are parsed by the
 * worker, Figma reads use the project's token quota, reports render PDFs).
 */
export const RATE_LIMITS = {
  api: { limit: 600, windowMs: 60_000, what: "requests" },
  scan: { limit: 20, windowMs: 60 * 60_000, what: "scan starts" },
  upload: { limit: 30, windowMs: 10 * 60_000, what: "uploads" },
  report: { limit: 30, windowMs: 10 * 60_000, what: "report requests" },
  reference: { limit: 30, windowMs: 10 * 60_000, what: "design reference requests" },
  project: { limit: 30, windowMs: 60 * 60_000, what: "new projects" },
} as const;
export type RateLimitBucket = keyof typeof RATE_LIMITS;

const g = globalThis as unknown as { __qaApiLimiter?: SlidingWindowLimiter };
const apiLimiter = () => (g.__qaApiLimiter ??= new SlidingWindowLimiter());

/** RATE_LIMIT_ENABLED (default true; the integration test configuration turns it off). */
export function rateLimitingEnabled(): boolean {
  return getConfig().RATE_LIMIT_ENABLED;
}

const waitText = (ms: number) => {
  const s = Math.max(1, Math.ceil(ms / 1000));
  return s < 120 ? `${s} s` : `${Math.ceil(s / 60)} min`;
};

/** Throws 429 (with Retry-After) when the user is over the bucket's limit; records a hit otherwise. */
export function enforceRateLimit(
  userId: string,
  bucket: RateLimitBucket,
  opts: { limiter?: SlidingWindowLimiter; force?: boolean } = {},
): void {
  if (!opts.force && !rateLimitingEnabled()) return;
  const rule = RATE_LIMITS[bucket];
  const result = (opts.limiter ?? apiLimiter()).hit(
    `${bucket}:${userId}`,
    rule.limit,
    rule.windowMs,
  );
  if (result.allowed) return;
  const retryAfterSeconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
  throw new AppError(
    "RATE_LIMITED",
    `Too many ${rule.what} (limit ${rule.limit} per ${waitText(rule.windowMs)}). Try again in ${waitText(result.retryAfterMs)}.`,
    { details: { bucket, retryAfterSeconds } },
  );
}

// ---- failed sign-ins per account (independent of client IP) ---------------------------------

export const SIGN_IN_FAILURES = { limit: 10, windowMs: 15 * 60_000 };

const s = globalThis as unknown as { __qaSignInLimiter?: SlidingWindowLimiter };
const signInLimiter = () => (s.__qaSignInLimiter ??= new SlidingWindowLimiter());

const accountKey = (email: string) => `signin:${email.trim().toLowerCase()}`;

/** Milliseconds until the account accepts sign-in attempts again (0 = not locked). */
export function signInLockedForMs(email: string, limiter = signInLimiter()): number {
  const key = accountKey(email);
  return limiter.count(key, SIGN_IN_FAILURES.windowMs) >= SIGN_IN_FAILURES.limit
    ? limiter.retryAfterMs(key, SIGN_IN_FAILURES.windowMs)
    : 0;
}

export function recordSignInFailure(email: string, limiter = signInLimiter()) {
  limiter.hit(accountKey(email), Number.MAX_SAFE_INTEGER, SIGN_IN_FAILURES.windowMs);
}

export function clearSignInFailures(email: string, limiter = signInLimiter()) {
  limiter.reset(accountKey(email));
}

export { waitText as rateLimitWaitText };
