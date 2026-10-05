import { authedHandler } from "@/server/api";
import { discardDesignDraft } from "@/server/references";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export const DELETE = authedHandler<Params>(
  "DELETE /api/v1/projects/:id/design-spec/draft",
  async (_req, { user, params, log }) => {
    const { id } = await params;
    await discardDesignDraft(user.id, id);
    log.info({ projectId: id }, "design spec draft discarded");
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  },
);
