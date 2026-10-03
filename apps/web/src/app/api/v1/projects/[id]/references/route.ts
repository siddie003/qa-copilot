import { figmaReferenceSchema } from "@qa/core";
import { authedHandler } from "@/server/api";
import { json, readJson } from "@/server/http";
import { addFigmaReference, listReferences } from "@/server/projects";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export const GET = authedHandler<Params>(
  "GET /api/v1/projects/:id/references",
  async (_req, { user, params }) =>
    json({ items: await listReferences(user.id, (await params).id) }),
);

export const POST = authedHandler<Params>(
  "POST /api/v1/projects/:id/references",
  async (req, { user, params, log }) => {
    const { id } = await params;
    const { figmaUrl } = await readJson(req, figmaReferenceSchema);
    const ref = await addFigmaReference(user.id, id, figmaUrl);
    log.info({ projectId: id, referenceId: ref.id }, "figma reference added");
    return json(ref, { status: 201 });
  },
);
