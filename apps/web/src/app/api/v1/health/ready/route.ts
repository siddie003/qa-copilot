import { apiHandler, json } from "@/server/http";
import { runReadinessChecks } from "@/server/readiness";

export const runtime = "nodejs";

/** Readiness: configuration valid, PostgreSQL reachable, storage writable. 503 otherwise. */
export const GET = apiHandler("GET /api/v1/health/ready", async () => {
  const report = await runReadinessChecks({
    includeDetails: process.env.NODE_ENV !== "production",
  });
  return json(report, { status: report.status === "ready" ? 200 : 503 });
});
