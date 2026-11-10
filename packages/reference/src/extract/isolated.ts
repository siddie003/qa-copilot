import { Worker } from "node:worker_threads";
import type { ContentDocumentKind } from "@qa/core";
import { ExtractionError, type ExtractedBlock, type ExtractionResult } from "./blocks";
import { noTextMessage, pageWarnings, type PdfPageReport, type PdfState } from "./pdf";

export interface IsolationOptions {
  /** Hard limit: the thread is terminated when it is exceeded (default 60 s). */
  timeoutMs?: number;
  /** JS heap limit of the parsing thread in MB (default 512). */
  maxMemoryMb?: number;
  /** Block cap (DOCUMENT_MAX_BLOCKS). */
  maxBlocks?: number;
  /** Tests only: another thread entry (e.g. a parser that never finishes). */
  entry?: URL;
  /** Tests only: time allowed for the thread to start (default 10 s). */
  startupAllowanceMs?: number;
}

/** A batch of blocks from the thread (PDF: a range of pages with their reports). */
export interface StreamBatch {
  blocks: ExtractedBlock[];
  pages: PdfPageReport[];
  /** PDF resume state after this batch (null for other formats, which are not resumable). */
  state: PdfState | null;
  truncated: boolean;
  /** Blocks shortened to the per-block character limit in this batch. */
  shortened: number;
}

export interface StreamOptions extends IsolationOptions {
  /** PDF: continue from this checkpoint. */
  resume?: PdfState | null;
  /** Cancels the extraction (the thread is terminated; stored batches are kept). */
  signal?: AbortSignal;
  /** Called once the document is open (page count for PDFs, null otherwise). */
  onStart?: (info: { totalPages: number | null }) => void | Promise<void>;
  /** Called for each batch, one at a time and in order; the extraction waits for it. */
  onBatch: (batch: StreamBatch) => Promise<void>;
}

export type StreamOutcome =
  | { status: "done"; totalPages: number | null; warnings: string[]; truncated: boolean }
  /** Stopped after some batches were stored; they are kept and the rest can be resumed. */
  | {
      status: "time_limit" | "cancelled" | "stopped";
      totalPages: number | null;
      reason: string;
    };

type ThreadMessage =
  | { type: "start"; totalPages: number | null }
  | ({ type: "batch" } & StreamBatch)
  | { type: "done"; warnings: string[]; truncated: boolean }
  | { type: "error"; extraction: boolean; message: string };

/** Time a thread may need to start (module loading) on top of the extraction time limit. */
const STARTUP_ALLOWANCE_MS = 10_000;

/**
 * Extracts a document in a separate worker thread and streams its blocks back in batches.
 * Uploaded documents are untrusted input to complex parsers (pdf.js, DOCX/XML, Markdown): a
 * document that makes a parser loop or allocate without bound is stopped (`terminate()`
 * interrupts even synchronous code) or hits the thread's heap limit, instead of blocking or
 * crashing the worker process that also runs scans. Batches already handed to `onBatch` stay
 * valid when the extraction is stopped later (time limit, cancellation, memory limit).
 */
export async function extractStreamInIsolation(
  kind: ContentDocumentKind,
  bytes: Buffer,
  opts: StreamOptions,
): Promise<StreamOutcome> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const maxMemoryMb = opts.maxMemoryMb ?? 512;
  const limitSeconds = Math.round(timeoutMs / 1000);
  if (opts.signal?.aborted)
    return { status: "cancelled", totalPages: null, reason: "Cancelled before it started" };
  const worker = new Worker(opts.entry ?? new URL("./thread-entry.mjs", import.meta.url), {
    workerData: {
      kind,
      bytes: new Uint8Array(bytes),
      resume: opts.resume ?? null,
      maxBlocks: opts.maxBlocks ?? null,
    },
    resourceLimits: { maxOldGenerationSizeMb: maxMemoryMb },
  });
  let totalPages: number | null = null;
  let batches = 0;
  let chain: Promise<void> = Promise.resolve();
  let batchError: unknown = null;

  return new Promise<StreamOutcome>((resolve, reject) => {
    let settled = false;
    // Stops the thread, waits for stored batches, then settles.
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      void worker.terminate();
      void chain.then(() => (batchError ? reject(batchError) : settle()));
    };
    const stopped = (status: "time_limit" | "cancelled" | "stopped", reason: string) =>
      finish(() =>
        batches > 0 || status === "cancelled"
          ? resolve({ status, totalPages, reason })
          : reject(new ExtractionError(reason)),
      );
    const timer = setTimeout(
      () =>
        stopped(
          "time_limit",
          `Text extraction took longer than ${limitSeconds} s and was stopped.`,
        ),
      timeoutMs + (opts.startupAllowanceMs ?? STARTUP_ALLOWANCE_MS),
    );
    const onAbort = () => stopped("cancelled", "Cancelled by a user");
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    worker.on("message", (m: ThreadMessage) => {
      if (settled) return;
      if (m.type === "start") {
        totalPages = m.totalPages;
        chain = chain.then(() => opts.onStart?.({ totalPages }));
      } else if (m.type === "batch") {
        batches += 1;
        const { type: _t, ...batch } = m;
        chain = chain
          // After a cancellation, batches still in the queue are not handed over.
          .then(() => (batchError || opts.signal?.aborted ? undefined : opts.onBatch(batch)))
          .catch((err) => {
            batchError ??= err;
            finish(() => {});
          });
      } else if (m.type === "done")
        finish(() =>
          // Cancelled while the last batches were still being stored: those were skipped, so
          // the result is a cancellation, never "done".
          opts.signal?.aborted
            ? resolve({ status: "cancelled", totalPages, reason: "Cancelled by a user" })
            : resolve({ status: "done", totalPages, warnings: m.warnings, truncated: m.truncated }),
        );
      else if (batches > 0 && !m.extraction)
        stopped("stopped", `Extraction stopped by an error: ${m.message}`);
      else
        finish(() => reject(m.extraction ? new ExtractionError(m.message) : new Error(m.message)));
    });
    worker.once("error", (err: NodeJS.ErrnoException) => {
      const message =
        err.code === "ERR_WORKER_OUT_OF_MEMORY"
          ? `Reading this document needed more than ${maxMemoryMb} MB of memory, so it was stopped.`
          : null;
      if (message) stopped("stopped", message);
      else finish(() => reject(err));
    });
    worker.once("exit", (code) =>
      finish(() =>
        reject(new Error(`Document extraction stopped unexpectedly (exit code ${code})`)),
      ),
    );
  });
}

/**
 * Whole-document extraction in an isolated thread (guideline documents): all batches collected.
 * Stopping early (time or memory limit) is an error here, as are documents without text.
 */
export async function extractInIsolation(
  kind: ContentDocumentKind,
  bytes: Buffer,
  opts: IsolationOptions = {},
): Promise<ExtractionResult> {
  const blocks: ExtractedBlock[] = [];
  const pages: PdfPageReport[] = [];
  let shortened = 0;
  const outcome = await extractStreamInIsolation(kind, bytes, {
    ...opts,
    onBatch: async (b) => {
      blocks.push(...b.blocks);
      pages.push(...b.pages);
      shortened += b.shortened;
    },
  });
  if (outcome.status !== "done") throw new ExtractionError(outcome.reason);
  if (!blocks.length)
    throw new ExtractionError(
      kind === "pdf"
        ? noTextMessage(pages, outcome.totalPages ?? 0)
        : "The document contains no text that could be compared.",
    );
  const warnings = [
    ...(kind === "pdf" ? pageWarnings(pages, outcome.totalPages ?? 0) : []),
    ...(shortened ? [`${shortened} block(s) longer than 5000 characters were shortened.`] : []),
    ...outcome.warnings,
  ];
  return {
    blocks,
    meta: {
      ...(outcome.totalPages ? { pages: outcome.totalPages } : {}),
      warnings,
      truncated: outcome.truncated,
    },
  };
}
