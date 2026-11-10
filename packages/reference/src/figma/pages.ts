import {
  FigmaError,
  type FigmaClient,
  type FigmaNode,
  type FigmaRateLimit,
  type FigmaRequestCounts,
  type FigmaStyleMeta,
} from "./client";
import {
  collectFigma,
  emptyCollectState,
  inventoryPage,
  type FigmaCollectState,
  type FigmaPageInventory,
} from "./normalize";

/** One page (or linked node) in the manifest. */
export interface FigmaManifestPage extends Partial<Omit<FigmaPageInventory, "id" | "name">> {
  id: string;
  name: string;
  status: "pending" | "done" | "failed";
  error?: string;
}

/**
 * Persisted record of a Figma read: which file and version, how it was read, every page with its
 * status and frames, requests used per rate-limit tier, rate-limit details and warnings.
 */
export interface FigmaManifest {
  fileKey: string;
  fileName: string | null;
  version: string | null;
  lastModified: string | null;
  /** whole_file: one request; pages: page list + batched page requests; nodes: linked frames. */
  mode: "whole_file" | "pages" | "nodes" | null;
  pagesDiscovered: number | null;
  pages: FigmaManifestPage[];
  /** Requests made, summed over all runs (Tier 1 = file content, Tier 3 = metadata). */
  requests: FigmaRequestCounts;
  rateLimit: (FigmaRateLimit & { at: string }) | null;
  warnings: string[];
  runs: number;
  complete: boolean;
  startedAt: string;
  finishedAt: string | null;
  /** Set when the metadata check found the file unchanged since the last complete read. */
  unchangedCheckedAt: string | null;
}

/** Resume state: the pinned version, pages still to read, and what was collected so far. */
export interface FigmaCheckpoint {
  version: string | null;
  pending: string[];
  collect: FigmaCollectState;
}

export type FigmaReadResult =
  | { status: "unchanged"; manifest: FigmaManifest }
  | { status: "done"; manifest: FigmaManifest; collect: FigmaCollectState }
  /** Stopped early (rate limit, network, cancellation); the checkpoint allows continuing. */
  | {
      status: "stopped";
      manifest: FigmaManifest;
      collect: FigmaCollectState;
      checkpoint: FigmaCheckpoint;
      error: FigmaError;
    };

export interface FigmaReadOptions {
  client: FigmaClient;
  fileKey: string;
  /** Linked frames/nodes (from a link with node-id); empty = the whole file. */
  nodeIds: string[];
  previous: FigmaManifest | null;
  checkpoint: FigmaCheckpoint | null;
  /** Pages per /nodes request (oversized batches are split in halves down to single pages). */
  pagesPerRequest: number;
  /** Largest response in MB (for messages). */
  maxResponseMb: number;
  /** Persists progress after each batch; returning false stops the read (e.g. cancelled). */
  onProgress: (manifest: FigmaManifest, checkpoint: FigmaCheckpoint | null) => Promise<boolean>;
  now?: () => Date;
}

const iso = (now: () => Date) => now().toISOString();
const firstLine = (e: unknown) => ((e as Error).message ?? String(e)).split("\n")[0]!.slice(0, 300);

/** Errors that end a read early but keep what was read (a later run can continue). */
const RESUMABLE: ReadonlySet<string> = new Set([
  "RATE_LIMITED",
  "NETWORK",
  "SERVER_ERROR",
  "CANCELLED",
]);

/**
 * Reads a Figma reference with as few file-content (Tier 1) requests as possible:
 *  1. File metadata (Tier 3): an unchanged version after a complete read needs no Tier 1 request.
 *  2. Linked nodes: one /nodes request.
 *  3. Whole file in one request when it fits the response cap; otherwise the page list
 *     (depth=1) and the pages in batches through /nodes, pinned to the listed version, so pages of
 *     different versions are never mixed. A batch that is too large is split; a single page that
 *     is too large is recorded as failed, the other pages are still read.
 * Every page is in the manifest with its status. Progress is persisted after each batch.
 */
export async function readFigmaReference(opts: FigmaReadOptions): Promise<FigmaReadResult> {
  const now = opts.now ?? (() => new Date());
  const { client, fileKey } = opts;
  const prev = opts.previous;
  const manifest: FigmaManifest = {
    fileKey,
    fileName: prev?.fileName ?? null,
    version: prev?.version ?? null,
    lastModified: prev?.lastModified ?? null,
    mode: prev?.mode ?? null,
    pagesDiscovered: prev?.pagesDiscovered ?? null,
    pages: opts.checkpoint ? (prev?.pages ?? []) : [],
    requests: prev?.requests ? { ...prev.requests } : { tier1: 0, tier3: 0, retries: 0 },
    rateLimit: null,
    // A continued read keeps the warnings of the run it continues.
    warnings: opts.checkpoint ? [...(prev?.warnings ?? [])] : [],
    runs: (prev?.runs ?? 0) + 1,
    complete: false,
    startedAt: iso(now),
    finishedAt: null,
    unchangedCheckedAt: null,
  };
  const before = { ...client.counts };
  const sync = () => {
    manifest.requests = {
      tier1: (prev?.requests?.tier1 ?? 0) + client.counts.tier1 - before.tier1,
      tier3: (prev?.requests?.tier3 ?? 0) + client.counts.tier3 - before.tier3,
      retries: (prev?.requests?.retries ?? 0) + client.counts.retries - before.retries,
    };
  };
  // Work on a copy: the caller's checkpoint stays as it was stored.
  let checkpoint = opts.checkpoint ? structuredClone(opts.checkpoint) : null;
  let collect = checkpoint?.collect ?? emptyCollectState();

  const stop = (error: FigmaError, cp: FigmaCheckpoint): FigmaReadResult => {
    sync();
    if (error.rateLimit) manifest.rateLimit = { ...error.rateLimit, at: iso(now) };
    manifest.finishedAt = iso(now);
    return { status: "stopped", manifest, collect, checkpoint: cp, error };
  };

  // 1. Metadata: version check without a file-content request.
  let metaVersion: string | null = null;
  try {
    const meta = await client.meta(fileKey);
    metaVersion = meta.version;
    manifest.fileName = meta.name;
  } catch (err) {
    if (!(err instanceof FigmaError) || err.code === "NOT_FOUND" || err.code === "CANCELLED")
      throw err;
    manifest.warnings.push(
      `File metadata could not be read (${err.code === "UNAUTHORIZED" ? "the token may lack the file_metadata:read scope" : firstLine(err)}); the file was read without checking for changes first.`,
    );
  }
  if (
    !checkpoint &&
    prev?.complete &&
    metaVersion &&
    prev.version === metaVersion &&
    // The same kind of read (linked nodes vs whole file) as last time.
    opts.nodeIds.length > 0 === (prev.mode === "nodes")
  ) {
    sync();
    return {
      status: "unchanged",
      manifest: {
        ...prev,
        requests: manifest.requests,
        runs: manifest.runs,
        unchangedCheckedAt: iso(now),
        warnings: manifest.warnings,
      },
    };
  }
  if (checkpoint && metaVersion && checkpoint.version && checkpoint.version !== metaVersion) {
    manifest.warnings.push(
      `The Figma file changed (version ${checkpoint.version} → ${metaVersion}) since the interrupted read; it was read again from the start.`,
    );
    checkpoint = null;
    collect = emptyCollectState();
    manifest.pages = [];
  }

  // 2. Linked frames/nodes.
  if (opts.nodeIds.length) {
    manifest.mode = "nodes";
    let r;
    try {
      r = await client.nodes(fileKey, opts.nodeIds);
    } catch (err) {
      if (err instanceof FigmaError && err.code === "TOO_LARGE")
        throw new FigmaError(
          "TOO_LARGE",
          `The linked node is larger than ${opts.maxResponseMb} MB. Link a smaller frame (select it in Figma, then "Copy link to selection").`,
        );
      if (err instanceof FigmaError && RESUMABLE.has(err.code))
        return stop(err, { version: null, pending: [], collect });
      throw err;
    }
    manifest.fileName ??= r.name;
    manifest.version = r.version ?? metaVersion;
    manifest.lastModified = r.lastModified;
    for (const id of opts.nodeIds) {
      const entry = r.nodes[id];
      if (!entry?.document) {
        manifest.pages.push({
          id,
          name: id,
          status: "failed",
          error: "Node not found in the file",
        });
        continue;
      }
      collectFigma(collect, entry.document, entry.styles ?? {});
      manifest.pages.push({ ...inventoryPage(entry.document), status: "done" });
    }
    manifest.pagesDiscovered = opts.nodeIds.length;
    return finish();
  }

  // 3. Whole file, or the page list for page-by-page reading.
  if (!checkpoint) {
    if (prev?.mode !== "pages") {
      try {
        const f = await client.file(fileKey);
        manifest.mode = "whole_file";
        manifest.fileName = f.name;
        manifest.version = f.version;
        manifest.lastModified = f.lastModified;
        collect.styles = { ...f.styles };
        const pages = f.document.children ?? [];
        manifest.pagesDiscovered = pages.length;
        manifest.pages = [];
        for (const page of pages) readPage(page, f.styles);
        return finish();
      } catch (err) {
        if (!(err instanceof FigmaError)) throw err;
        if (RESUMABLE.has(err.code)) return stop(err, { version: null, pending: [], collect });
        if (err.code !== "TOO_LARGE") throw err;
        manifest.warnings.push(
          `The file is larger than ${opts.maxResponseMb} MB in one response; it was read page by page.`,
        );
      }
    }
    let list;
    try {
      list = await client.file(fileKey, { depth: 1 });
    } catch (err) {
      if (err instanceof FigmaError && RESUMABLE.has(err.code))
        return stop(err, { version: null, pending: [], collect });
      throw err;
    }
    manifest.mode = "pages";
    manifest.fileName = list.name;
    manifest.version = list.version;
    manifest.lastModified = list.lastModified;
    collect.styles = { ...collect.styles, ...list.styles };
    const pages = list.document.children ?? [];
    manifest.pagesDiscovered = pages.length;
    manifest.pages = pages.map((p) => ({
      id: p.id,
      name: p.name.slice(0, 200),
      status: "pending",
    }));
    checkpoint = { version: list.version, pending: pages.map((p) => p.id), collect };
    if (!(await persist())) return stop(cancelled(), checkpoint);
  }

  // 4. Pages in batches, pinned to the listed version.
  manifest.mode = "pages";
  const cp: FigmaCheckpoint = checkpoint!;
  // Batch size adapts: after a batch was too large, later batches use the size that fitted, so
  // the request quota is not spent on oversized batches again.
  let batchSize = Math.max(1, opts.pagesPerRequest);
  const fetchPages = async (ids: string[]): Promise<void> => {
    let r;
    try {
      r = await client.nodes(fileKey, ids, { version: cp.version });
    } catch (err) {
      if (err instanceof FigmaError && err.code === "TOO_LARGE") {
        if (ids.length === 1) {
          markPage(ids[0]!, {
            status: "failed",
            error: `This page is larger than ${opts.maxResponseMb} MB in one response; link one of its frames instead.`,
          });
          return;
        }
        const half = Math.ceil(ids.length / 2);
        batchSize = Math.min(batchSize, half);
        await fetchPages(ids.slice(0, half));
        await fetchPages(ids.slice(half));
        return;
      }
      // A server error (after retries) may come from one page: split to isolate it; a single
      // page that still fails is recorded and the others are read.
      if (err instanceof FigmaError && err.code === "SERVER_ERROR") {
        if (ids.length === 1) {
          markPage(ids[0]!, {
            status: "failed",
            error: `Figma could not return this page (${err.message.replace(/\.$/, "")}).`,
          });
          return;
        }
        const half = Math.ceil(ids.length / 2);
        await fetchPages(ids.slice(0, half));
        await fetchPages(ids.slice(half));
        return;
      }
      throw err;
    }
    for (const id of ids) {
      const entry = r.nodes[id];
      if (!entry?.document) {
        markPage(id, { status: "failed", error: "Page not returned by Figma for this version" });
        continue;
      }
      readPage(entry.document, entry.styles ?? {});
    }
  };
  while (cp.pending.length) {
    const batch = cp.pending.slice(0, batchSize);
    try {
      await fetchPages(batch);
    } catch (err) {
      if (err instanceof FigmaError && RESUMABLE.has(err.code)) {
        // Pages finished inside a split batch are kept; the rest stay pending.
        cp.pending = cp.pending.filter((id) => pageOf(id)?.status === "pending");
        cp.collect = collect;
        return stop(err, cp);
      }
      throw err;
    }
    cp.pending = cp.pending.slice(batch.length);
    cp.collect = collect;
    if (!(await persist())) return stop(cancelled(), cp);
  }
  return finish();

  function pageOf(id: string) {
    return manifest.pages.find((p) => p.id === id);
  }
  function markPage(id: string, v: Partial<FigmaManifestPage>) {
    const p = pageOf(id);
    if (p) Object.assign(p, v);
    else manifest.pages.push({ id, name: id, status: "failed", ...v });
  }
  function readPage(page: FigmaNode, styles: Record<string, FigmaStyleMeta>) {
    try {
      collectFigma(collect, page, styles);
      const inv = inventoryPage(page);
      if (pageOf(page.id)) markPage(page.id, { ...inv, status: "done" });
      else manifest.pages.push({ ...inv, status: "done" });
    } catch (err) {
      markPage(page.id, { name: page.name ?? page.id, status: "failed", error: firstLine(err) });
    }
  }
  async function persist() {
    sync();
    return opts.onProgress(manifest, checkpoint);
  }
  function cancelled() {
    return new FigmaError("CANCELLED", "Cancelled by a user");
  }
  function finish(): FigmaReadResult {
    sync();
    manifest.complete = true;
    manifest.finishedAt = iso(now);
    return { status: "done", manifest, collect };
  }
}
