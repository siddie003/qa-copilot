import {
  assertPublicTarget,
  BlockedTargetError,
  type Resolver,
  type TargetPolicy,
} from "@qa/security";
import { request, type Dispatcher } from "undici";

export interface FetchOptions {
  policy: TargetPolicy;
  dispatcher: Dispatcher;
  userAgent: string;
  timeoutMs: number;
  /** Retries for transient failures (network errors, timeouts, 502/503/504). */
  retries: number;
  maxRedirects?: number;
  maxBodyBytes?: number;
  signal?: AbortSignal;
  resolve?: Resolver;
  method?: "GET" | "HEAD";
  /**
   * Extra headers per URL (site credentials). Called for every hop, so a redirect to another
   * site never receives them.
   */
  authHeaders?: (url: string) => Record<string, string>;
}

export interface RedirectHop {
  url: string;
  status: number;
}

export interface FetchResult {
  requestedUrl: string;
  finalUrl: string;
  status: number | null;
  headers: Record<string, string | string[]>;
  contentType: string | null;
  redirectChain: RedirectHop[];
  body: string | null;
  bodyTruncated: boolean;
  durationMs: number;
  attempts: number;
  /** Set when no HTTP response was obtained (or the target was blocked). */
  error: { code: string; message: string; transient: boolean } | null;
}

const TRANSIENT_STATUS = new Set([502, 503, 504]);
const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });

/** Lowercased header map; Set-Cookie values are redacted but cookie names and flags are kept. */
export function sanitizeHeaders(raw: Record<string, string | string[] | undefined>) {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    const key = k.toLowerCase();
    if (key === "set-cookie") {
      const list = Array.isArray(v) ? v : [v];
      out[key] = list.map((c) => c.replace(/^([^=;]+)=[^;]*/, "$1=[redacted]"));
    } else out[key] = v;
  }
  return out;
}

const headerValue = (h: Record<string, string | string[]>, k: string) => {
  const v = h[k];
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
};

async function readBody(body: Dispatcher.ResponseData["body"], max: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  for await (const chunk of body) {
    const buf = chunk as Buffer;
    if (size + buf.length > max) {
      chunks.push(buf.subarray(0, max - size));
      truncated = true;
      body.destroy();
      break;
    }
    chunks.push(buf);
    size += buf.length;
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}

async function fetchOnce(url: string, opts: FetchOptions): Promise<FetchResult> {
  const started = performance.now();
  const chain: RedirectHop[] = [];
  const maxRedirects = opts.maxRedirects ?? 10;
  let current = url;
  const result = (partial: Partial<FetchResult>): FetchResult => ({
    requestedUrl: url,
    finalUrl: current,
    status: null,
    headers: {},
    contentType: null,
    redirectChain: chain,
    body: null,
    bodyTruncated: false,
    durationMs: Math.round(performance.now() - started),
    attempts: 1,
    error: null,
    ...partial,
  });

  for (let hop = 0; ; hop++) {
    // Every hop is re-validated: a public page must not redirect the scanner into the network.
    await assertPublicTarget(current, opts.policy, opts.resolve);
    const res = await request(current, {
      method: opts.method ?? "GET",
      dispatcher: opts.dispatcher,
      headers: {
        "user-agent": opts.userAgent,
        accept: "text/html,application/xhtml+xml,*/*;q=0.8",
        "accept-language": "en",
        ...(opts.authHeaders?.(current) ?? {}),
      },
      headersTimeout: opts.timeoutMs,
      bodyTimeout: opts.timeoutMs,
      signal: opts.signal,
    });
    const headers = sanitizeHeaders(res.headers as Record<string, string | string[]>);
    const location = headerValue(headers, "location");
    if (res.statusCode >= 300 && res.statusCode < 400 && location) {
      await res.body.dump();
      chain.push({ url: current, status: res.statusCode });
      if (hop >= maxRedirects)
        return result({
          status: res.statusCode,
          headers,
          error: {
            code: "TOO_MANY_REDIRECTS",
            message: `More than ${maxRedirects} redirects`,
            transient: false,
          },
        });
      current = new URL(location, current).toString();
      continue;
    }
    const contentType = headerValue(headers, "content-type");
    let body: string | null = null;
    let truncated = false;
    if (opts.method !== "HEAD" && /(text\/|html|xml|json)/i.test(contentType ?? "")) {
      const read = await readBody(res.body, opts.maxBodyBytes ?? 5_000_000);
      body = read.text;
      truncated = read.truncated;
    } else {
      await res.body.dump();
    }
    return result({ status: res.statusCode, headers, contentType, body, bodyTruncated: truncated });
  }
}

/** GET with SSRF checks on every hop, manual redirects, size cap and retries for transient failures. */
export async function guardedFetch(url: string, opts: FetchOptions): Promise<FetchResult> {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      const r = await fetchOnce(url, opts);
      const transient = r.status !== null && TRANSIENT_STATUS.has(r.status);
      if (transient && attempt <= opts.retries && !opts.signal?.aborted) {
        await sleep(500 * 2 ** (attempt - 1), opts.signal);
        continue;
      }
      return { ...r, attempts: attempt };
    } catch (err) {
      if (err instanceof BlockedTargetError) {
        return emptyResult(url, attempt, {
          code: err.code,
          message: err.message,
          transient: err.code === "DNS_FAILURE",
        });
      }
      const e = err as NodeJS.ErrnoException & { cause?: { code?: string } };
      const code = e.code ?? e.cause?.code ?? e.name ?? "FETCH_ERROR";
      const transient = TRANSIENT_CODES.has(code);
      if (transient && attempt <= opts.retries && !opts.signal?.aborted) {
        await sleep(500 * 2 ** (attempt - 1), opts.signal);
        continue;
      }
      return emptyResult(url, attempt, {
        code:
          code === "EBLOCKED_PRIVATE" || e.cause?.code === "EBLOCKED_PRIVATE"
            ? "PRIVATE_ADDRESS"
            : code,
        message: e.message || String(err),
        transient,
      });
    }
  }
}

function emptyResult(
  url: string,
  attempts: number,
  error: NonNullable<FetchResult["error"]>,
): FetchResult {
  return {
    requestedUrl: url,
    finalUrl: url,
    status: null,
    headers: {},
    contentType: null,
    redirectChain: [],
    body: null,
    bodyTruncated: false,
    durationMs: 0,
    attempts,
    error,
  };
}
