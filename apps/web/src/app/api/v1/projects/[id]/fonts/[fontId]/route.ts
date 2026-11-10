import { authedHandler } from "@/server/api";
import { deleteFont } from "@/server/project-assets";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string; fontId: string }> };

/** Removes a brand font file (completed scans keep their results). */
export const DELETE = authedHandler<Params>(
  "DELETE /api/v1/projects/:id/fonts/:fontId",
  async (_req, { user, params, log }) => {
    const { id, fontId } = await params;
    await deleteFont(user.id, id, fontId);
    log.info({ projectId: id, fontId }, "font removed");
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  },
);
