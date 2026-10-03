import "server-only";
import { randomUUID } from "node:crypto";
import { errorFields, getLogger, toProblem, type Logger } from "@qa/core";
import { NextResponse, type NextRequest } from "next/server";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;

export interface ApiContext {
  requestId: string;
  log: Logger;
}

type RouteHandler<P> = (req: NextRequest, ctx: P & ApiContext) => Promise<Response>;

/** Accepts a caller-supplied request id only if it is a safe token; otherwise generates one. */
export function resolveRequestId(header: string | null): string {
  return header && REQUEST_ID_PATTERN.test(header) ? header : randomUUID();
}

/**
 * Wraps a route handler with request ids, structured access logging and RFC 9457 error responses.
 * Unexpected errors become opaque 500s; details only go to the server log.
 */
export function apiHandler<P = unknown>(route: string, handler: RouteHandler<P>) {
  return async (req: NextRequest, routeCtx: P): Promise<Response> => {
    const requestId = resolveRequestId(req.headers.get("x-request-id"));
    const log = getLogger().child({ requestId, route });
    const started = performance.now();
    const method = req.method;
    try {
      const res = await handler(req, { ...routeCtx, requestId, log });
      res.headers.set("x-request-id", requestId);
      log.info(
        { method, status: res.status, durationMs: Math.round(performance.now() - started) },
        "request",
      );
      return res;
    } catch (err) {
      const problem = toProblem(err, requestId);
      const fields = {
        method,
        status: problem.status,
        code: problem.code,
        durationMs: Math.round(performance.now() - started),
      };
      if (problem.status >= 500) log.error({ ...fields, ...errorFields(err) }, "request failed");
      else log.warn(fields, "request rejected");
      return NextResponse.json(problem, {
        status: problem.status,
        headers: {
          "content-type": "application/problem+json",
          "x-request-id": requestId,
          "cache-control": "no-store",
        },
      });
    }
  };
}

export function json(data: unknown, init: { status?: number } = {}) {
  return NextResponse.json(data, {
    status: init.status ?? 200,
    headers: { "cache-control": "no-store" },
  });
}
