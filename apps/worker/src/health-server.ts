import http from "node:http";
import type { AddressInfo } from "node:net";
import type { DatabaseHealth } from "@qa/db";

export interface WorkerStatus {
  status: "ok" | "degraded";
  version: string;
  startedAt: string;
  uptimeSeconds: number;
  database: (DatabaseHealth & { checkedAt: string }) | { status: "pending" };
  scanWorker?:
    | { status: "running"; workerId: string; concurrency: number; currentScanIds: string[] }
    | { status: "not_started" };
  /** Processes content documents, Figma references and guideline documents. */
  referenceWorker?: { status: "running" | "not_started" };
  reportWorker?: { status: "running" | "not_started" };
}

/**
 * Minimal liveness/readiness endpoint for the worker process (bound to loopback by default).
 * Returns 200 when the worker can reach the database, 503 otherwise.
 */
export function startHealthServer(
  port: number,
  getStatus: () => WorkerStatus,
  host = "127.0.0.1",
): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      const status = getStatus();
      res.writeHead(status.status === "ok" ? 200 : 503, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(status));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: 404, title: "Not found" }));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

export function boundPort(server: http.Server): number {
  return (server.address() as AddressInfo).port;
}
