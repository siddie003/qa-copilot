import "server-only";
import { randomUUID } from "node:crypto";
import {
  AppError,
  errorFields,
  getLogger,
  toProblem,
  validationError,
  zodIssues,
  type Logger,
} from "@qa/core";
import { NextResponse, type NextRequest } from "next/server";
import type { z } from "zod";

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

export const MAX_JSON_BODY_BYTES = 1_000_000;

/** Reads and validates a JSON request body. Rejects oversized, non-JSON and invalid payloads. */
export async function readJson<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_JSON_BODY_BYTES) throw new AppError("PAYLOAD_TOO_LARGE");
  if (!(req.headers.get("content-type") ?? "").toLowerCase().includes("application/json"))
    throw validationError("Content-Type must be application/json");
  const text = await req.text();
  if (text.length > MAX_JSON_BODY_BYTES) throw new AppError("PAYLOAD_TOO_LARGE");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw validationError("Request body must be valid JSON");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw validationError("Request validation failed", zodIssues(parsed.error));
  return parsed.data;
}

/** Parses query parameters with a zod schema. */
export function readQuery<T>(req: NextRequest, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) throw validationError("Invalid query parameters", zodIssues(parsed.error));
  return parsed.data;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF defense in depth (cookies are also SameSite=Lax): state-changing requests coming from
 * a browser must originate from the application's own origin.
 */
export function assertSameOrigin(req: Request, appUrl: string): void {
  if (SAFE_METHODS.has(req.method)) return;
  if (req.headers.get("sec-fetch-site") === "cross-site")
    throw new AppError("FORBIDDEN", "Cross-site request rejected");
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(appUrl).origin)
    throw new AppError("FORBIDDEN", "Cross-origin request rejected");
}
