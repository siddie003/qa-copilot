import { authedHandler } from "@/server/api";
import { json, readJson } from "@/server/http";
import { clearScanAuth, getScanAuthSummary, scanAuthSchema, setScanAuth } from "@/server/scan-auth";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** Returns only a non-secret summary; stored credentials are never sent back. */
export const GET = authedHandler<Params>(
  "GET /api/v1/projects/:id/scan-auth",
  async (_req, { user, params }) =>
    json({ auth: await getScanAuthSummary(user.id, (await params).id) }),
);

export const PUT = authedHandler<Params>(
  "PUT /api/v1/projects/:id/scan-auth",
  async (req, { user, params, log }) => {
    const { id } = await params;
    const auth = await readJson(req, scanAuthSchema);
    const summary = await setScanAuth(user.id, id, auth);
    log.info({ projectId: id, authType: summary.type }, "site credentials updated");
    return json({ auth: summary });
  },
);

export const DELETE = authedHandler<Params>(
  "DELETE /api/v1/projects/:id/scan-auth",
  async (_req, { user, params, log }) => {
    const { id } = await params;
    await clearScanAuth(user.id, id);
    log.info({ projectId: id }, "site credentials removed");
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  },
);
