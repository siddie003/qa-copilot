export type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "PAYLOAD_TOO_LARGE"
  | "RATE_LIMITED"
  | "EXTERNAL_SERVICE_ERROR"
  | "SERVICE_UNAVAILABLE"
  | "TIMEOUT"
  | "CONFIG_ERROR"
  | "INTERNAL_ERROR";

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  EXTERNAL_SERVICE_ERROR: 502,
  SERVICE_UNAVAILABLE: 503,
  TIMEOUT: 504,
  CONFIG_ERROR: 500,
  INTERNAL_ERROR: 500,
};

const TITLE_BY_CODE: Record<ErrorCode, string> = {
  VALIDATION_ERROR: "Invalid request",
  UNAUTHORIZED: "Authentication required",
  FORBIDDEN: "Access denied",
  NOT_FOUND: "Not found",
  CONFLICT: "Conflict",
  PAYLOAD_TOO_LARGE: "Payload too large",
  RATE_LIMITED: "Too many requests",
  EXTERNAL_SERVICE_ERROR: "External service error",
  SERVICE_UNAVAILABLE: "Service unavailable",
  TIMEOUT: "Operation timed out",
  CONFIG_ERROR: "Server configuration error",
  INTERNAL_ERROR: "Internal server error",
};

/**
 * Application error with a stable code. The message reaches API clients only when `expose` is
 * true (default: true for 4xx, false for 5xx), so internal details never leak.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;
  readonly expose: boolean;

  constructor(
    code: ErrorCode,
    message?: string,
    opts: { details?: unknown; expose?: boolean; cause?: unknown } = {},
  ) {
    super(
      message ?? TITLE_BY_CODE[code],
      opts.cause !== undefined ? { cause: opts.cause } : undefined,
    );
    this.name = "AppError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = opts.details;
    this.expose = opts.expose ?? this.status < 500;
  }
}

export const notFound = (what = "Resource") => new AppError("NOT_FOUND", `${what} not found`);

export const validationError = (message: string, details?: unknown) =>
  new AppError("VALIDATION_ERROR", message, { details });

/** RFC 9457 problem details body. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  code: ErrorCode;
  detail?: string;
  errors?: unknown;
  requestId?: string;
}

export function toProblem(err: unknown, requestId?: string): ProblemDetails {
  const appErr =
    err instanceof AppError ? err : new AppError("INTERNAL_ERROR", undefined, { cause: err });
  return {
    type: `about:blank#${appErr.code.toLowerCase()}`,
    title: TITLE_BY_CODE[appErr.code],
    status: appErr.status,
    code: appErr.code,
    ...(appErr.expose ? { detail: appErr.message } : {}),
    ...(appErr.expose && appErr.details !== undefined ? { errors: appErr.details } : {}),
    ...(requestId ? { requestId } : {}),
  };
}
