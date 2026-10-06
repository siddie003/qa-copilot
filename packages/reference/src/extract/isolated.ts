import { Worker } from "node:worker_threads";
import type { ContentDocumentKind } from "@qa/core";
import { ExtractionError, type ExtractionResult } from "./blocks";

export interface IsolationOptions {
  /** Hard limit: the thread is terminated when it is exceeded (default 60 s). */
  timeoutMs?: number;
  /** JS heap limit of the parsing thread in MB (default 512). */
  maxMemoryMb?: number;
  /** Tests only: another thread entry (e.g. a parser that never finishes). */
  entry?: URL;
  /** Tests only: time allowed for the thread to start (default 10 s). */
  startupAllowanceMs?: number;
}

/** Time a thread may need to start (module loading) on top of the extraction time limit. */
const STARTUP_ALLOWANCE_MS = 10_000;

/**
 * Extracts content blocks in a separate worker thread. Uploaded documents are untrusted input to
 * complex parsers (pdf.js, DOCX/XML, Markdown): a document that makes a parser loop or allocate
 * without bound is stopped (`terminate()` interrupts even synchronous code) or hits the thread's
 * heap limit, instead of blocking or crashing the worker process that also runs scans.
 */
export async function extractInIsolation(
  kind: ContentDocumentKind,
  bytes: Buffer,
  opts: IsolationOptions = {},
): Promise<ExtractionResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const maxMemoryMb = opts.maxMemoryMb ?? 512;
  const worker = new Worker(opts.entry ?? new URL("./thread-entry.mjs", import.meta.url), {
    workerData: { kind, bytes: new Uint8Array(bytes), timeoutMs },
    resourceLimits: { maxOldGenerationSizeMb: maxMemoryMb },
  });
  return new Promise<ExtractionResult>((resolve, reject) => {
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      settle();
    };
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(
            new ExtractionError(
              `Text extraction took longer than ${Math.round(timeoutMs / 1000)} s and was stopped.`,
            ),
          ),
        ),
      timeoutMs + (opts.startupAllowanceMs ?? STARTUP_ALLOWANCE_MS),
    );
    worker.once(
      "message",
      (
        m:
          | { ok: true; result: ExtractionResult }
          | { ok: false; extraction: boolean; message: string },
      ) =>
        finish(() =>
          m.ok
            ? resolve(m.result)
            : reject(m.extraction ? new ExtractionError(m.message) : new Error(m.message)),
        ),
    );
    worker.once("error", (err: NodeJS.ErrnoException) =>
      finish(() =>
        reject(
          err.code === "ERR_WORKER_OUT_OF_MEMORY"
            ? new ExtractionError(
                `Reading this document needed more than ${maxMemoryMb} MB of memory, so it was stopped.`,
              )
            : err,
        ),
      ),
    );
    worker.once("exit", (code) =>
      finish(() =>
        reject(new Error(`Document extraction stopped unexpectedly (exit code ${code})`)),
      ),
    );
  });
}
