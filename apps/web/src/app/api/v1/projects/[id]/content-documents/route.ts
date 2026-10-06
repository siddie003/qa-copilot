import { getConfig } from "@qa/core";
import { authedHandler } from "@/server/api";
import { json, readUpload } from "@/server/http";
import { getReferenceState, uploadContentDocument } from "@/server/references";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export const GET = authedHandler<Params>(
  "GET /api/v1/projects/:id/content-documents",
  async (_req, { user, params }) =>
    json({ items: (await getReferenceState(user.id, (await params).id)).documents }),
);

/** Uploads an approved content document (PDF, DOCX, TXT, MD); optional form field `targetPath`. */
export const POST = authedHandler<Params>(
  "POST /api/v1/projects/:id/content-documents",
  async (req, { user, params, log }) => {
    const { id } = await params;
    const file = await readUpload(req, getConfig().MAX_UPLOAD_MB * 1024 * 1024);
    const doc = await uploadContentDocument(user.id, id, file);
    log.info(
      { projectId: id, documentId: doc.id, sizeBytes: doc.sizeBytes },
      "content document uploaded",
    );
    return json(doc, { status: 201 });
  },
  { rateLimit: "upload" },
);
