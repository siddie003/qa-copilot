import "server-only";
import { getConfig } from "@qa/core";
import type { NextRequest } from "next/server";
import { apiHandler, assertSameOrigin, type ApiContext } from "./http";
import { requireApiUser, type CurrentUser } from "./session";

export interface AuthedContext extends ApiContext {
  user: CurrentUser;
}

type AuthedHandler<P> = (req: NextRequest, ctx: P & AuthedContext) => Promise<Response>;

/** apiHandler + same-origin check for mutations + required session (401 otherwise). */
export function authedHandler<P = unknown>(route: string, handler: AuthedHandler<P>) {
  return apiHandler<P>(route, async (req, ctx) => {
    assertSameOrigin(req, getConfig().APP_URL);
    const user = await requireApiUser(req.headers);
    ctx.log.debug({ userId: user.id }, "authenticated request");
    return handler(req, { ...ctx, user });
  });
}
