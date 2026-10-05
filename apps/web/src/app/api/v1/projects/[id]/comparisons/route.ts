import { AppError } from "@qa/core";
import { authedHandler } from "@/server/api";
import { comparePair, resolvePair } from "@/server/comparisons";
import { json } from "@/server/http";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/**
 * Comparison of two finished scans of the project: every tracked issue classified as new,
 * reopened, changed, resolved, persistent, not rechecked or newly checked (with finding-level
 * detail and the reason), scanner status changes, warnings and the summary counts.
 * `base`/`target` are scan ids; without them the latest comparable scan and the one before it
 * are used. 404 for scans of other projects, 400 for a reversed pair, 409 while a scan runs.
 */
export const GET = authedHandler<Params>(
  "GET /api/v1/projects/:id/comparisons",
  async (req, { user, params }) => {
    const { id } = await params;
    const sp = req.nextUrl.searchParams;
    const pair = await resolvePair(user.id, id, { base: sp.get("base"), target: sp.get("target") });
    const result = await comparePair(id, pair);
    if (!result) throw new AppError("CONFLICT", pair.missing ?? "No scans to compare");
    return json(result);
  },
);
