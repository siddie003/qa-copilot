/**
 * Minimal Figma REST API client. The host is fixed (api.figma.com in production; a local mock in
 * tests); only the file key and node ids from a parsed Figma link are sent, with the token in
 * the X-Figma-Token header. Responses are size-capped because whole-file responses can be huge.
 */

export const FIGMA_API_BASE_URL = "https://api.figma.com";

export type FigmaErrorCode =
  | "NO_TOKEN"
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "TOO_LARGE"
  | "NETWORK"
  | "INVALID_RESPONSE";

export class FigmaError extends Error {
  constructor(
    readonly code: FigmaErrorCode,
    message: string,
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

export interface FigmaFetchOptions {
  fileKey: string;
  nodeIds: string[];
  token: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxBytes?: number;
  fetchImpl?: typeof fetch;
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw tooLarge(maxBytes);
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

const tooLarge = (maxBytes: number) =>
  new FigmaError(
    "TOO_LARGE",
    `The Figma response is larger than ${Math.round(maxBytes / 1024 / 1024)} MB. Link to a specific frame instead (select it in Figma, then "Copy link to selection") so only that part is read.`,
  );

/** Fetches the file (or only the linked nodes) and returns the node trees and style metadata. */
export async function fetchFigmaFile(opts: FigmaFetchOptions): Promise<FigmaFileData> {
  if (!/^[A-Za-z0-9]{10,128}$/.test(opts.fileKey))
    throw new FigmaError("INVALID_RESPONSE", "Invalid Figma file key");
  if (opts.nodeIds.some((n) => !/^\d+:\d+$/.test(n)))
    throw new FigmaError("INVALID_RESPONSE", "Invalid Figma node id");
  const base = (opts.baseUrl ?? FIGMA_API_BASE_URL).replace(/\/$/, "");
  const url = opts.nodeIds.length
    ? `${base}/v1/files/${opts.fileKey}/nodes?ids=${encodeURIComponent(opts.nodeIds.join(","))}`
    : `${base}/v1/files/${opts.fileKey}`;
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, {
      headers: { "X-Figma-Token": opts.token, accept: "application/json" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
      redirect: "error",
    });
  } catch (err) {
    const e = err as Error;
    throw new FigmaError(
      "NETWORK",
      e.name === "TimeoutError"
        ? "Figma did not respond in time. Try again later."
        : `Figma could not be reached: ${e.message}`,
    );
  }
  if (res.status === 401 || res.status === 403)
    throw new FigmaError(
      "UNAUTHORIZED",
      "Figma rejected the access token, or the token's account has no access to this file. Check the token and the file's sharing settings.",
    );
  if (res.status === 404)
    throw new FigmaError(
      "NOT_FOUND",
      "Figma file or node not found. Check the link and that the file is shared with the token's account.",
    );
  if (res.status === 429) {
    const retry = res.headers.get("retry-after");
    throw new FigmaError(
      "RATE_LIMITED",
      `Figma's rate limit was reached${retry ? ` (retry after ${retry} s)` : ""}. Fetch the reference again later.`,
    );
  }
  if (!res.ok) throw new FigmaError("NETWORK", `Figma answered HTTP ${res.status}.`);

  const text = await readCapped(res, opts.maxBytes ?? 50 * 1024 * 1024);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new FigmaError("INVALID_RESPONSE", "Figma returned a response that is not valid JSON.");
  }
  const meta = {
    name: typeof body.name === "string" ? body.name : "Untitled",
    lastModified: typeof body.lastModified === "string" ? body.lastModified : null,
    version: typeof body.version === "string" ? body.version : null,
  };
  if (opts.nodeIds.length) {
    const nodes = (body.nodes ?? {}) as Record<
      string,
      { document?: FigmaNode; styles?: Record<string, FigmaStyleMeta> } | null
    >;
    const roots: FigmaNode[] = [];
    const styles: Record<string, FigmaStyleMeta> = {};
    for (const id of opts.nodeIds) {
      const entry = nodes[id];
      if (!entry?.document)
        throw new FigmaError("NOT_FOUND", `Node ${id} was not found in the Figma file.`);
      roots.push(entry.document);
      Object.assign(styles, entry.styles ?? {});
    }
    return { ...meta, roots, styles };
  }
  const document = body.document as FigmaNode | undefined;
  if (!document || !Array.isArray(document.children))
    throw new FigmaError("INVALID_RESPONSE", "The Figma response contains no document.");
  return {
    ...meta,
    roots: [document],
    styles: (body.styles ?? {}) as Record<string, FigmaStyleMeta>,
  };
}
