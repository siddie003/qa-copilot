/**
 * Figma REST API client (official endpoints only). The host is fixed (api.figma.com in
 * production; a local mock in tests); only file keys, node ids and the pinned version are sent,
 * with the token in the X-Figma-Token header. Responses are size-capped because whole-file
 * responses can be huge.
 *
 * Endpoints (developers.figma.com/docs/rest-api, checked 2026-10-09):
 *   GET /v1/files/:key/meta              Tier 3, scope file_metadata:read — name, version
 *   GET /v1/files/:key?depth=&version=   Tier 1, scope file_content:read  — document tree
 *   GET /v1/files/:key/nodes?ids=&version= Tier 1                         — subtrees by id
 * `:key` may be a file key or a branch key. Rate limits are per user and plan (Tier 1 for
 * View/Collab seats: up to 20 requests per month); 429 responses carry Retry-After and the
 * X-Figma-Plan-Tier / X-Figma-Rate-Limit-Type / X-Figma-Upgrade-Link headers.
 */

export const FIGMA_API_BASE_URL = "https://api.figma.com";

export type FigmaErrorCode =
  | "NO_TOKEN"
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "BAD_REQUEST"
  | "RATE_LIMITED"
  | "TOO_LARGE"
  | "NETWORK"
  /** Figma answered 5xx (after retries). */
  | "SERVER_ERROR"
  | "INVALID_RESPONSE"
  | "CANCELLED";

/** Figma's rate-limit details from a 429 response. */
export interface FigmaRateLimit {
  retryAfterSeconds: number | null;
  /** enterprise | org | pro | starter | student */
  planTier: string | null;
  /** low = View/Collab seat, high = Full/Dev seat */
  rateLimitType: string | null;
  upgradeLink: string | null;
}

export class FigmaError extends Error {
  constructor(
    readonly code: FigmaErrorCode,
    message: string,
    readonly rateLimit: FigmaRateLimit | null = null,
  ) {
    super(message);
    this.name = "FigmaError";
  }
}

/** Untyped Figma node (only the properties the normalizer reads are declared). */
export interface FigmaNode {
  id: string;
  name: string;
  type: string;
  children?: FigmaNode[];
  fills?: Array<{
    type: string;
    visible?: boolean;
    opacity?: number;
    color?: { r: number; g: number; b: number; a: number };
  }>;
  styles?: Record<string, string>;
  style?: {
    fontFamily?: string;
    fontWeight?: number;
    fontSize?: number;
    lineHeightPx?: number;
    lineHeightUnit?: string;
    letterSpacing?: number;
  };
  cornerRadius?: number;
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number } | null;
}

export interface FigmaStyleMeta {
  name: string;
  styleType: string;
  description?: string;
}

/** The parts of a Figma file (or of selected nodes) the normalizer works with. */
export interface FigmaFileData {
  name: string;
  lastModified: string | null;
  version: string | null;
  roots: FigmaNode[];
  styles: Record<string, FigmaStyleMeta>;
}

export interface FigmaFileMeta {
  name: string;
  version: string | null;
  lastTouchedAt: string | null;
  editorType: string | null;
}

export interface FigmaNodesResponse {
  name: string;
  lastModified: string | null;
  version: string | null;
  /** null for ids that are not in the file. */
  nodes: Record<string, { document?: FigmaNode; styles?: Record<string, FigmaStyleMeta> } | null>;
}

export interface FigmaClientOptions {
  token: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** Largest response read, in bytes (default 50 MB). */
  maxBytes?: number;
  /** Retries after 429 (when Retry-After is short enough) and 5xx/network errors (default 3). */
  maxRetries?: number;
  /** Longest Retry-After honoured; longer waits end the request (default 60 s). */
  maxRetryWaitMs?: number;
  /** First backoff step, doubled per attempt with full jitter (default 1 s). */
  retryBaseMs?: number;
  /** Cancels waits and requests. */
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/** Requests made per Figma rate-limit tier (for the manifest). */
export interface FigmaRequestCounts {
  tier1: number;
  tier3: number;
  retries: number;
}

const KEY = /^[A-Za-z0-9]{10,128}$/;
const NODE_ID = /^I?\d+:\d+(;\d+:\d+)*$/;

const tooLarge = (maxBytes: number) =>
  new FigmaError(
    "TOO_LARGE",
    `The Figma response is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`,
  );

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooLarge(maxBytes);
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooLarge(maxBytes);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

function rateLimitOf(res: Response): FigmaRateLimit {
  const after = Number(res.headers.get("retry-after"));
  return {
    retryAfterSeconds: Number.isFinite(after) && after >= 0 ? after : null,
    planTier: res.headers.get("x-figma-plan-tier"),
    rateLimitType: res.headers.get("x-figma-rate-limit-type"),
    upgradeLink: res.headers.get("x-figma-upgrade-link"),
  };
}

function rateLimitMessage(rl: FigmaRateLimit): string {
  const seat =
    rl.rateLimitType === "low"
      ? " The token's account has a View or Collab seat, whose file requests are limited to a few per month."
      : "";
  const wait =
    rl.retryAfterSeconds !== null
      ? ` Figma asks to wait ${formatWait(rl.retryAfterSeconds)}.`
      : " Try again later.";
  return `Figma's rate limit was reached${rl.planTier ? ` (plan: ${rl.planTier})` : ""}.${wait}${seat}`;
}

export function formatWait(seconds: number): string {
  if (seconds < 120) return `${Math.ceil(seconds)} s`;
  if (seconds < 7200) return `${Math.ceil(seconds / 60)} min`;
  if (seconds < 172_800) return `${Math.ceil(seconds / 3600)} h`;
  return `${Math.ceil(seconds / 86_400)} days`;
}

export class FigmaClient {
  readonly counts: FigmaRequestCounts = { tier1: 0, tier3: 0, retries: 0 };
  private readonly base: string;

  constructor(private readonly opts: FigmaClientOptions) {
    this.base = (opts.baseUrl ?? FIGMA_API_BASE_URL).replace(/\/$/, "");
  }

  private async request(path: string, tier: 1 | 3): Promise<Record<string, unknown>> {
    const retries = this.opts.maxRetries ?? 3;
    const maxWait = this.opts.maxRetryWaitMs ?? 60_000;
    const doFetch = this.opts.fetchImpl ?? fetch;
    for (let attempt = 0; ; attempt++) {
      if (this.opts.signal?.aborted) throw new FigmaError("CANCELLED", "Cancelled");
      if (tier === 1) this.counts.tier1 += 1;
      else this.counts.tier3 += 1;
      if (attempt > 0) this.counts.retries += 1;
      let res: Response;
      try {
        res = await doFetch(`${this.base}${path}`, {
          headers: { "X-Figma-Token": this.opts.token, accept: "application/json" },
          signal: AbortSignal.any([
            AbortSignal.timeout(this.opts.timeoutMs ?? 60_000),
            ...(this.opts.signal ? [this.opts.signal] : []),
          ]),
          redirect: "error",
        });
      } catch (err) {
        if (this.opts.signal?.aborted) throw new FigmaError("CANCELLED", "Cancelled");
        const e = err as Error;
        if (attempt < retries) {
          await sleep(this.backoff(attempt), this.opts.signal);
          continue;
        }
        throw new FigmaError(
          "NETWORK",
          e.name === "TimeoutError"
            ? "Figma did not respond in time. Try again later."
            : `Figma could not be reached: ${e.message}`,
        );
      }
      if (res.status === 401 || res.status === 403) {
        await res.body?.cancel().catch(() => {});
        throw new FigmaError(
          "UNAUTHORIZED",
          "Figma rejected the access token, or the token's account has no access to this file (or the token lacks the needed scope). Check the token, its scopes (file_content:read) and the file's sharing settings.",
        );
      }
      if (res.status === 404) {
        await res.body?.cancel().catch(() => {});
        throw new FigmaError(
          "NOT_FOUND",
          "Figma file or node not found. Check the link and that the file is shared with the token's account.",
        );
      }
      if (res.status === 400) {
        const body = (await res.json().catch(() => null)) as { err?: unknown } | null;
        throw new FigmaError(
          "BAD_REQUEST",
          `Figma rejected the request${typeof body?.err === "string" ? `: ${body.err.slice(0, 200)}` : ""}.`,
        );
      }
      if (res.status === 429) {
        await res.body?.cancel().catch(() => {});
        const rl = rateLimitOf(res);
        const waitMs = rl.retryAfterSeconds !== null ? rl.retryAfterSeconds * 1000 : null;
        if (attempt < retries && (waitMs ?? 0) <= maxWait) {
          await sleep(waitMs ?? this.backoff(attempt), this.opts.signal);
          continue;
        }
        throw new FigmaError("RATE_LIMITED", rateLimitMessage(rl), rl);
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        if (res.status >= 500 && attempt < retries) {
          await sleep(this.backoff(attempt), this.opts.signal);
          continue;
        }
        throw new FigmaError(
          res.status >= 500 ? "SERVER_ERROR" : "NETWORK",
          `Figma answered HTTP ${res.status}.`,
        );
      }
      const text = await readCapped(res, this.opts.maxBytes ?? 50 * 1024 * 1024);
      try {
        const body = JSON.parse(text) as unknown;
        if (!body || typeof body !== "object" || Array.isArray(body))
          throw new Error("not an object");
        return body as Record<string, unknown>;
      } catch {
        throw new FigmaError(
          "INVALID_RESPONSE",
          "Figma returned a response that is not valid JSON.",
        );
      }
    }
  }

  private backoff(attempt: number) {
    const base = this.opts.retryBaseMs ?? 1_000;
    return Math.round(Math.random() * Math.min(30_000, base * 2 ** attempt));
  }

  /** File name and current version (Tier 3; needs the file_metadata:read scope). */
  async meta(fileKey: string): Promise<FigmaFileMeta> {
    assertKey(fileKey);
    const body = await this.request(`/v1/files/${fileKey}/meta`, 3);
    const f = (body.file ?? body) as Record<string, unknown>;
    return {
      name: typeof f.name === "string" ? f.name : "Untitled",
      version: typeof f.version === "string" ? f.version : null,
      lastTouchedAt: typeof f.last_touched_at === "string" ? f.last_touched_at : null,
      editorType: typeof f.editorType === "string" ? f.editorType : null,
    };
  }

  /** The document tree (Tier 1). `depth: 1` returns the pages only. */
  async file(fileKey: string, opts: { depth?: number; version?: string | null } = {}) {
    assertKey(fileKey);
    const q = new URLSearchParams();
    if (opts.depth) q.set("depth", String(opts.depth));
    if (opts.version) q.set("version", opts.version);
    const body = await this.request(`/v1/files/${fileKey}${q.size ? `?${q}` : ""}`, 1);
    const document = body.document as FigmaNode | undefined;
    if (!document || !Array.isArray(document.children))
      throw new FigmaError("INVALID_RESPONSE", "The Figma response contains no document.");
    return {
      name: typeof body.name === "string" ? body.name : "Untitled",
      lastModified: typeof body.lastModified === "string" ? body.lastModified : null,
      version: typeof body.version === "string" ? body.version : null,
      document,
      styles: (body.styles ?? {}) as Record<string, FigmaStyleMeta>,
    };
  }

  /** Subtrees by node id in one request (Tier 1), optionally pinned to a version. */
  async nodes(
    fileKey: string,
    ids: string[],
    opts: { version?: string | null } = {},
  ): Promise<FigmaNodesResponse> {
    assertKey(fileKey);
    if (!ids.length || ids.some((n) => !NODE_ID.test(n)))
      throw new FigmaError("INVALID_RESPONSE", "Invalid Figma node id");
    const q = new URLSearchParams({ ids: ids.join(",") });
    if (opts.version) q.set("version", opts.version);
    const body = await this.request(`/v1/files/${fileKey}/nodes?${q}`, 1);
    return {
      name: typeof body.name === "string" ? body.name : "Untitled",
      lastModified: typeof body.lastModified === "string" ? body.lastModified : null,
      version: typeof body.version === "string" ? body.version : null,
      nodes: (body.nodes ?? {}) as FigmaNodesResponse["nodes"],
    };
  }
}

function assertKey(fileKey: string) {
  if (!KEY.test(fileKey)) throw new FigmaError("INVALID_RESPONSE", "Invalid Figma file key");
}

export interface FigmaFetchOptions {
  fileKey: string;
  nodeIds: string[];
  token: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxBytes?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Whole file (or the linked nodes) in one request, without retries. Kept for callers that read a
 * reference in one piece; the worker uses `FigmaClient` page by page (see figma/pages.ts).
 */
export async function fetchFigmaFile(opts: FigmaFetchOptions): Promise<FigmaFileData> {
  const client = new FigmaClient({ ...opts, maxRetries: 0 });
  if (opts.nodeIds.length) {
    const r = await client.nodes(opts.fileKey, opts.nodeIds);
    const roots: FigmaNode[] = [];
    const styles: Record<string, FigmaStyleMeta> = {};
    for (const id of opts.nodeIds) {
      const entry = r.nodes[id];
      if (!entry?.document)
        throw new FigmaError("NOT_FOUND", `Node ${id} was not found in the Figma file.`);
      roots.push(entry.document);
      Object.assign(styles, entry.styles ?? {});
    }
    return { name: r.name, lastModified: r.lastModified, version: r.version, roots, styles };
  }
  const f = await client.file(opts.fileKey);
  return {
    name: f.name,
    lastModified: f.lastModified,
    version: f.version,
    roots: [f.document],
    styles: f.styles,
  };
}
