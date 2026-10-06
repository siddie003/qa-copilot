import { AppError } from "@qa/core";
import { describe, expect, it } from "vitest";
import {
  clearSignInFailures,
  enforceRateLimit,
  RATE_LIMITS,
  recordSignInFailure,
  SIGN_IN_FAILURES,
  signInLockedForMs,
  SlidingWindowLimiter,
} from "./rate-limit";

describe("SlidingWindowLimiter", () => {
  it("allows up to the limit inside the window and reports when to retry", () => {
    const l = new SlidingWindowLimiter();
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) expect(l.hit("k", 3, 60_000, t0 + i).allowed).toBe(true);
    const refused = l.hit("k", 3, 60_000, t0 + 10);
    expect(refused).toMatchObject({ allowed: false });
    expect(refused.retryAfterMs).toBe(60_000 - 10);
    // The oldest hit leaves the window: one more is allowed.
    expect(l.hit("k", 3, 60_000, t0 + 60_001).allowed).toBe(true);
    expect(l.hit("other", 3, 60_000, t0 + 10).allowed).toBe(true);
  });

  it("bounds its memory", () => {
    const l = new SlidingWindowLimiter(100);
    for (let i = 0; i < 1_000; i++) l.hit(`k${i}`, 5, 60_000, 0);
    expect(l.count("k999", 60_000, 0)).toBe(1);
    expect(l.count("k0", 60_000, 0)).toBe(0);
  });
});

describe("enforceRateLimit", () => {
  it("throws 429 with the retry time once a user's bucket is exhausted", () => {
    const limiter = new SlidingWindowLimiter();
    const { limit } = RATE_LIMITS.scan;
    for (let i = 0; i < limit; i++) enforceRateLimit("u1", "scan", { limiter, force: true });
    let error: unknown;
    try {
      enforceRateLimit("u1", "scan", { limiter, force: true });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: "RATE_LIMITED", status: 429 });
    expect((error as AppError).message).toMatch(/Too many scan starts/);
    expect((error as AppError).details).toMatchObject({ bucket: "scan" });
    // Other users and other buckets are unaffected.
    expect(() => enforceRateLimit("u2", "scan", { limiter, force: true })).not.toThrow();
    expect(() => enforceRateLimit("u1", "report", { limiter, force: true })).not.toThrow();
  });
});

describe("failed sign-ins per account", () => {
  it("locks an account after repeated failures, case-insensitively, until cleared", () => {
    const limiter = new SlidingWindowLimiter();
    for (let i = 0; i < SIGN_IN_FAILURES.limit - 1; i++)
      recordSignInFailure("Victim@Example.test", limiter);
    expect(signInLockedForMs("victim@example.test", limiter)).toBe(0);
    recordSignInFailure("victim@example.test ", limiter);
    const locked = signInLockedForMs("VICTIM@example.test", limiter);
    expect(locked).toBeGreaterThan(0);
    expect(locked).toBeLessThanOrEqual(SIGN_IN_FAILURES.windowMs);
    expect(signInLockedForMs("someone@example.test", limiter)).toBe(0);
    clearSignInFailures("victim@example.test", limiter);
    expect(signInLockedForMs("victim@example.test", limiter)).toBe(0);
  });
});
