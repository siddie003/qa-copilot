import { SCANNER_KEYS, SEVERITIES, notFound } from "@qa/core";
import { getDb, pipelineRepo } from "@qa/db";
import { authedHandler } from "@/server/api";
import { json } from "@/server/http";
import { assertScanId } from "@/server/scans";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** Scanner findings of a scan with their evidence. Filters: ?scanner=seo&severity=high&severity=medium */
export const GET = authedHandler<Params>(
  "GET /api/v1/scans/:id/findings",
  async (req, { user, params }) => {
    const { id } = await params;
    assertScanId(id);
    const q = req.nextUrl.searchParams;
    const scanner = q.get("scanner");
    const items = await pipelineRepo.listFindingsForScan(getDb(), user.id, id, {
      scanner:
        scanner && (SCANNER_KEYS as readonly string[]).includes(scanner) ? scanner : undefined,
      severity: q.getAll("severity").filter((s) => (SEVERITIES as readonly string[]).includes(s)),
    });
    if (!items) throw notFound("Scan");
    return json({ items, total: items.length });
  },
);
