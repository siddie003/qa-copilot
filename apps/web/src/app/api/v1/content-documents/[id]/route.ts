import { contentDocumentUpdateSchema } from "@qa/core";
import { authedHandler } from "@/server/api";
import { json, readJson } from "@/server/http";
import { deleteContentDocument, updateContentDocument } from "@/server/references";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** Sets the website page the document describes ({ targetPath: "/about" }, or "" to clear). */
export const PATCH = authedHandler<Params>(
  "PATCH /api/v1/content-documents/:id",
  async (req, { user, params }) => {
    const { targetPath } = await readJson(req, contentDocumentUpdateSchema);
    return json(await updateContentDocument(user.id, (await params).id, targetPath));
  },
);

export const DELETE = authedHandler<Params>(
  "DELETE /api/v1/content-documents/:id",
  async (_req, { user, params, log }) => {
    const { id } = await params;
    await deleteContentDocument(user.id, id);
    log.info({ documentId: id }, "content document deleted");
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  },
);
