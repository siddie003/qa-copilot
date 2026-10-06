import "server-only";
import { getConfig } from "@qa/core";
import type { NextRequest } from "next/server";
import { apiHandler, assertSameOrigin, type ApiContext } from "./http";
import { enforceRateLimit, type RateLimitBucket } from "./rate-limit";
import { requireApiUser, type CurrentUser } from "./session";

export interface AuthedContext extends ApiContext {
  user: CurrentUser;
}

type AuthedHandler<P> = (req: NextRequest, ctx: P & AuthedContext) => Promise<Response>;

export interface AuthedOptions {
  /**
   * Extra per-user limit for an expensive operation, checked after authentication and before the
   * handler reads the request body (every request also counts against the general `api` limit).
   */
  rateLimit?: RateLimitBucket;
}

/**
 * apiHandler + same-origin check for mutations + required session (401 otherwise) + per-user
 * rate limits (429 with Retry-After).
 */
export function authedHandler<P = unknown>(
  route: string,
  handler: AuthedHandler<P>,
  opts: AuthedOptions = {},
) {
  return apiHandler<P>(route, async (req, ctx) => {
    assertSameOrigin(req, getConfig().APP_URL);
    const user = await requireApiUser(req.headers);
    enforceRateLimit(user.id, "api");
    if (opts.rateLimit) enforceRateLimit(user.id, opts.rateLimit);
    ctx.log.debug({ userId: user.id }, "authenticated request");
    return handler(req, { ...ctx, user });
  });
}
