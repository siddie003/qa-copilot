import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { assertValidKey, contentTypeForKey, createLocalStorage } from "./index";

const dir = await mkdtemp(path.join(os.tmpdir(), "qa-store-"));
afterAll(() => rm(dir, { recursive: true, force: true }));

describe("local storage", () => {
  const storage = createLocalStorage(dir);

  it("writes, reads, streams and removes artifacts", async () => {
    await storage.put("scans/abc/pages/p1/desktop.png", Buffer.from([1, 2, 3]));
    expect([...(await storage.read("scans/abc/pages/p1/desktop.png"))]).toEqual([1, 2, 3]);
    const { sizeBytes } = await storage.stream("scans/abc/pages/p1/desktop.png");
    expect(sizeBytes).toBe(3);
    await storage.removePrefix("scans/abc");
    expect(await storage.exists("scans/abc/pages/p1/desktop.png")).toBe(false);
  });

  it.each([
    "../etc/passwd",
    "scans/../../x",
    "/abs/path",
    "C:\\win",
    "scans//x",
    "Scans/X",
    "scans/a b",
    "",
    "scans/./x",
  ])("rejects unsafe key %s", (key) => {
    expect(() => assertValidKey(key)).toThrow();
  });

  it("never serves stored HTML as HTML", () => {
    expect(contentTypeForKey("scans/a/raw.html")).toContain("text/plain");
    expect(contentTypeForKey("scans/a/x.png")).toBe("image/png");
  });
});
