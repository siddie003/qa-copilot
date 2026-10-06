import { describe, expect, it } from "vitest";
import { buildDocx, buildPdf } from "../../../fixtures/documents/build.mjs";
import { extractContentBlocks, extractInIsolation, ExtractionError } from "./extract";

const runaway = new URL("./test-fixtures/runaway-parser.mjs", import.meta.url);

describe("document extraction in an isolated worker thread", () => {
  it("returns the same blocks as in-process extraction", async () => {
    const docx = buildDocx([{ heading: "About us", level: 1 }, { p: "We build things." }]);
    const pdf = buildPdf([
      [
        { text: "Pricing", size: 24 },
        { text: "Plans start small.", size: 12 },
      ],
    ]);
    for (const [kind, bytes] of [
      ["docx", docx],
      ["pdf", pdf],
    ] as const) {
      const isolated = await extractInIsolation(kind, bytes);
      const direct = await extractContentBlocks(kind, bytes);
      expect(isolated.blocks).toEqual(direct.blocks);
      expect(isolated.blocks.length).toBeGreaterThan(0);
    }
  });

  it("passes extraction errors through with their message", async () => {
    await expect(extractInIsolation("md", Buffer.from("```\ncode only\n```\n"))).rejects.toThrow(
      ExtractionError,
    );
  });

  it("stops a parser that never finishes (hard time limit)", async () => {
    const started = Date.now();
    const result = extractInIsolation("txt", Buffer.from("x"), {
      entry: runaway,
      timeoutMs: 300,
      startupAllowanceMs: 200,
    });
    await expect(result).rejects.toThrow(/took longer than/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("stops a parser that exceeds its memory limit without affecting this process", async () => {
    const result = extractInIsolation("md", Buffer.from("x"), {
      entry: runaway,
      maxMemoryMb: 64,
      timeoutMs: 20_000,
    });
    await expect(result).rejects.toThrow(/more than 64 MB of memory/);
  });
});
