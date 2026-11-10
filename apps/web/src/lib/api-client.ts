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

/**
 * The error's message plus the server's per-field reasons (e.g. "scanDefaults.scanners.6: Invalid
 * option"), so a generic "Request validation failed" never hides what was rejected.
 */
export function describeApiError(err: unknown, fallback: string): string {
  if (!(err instanceof ApiError)) return fallback;
  const fields = Object.entries(err.fieldErrors).slice(0, 3);
  if (!fields.length) return err.message;
  return `${err.message}: ${fields.map(([path, msg]) => `${path} — ${msg}`).join("; ")}`;
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

/**
 * Like apiUpload, but reports upload progress (0–1, bytes sent by the browser). Uses
 * XMLHttpRequest because fetch() has no upload progress events.
 */
export function apiUploadWithProgress<T>(
  path: string,
  file: File,
  fields: Record<string, string> = {},
  onProgress?: (fraction: number) => void,
): Promise<T> {
  const form = new FormData();
  form.append("file", file);
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", path);
    xhr.withCredentials = true;
    xhr.responseType = "text";
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress?.(Math.min(1, e.loaded / e.total));
    };
    xhr.onerror = () => reject(new ApiError(0, "Network error: the server could not be reached."));
    xhr.onabort = () => reject(new ApiError(0, "The upload was cancelled."));
    xhr.onload = () => {
      let data: Record<string, unknown> = {};
      try {
        data = xhr.responseText ? (JSON.parse(xhr.responseText) as Record<string, unknown>) : {};
      } catch {
        /* non-JSON error page */
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(1);
        resolve(data as T);
        return;
      }
      reject(
        new ApiError(
          xhr.status,
          String(data.detail ?? data.title ?? `Upload failed (${xhr.status})`),
          typeof data.code === "string" ? data.code : undefined,
        ),
      );
    };
    xhr.send(form);
  });
}

/** Uploads one file (multipart/form-data, field "file") plus optional text fields. */
export async function apiUpload<T>(
  path: string,
  file: File,
  fields: Record<string, string> = {},
): Promise<T> {
  const form = new FormData();
  form.append("file", file);
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  let res: Response;
  try {
    res = await fetch(path, { method: "POST", body: form, credentials: "same-origin" });
  } catch {
    throw new ApiError(0, "Network error: the server could not be reached.");
  }
  const data = (await res.json().catch(() => ({}))) as {
    detail?: string;
    title?: string;
    code?: string;
  };
  if (!res.ok)
    throw new ApiError(
      res.status,
      data.detail ?? data.title ?? `Upload failed (${res.status})`,
      data.code,
    );
  return data as T;
}
