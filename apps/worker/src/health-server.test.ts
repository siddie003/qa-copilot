import type http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { boundPort, startHealthServer, type WorkerStatus } from "./health-server";

const baseStatus: WorkerStatus = {
  status: "ok",
  version: "test",
  startedAt: new Date(0).toISOString(),
  uptimeSeconds: 1,
  database: { status: "ok", latencyMs: 1, serverVersion: "18", database: "qa", checkedAt: "now" },
};

let server: http.Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

describe("worker health server", () => {
  it("returns 200 with status JSON when healthy", async () => {
    server = await startHealthServer(0, () => baseStatus);
    const res = await fetch(`http://127.0.0.1:${boundPort(server)}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok", database: { status: "ok" } });
  });

  it("returns 503 when the database is unavailable", async () => {
    server = await startHealthServer(0, () => ({
      ...baseStatus,
      status: "degraded",
      database: {
        status: "error",
        code: "DB_AUTH_FAILED",
        message: "x",
        latencyMs: 1,
        checkedAt: "now",
      },
    }));
    const res = await fetch(`http://127.0.0.1:${boundPort(server)}/health`);
    expect(res.status).toBe(503);
  });

  it("returns 404 for unknown paths", async () => {
    server = await startHealthServer(0, () => baseStatus);
    const res = await fetch(`http://127.0.0.1:${boundPort(server)}/other`);
    expect(res.status).toBe(404);
  });
});
