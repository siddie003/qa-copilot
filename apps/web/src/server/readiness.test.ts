import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { checkStorage } = await import("./readiness");

const tmp = await mkdtemp(path.join(os.tmpdir(), "qa-storage-"));
afterAll(() => rm(tmp, { recursive: true, force: true }));

describe("checkStorage", () => {
  it("creates the directory, verifies writes and leaves no probe file", async () => {
    const dir = path.join(tmp, "nested", "storage");
    expect(await checkStorage(dir)).toEqual({ status: "ok", path: dir });
    expect(await readdir(dir)).toEqual([]);
  });

  it("reports an error when the path is not a directory", async () => {
    const file = path.join(tmp, "a-file");
    await writeFile(file, "x");
    const result = await checkStorage(file);
    expect(result).toMatchObject({ status: "error", code: "STORAGE_NOT_WRITABLE" });
  });
});
