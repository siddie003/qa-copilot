import "server-only";
import { getConfig } from "@qa/core";
import { getDb, schema } from "@qa/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";

export const PASSWORD_MIN_LENGTH = 10;

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
    },
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
