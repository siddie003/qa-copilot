// Worker-thread entry for isolated document extraction (see isolated.ts). Plain JavaScript on
// purpose: it registers tsx so the TypeScript sources of this package load in the thread, both
// under the worker's tsx runtime and under the test runner.
//
// Messages to the parent: { type: "start", totalPages } once, then { type: "batch", ... } per
// batch (PDF: a range of pages; other formats: slices of the whole result), then
// { type: "done", warnings, truncated } or { type: "error", extraction, message }.
import { parentPort, workerData } from "node:worker_threads";
import { register } from "tsx/esm/api";

register();
const { extractContentBlocks, extractPdfBatches, openPdf, ExtractionError } =
  await import("./index.ts");

const SLICE = 1_000;
const { kind, bytes, resume, maxBlocks } = workerData;
try {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (kind === "pdf") {
    const src = await openPdf(view);
    parentPort.postMessage({ type: "start", totalPages: src.numPages });
    let truncated = false;
    for await (const batch of extractPdfBatches(src, {
      state: resume,
      maxBlocks: maxBlocks ?? undefined,
    })) {
      truncated ||= batch.truncated;
      parentPort.postMessage({ type: "batch", ...batch });
    }
    await src.close();
    parentPort.postMessage({
      type: "done",
      warnings: truncated
        ? [
            `Only the first ${maxBlocks ?? 50000} blocks of the document were kept; the rest was not read (DOCUMENT_MAX_BLOCKS).`,
          ]
        : [],
      truncated,
    });
  } else {
    // DOCX, Markdown and text are read in one piece (they are fast); the result is streamed
    // in slices so the parent stores it in batches. The parent enforces the time limit.
    const result = await extractContentBlocks(kind, view, {
      timeoutMs: 24 * 60 * 60_000,
      maxBlocks: maxBlocks ?? undefined,
    });
    parentPort.postMessage({ type: "start", totalPages: null });
    for (let i = 0; i < result.blocks.length; i += SLICE)
      parentPort.postMessage({
        type: "batch",
        blocks: result.blocks.slice(i, i + SLICE),
        pages: [],
        state: null,
        truncated: false,
        shortened: 0,
      });
    parentPort.postMessage({
      type: "done",
      warnings: result.meta.warnings,
      truncated: result.meta.truncated,
    });
  }
} catch (err) {
  parentPort.postMessage({
    type: "error",
    extraction: err instanceof ExtractionError,
    message: err instanceof Error ? err.message : String(err),
  });
}
