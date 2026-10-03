/** Error thrown by apiFetch with the server's problem+json details. */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly fieldErrors: Record<string, string>;
  constructor(
    status: number,
    message: string,
    code?: string,
    fieldErrors: Record<string, string> = {},
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.fieldErrors = fieldErrors;
  }
}

interface Problem {
  title?: string;
  detail?: string;
  code?: string;
  errors?: Array<{ path?: string; message?: string }>;
}

/** fetch wrapper for the app's own /api/v1 endpoints (same origin, JSON, problem+json errors). */
export async function apiFetch<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? "GET",
      headers: init.body !== undefined ? { "content-type": "application/json" } : undefined,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      credentials: "same-origin",
    });
  } catch {
    throw new ApiError(0, "Network error: the server could not be reached.");
  }
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) {
    const p = data as Problem;
    const fieldErrors: Record<string, string> = {};
    for (const e of p.errors ?? [])
      if (e.path && e.message && !fieldErrors[e.path]) fieldErrors[e.path] = e.message;
    throw new ApiError(
      res.status,
      p.detail ?? p.title ?? `Request failed (${res.status})`,
      p.code,
      fieldErrors,
    );
  }
  return data as T;
}
