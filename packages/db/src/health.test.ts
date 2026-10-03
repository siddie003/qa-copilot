import { afterAll, describe, expect, it } from "vitest";
import { classifyDatabaseError, checkDatabase } from "./health";
import { createPool } from "./client";

describe("classifyDatabaseError", () => {
  it.each([
    [{ code: "ECONNREFUSED" }, "DB_UNREACHABLE"],
    [{ errors: [{ code: "ECONNREFUSED" }] }, "DB_UNREACHABLE"],
    [{ code: "ENOTFOUND" }, "DB_HOST_NOT_FOUND"],
    [{ code: "28P01" }, "DB_AUTH_FAILED"],
    [{ code: "3D000" }, "DB_NOT_FOUND"],
    [new Error("Connection terminated due to connection timeout"), "DB_TIMEOUT"],
    [{ code: "XX000" }, "DB_ERROR"],
  ])("maps %o to %s", (err, code) => {
    expect(classifyDatabaseError(err).code).toBe(code);
  });
});

describe("checkDatabase against a closed port (real network call)", () => {
  // Port 1 on loopback is reserved and closed, so this exercises the genuine failure path.
  const pool = createPool("postgres://nobody:nopass@127.0.0.1:1/none", {
    connectionTimeoutMs: 2_000,
  });
  afterAll(() => pool.end());

  it("reports DB_UNREACHABLE without throwing or leaking credentials", async () => {
    const health = await checkDatabase(pool, 3_000);
    expect(health.status).toBe("error");
    if (health.status === "error") {
      expect(health.code).toBe("DB_UNREACHABLE");
      expect(health.message).not.toContain("nopass");
    }
  });
});

const liveUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!liveUrl)("checkDatabase against TEST_DATABASE_URL", () => {
  const pool = createPool(liveUrl ?? "");
  afterAll(() => pool.end());

  it("returns ok with server version", async () => {
    const health = await checkDatabase(pool);
    expect(health).toMatchObject({ status: "ok" });
  });
});
