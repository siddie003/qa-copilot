import { APP_VERSION } from "@qa/core";
import { apiHandler, json } from "@/server/http";

export const runtime = "nodejs";

/** Liveness: the web process is up and serving requests. Does not touch dependencies. */
export const GET = apiHandler("GET /api/v1/health", async () =>
  json({ status: "ok", service: "web", version: APP_VERSION, time: new Date().toISOString() }),
);
