// Test fixture for extractInIsolation: a "parser" that never finishes or never stops allocating.
import { workerData } from "node:worker_threads";

if (workerData.kind === "txt") for (;;);
const kept = [];
for (;;) kept.push(`${"x".repeat(1 << 20)}${Math.random()}`);
