import { getConfig } from "@qa/core";
import { authedHandler } from "@/server/api";
import { json, readUpload } from "@/server/http";
import { uploadGuideline } from "@/server/references";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** Uploads a brand-guideline document; the worker extracts a draft design spec from it. */
export const POST = authedHandler<Params>(
  "POST /api/v1/projects/:id/guideline-documents",
  async (req, { user, params, log }) => {
    const { id } = await params;
    const file = await readUpload(req, getConfig().MAX_UPLOAD_MB * 1024 * 1024);
    const ref = await uploadGuideline(user.id, id, file);
    log.info({ projectId: id, referenceId: ref.id }, "guideline document uploaded");
    return json(ref, { status: 201 });
  },
  { rateLimit: "upload" },
);
