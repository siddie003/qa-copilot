import "server-only";
import { errorFields, getConfig, getLogger, stripQueryParams } from "@qa/core";
import { getDb, schema } from "@qa/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware, isAPIError } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import {
  clearSignInFailures,
  rateLimitWaitText,
  recordSignInFailure,
  signInLockedForMs,
} from "./rate-limit";

export const PASSWORD_MIN_LENGTH = 10;

/**
 * Better Auth's own log output goes through the structured logger. Only messages and error fields
 * are logged (query parameters stripped); other arguments (request bodies, user objects) are
 * omitted because they can contain credentials or session tokens.
 */
export function authLogHandler(
  level: "debug" | "info" | "warn" | "error",
  message: string,
  ...args: unknown[]
) {
  const errors = args.filter((a): a is Error => a instanceof Error).map(errorFields);
  const omitted = args.length - errors.length;
  getLogger()
    .child({ component: "auth" })
    [level](
      {
        ...(errors[0] ?? {}),
        ...(errors.length > 1 ? { moreErrors: errors.length - 1 } : {}),
        ...(omitted ? { omittedArgs: omitted } : {}),
      },
      stripQueryParams(String(message)),
    );
}

const signInEmailOf = (body: unknown) => {
  const email = (body as { email?: unknown } | undefined)?.email;
  return typeof email === "string" && email.length <= 320 ? email : null;
};

/**
 * Failed sign-ins are limited per account (10 per 15 minutes), independent of the client IP, so
 * forged X-Forwarded-For headers cannot be used to keep guessing one account's password. While
 * an account is locked, attempts are refused without checking the password.
 */
const signInThrottle = {
  before: createAuthMiddleware(async (ctx) => {
    if (ctx.path !== "/sign-in/email") return;
    const email = signInEmailOf(ctx.body);
    const lockedMs = email ? signInLockedForMs(email) : 0;
    if (lockedMs > 0)
      throw new APIError("TOO_MANY_REQUESTS", {
        message: `Too many failed sign-in attempts for this account. Try again in ${rateLimitWaitText(lockedMs)}.`,
      });
  }),
  after: createAuthMiddleware(async (ctx) => {
    if (ctx.path !== "/sign-in/email") return;
    const email = signInEmailOf(ctx.body);
    if (!email) return;
    const returned = ctx.context.returned;
    if (isAPIError(returned)) {
      // Only wrong credentials count (not validation errors or server failures).
      if (returned.statusCode === 401) recordSignInFailure(email);
    } else clearSignInFailures(email);
  }),
};

/**
 * Builds the Better Auth instance (email + password, database sessions in PostgreSQL).
 * `withNextCookies` must be false outside a Next.js request (e.g. integration tests).
 */
export function createAuth({ withNextCookies = true } = {}) {
  const cfg = getConfig();
  return betterAuth({
    appName: "QA Copilot",
    baseURL: cfg.APP_URL,
    secret: cfg.BETTER_AUTH_SECRET,
    trustedOrigins: [new URL(cfg.APP_URL).origin],
    database: drizzleAdapter(getDb(), {
      provider: "pg",
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
      },
    }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: !cfg.AUTH_ALLOW_SIGNUP,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: 128,
      autoSignIn: true,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7, // 7 days
      updateAge: 60 * 60 * 24, // refresh expiry at most daily
    },
    rateLimit: {
      enabled: cfg.NODE_ENV !== "test",
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": { window: 60, max: 10 },
        "/sign-up/email": { window: 60, max: 5 },
      },
    },
    advanced: {
      useSecureCookies: cfg.APP_URL.startsWith("https://"),
      // Client IP for the per-IP limits above: see TRUSTED_PROXIES / CLIENT_IP_HEADER.
      ipAddress: {
        ipAddressHeaders: [cfg.CLIENT_IP_HEADER],
        ...(cfg.TRUSTED_PROXIES.length ? { trustedProxies: cfg.TRUSTED_PROXIES } : {}),
      },
    },
    hooks: signInThrottle,
    logger: { log: authLogHandler },
    plugins: withNextCookies ? [nextCookies()] : [],
  });
}

type Auth = ReturnType<typeof createAuth>;

const globalCache = globalThis as unknown as { __qaAuth?: Auth };

/** Lazily created so that importing this module never requires configuration (e.g. at build). */
export function getAuth(): Auth {
  globalCache.__qaAuth ??= createAuth();
  return globalCache.__qaAuth;
}
