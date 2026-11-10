import { authedHandler } from "@/server/api";
import { deletePageLink } from "@/server/project-assets";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string; linkId: string }> };

/** Removes one page link (pages already scanned stay in their scans). */
export const DELETE = authedHandler<Params>(
  "DELETE /api/v1/projects/:id/page-links/:linkId",
  async (_req, { user, params, log }) => {
    const { id, linkId } = await params;
    await deletePageLink(user.id, id, linkId);
    log.info({ projectId: id, pageLinkId: linkId }, "page link removed");
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  },
);
