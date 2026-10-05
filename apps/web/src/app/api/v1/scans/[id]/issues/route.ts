import { notFound } from "@qa/core";
import { getDb, scanIssuesRepo } from "@qa/db";
import { authedHandler } from "@/server/api";
import { json } from "@/server/http";
import { assertScanId } from "@/server/scans";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/**
 * Issues of a scan with their source findings, grounding checks and the AI requests made
 * (prompts and responses are not stored). Filter: ?grounding=passed|partial|rejected|not_applicable
 */
export const GET = authedHandler<Params>(
  "GET /api/v1/scans/:id/issues",
  async (req, { user, params }) => {
    const { id } = await params;
    assertScanId(id);
    const result = await scanIssuesRepo.listScanIssues(getDb(), user.id, id);
    if (!result) throw notFound("Scan");
    const grounding = req.nextUrl.searchParams.get("grounding");
    const items = grounding
      ? result.issues.filter((i) => i.groundingStatus === grounding)
      : result.issues;
    return json({
      items,
      total: items.length,
      aiRuns: result.aiRuns.map((r) => ({
        id: r.id,
        provider: r.provider,
        model: r.model,
        status: r.status,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        latencyMs: r.latencyMs,
        error: r.error,
        detail: r.detail,
        createdAt: r.createdAt,
      })),
    });
  },
);
