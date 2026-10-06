// Worker-thread entry for isolated document extraction (see isolated.ts). Plain JavaScript on
// purpose: it registers tsx so the TypeScript sources of this package load in the thread, both
// under the worker's tsx runtime and under the test runner.
import { parentPort, workerData } from "node:worker_threads";
import { register } from "tsx/esm/api";

register();
const { extractContentBlocks, ExtractionError } = await import("./index.ts");

const { kind, bytes, timeoutMs } = workerData;
try {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result = await extractContentBlocks(kind, view, { timeoutMs });
  parentPort.postMessage({ ok: true, result });
} catch (err) {
  parentPort.postMessage({
    ok: false,
    extraction: err instanceof ExtractionError,
    message: err instanceof Error ? err.message : String(err),
  });
}
