import { projectUpdateSchema } from "@qa/core";
import { authedHandler } from "@/server/api";
import { json, readJson } from "@/server/http";
import { deleteProject, getProject, serializeProject, updateProject } from "@/server/projects";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export const GET = authedHandler<Params>(
  "GET /api/v1/projects/:id",
  async (_req, { user, params }) => {
    const { id } = await params;
    return json(serializeProject(await getProject(user.id, id)));
  },
);

export const PATCH = authedHandler<Params>(
  "PATCH /api/v1/projects/:id",
  async (req, { user, params, log }) => {
    const { id } = await params;
    const input = await readJson(req, projectUpdateSchema);
    const project = await updateProject(user.id, id, input);
    log.info({ projectId: id, userId: user.id, fields: Object.keys(input) }, "project updated");
    return json(serializeProject(project));
  },
);

export const DELETE = authedHandler<Params>(
  "DELETE /api/v1/projects/:id",
  async (_req, { user, params, log }) => {
    const { id } = await params;
    await deleteProject(user.id, id);
    log.info({ projectId: id, userId: user.id }, "project deleted");
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  },
);
