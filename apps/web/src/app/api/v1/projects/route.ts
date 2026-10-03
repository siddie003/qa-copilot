import { listQuerySchema, projectCreateSchema } from "@qa/core";
import { authedHandler } from "@/server/api";
import { json, readJson, readQuery } from "@/server/http";
import { createProject, listProjects, serializeProject } from "@/server/projects";

export const runtime = "nodejs";

export const GET = authedHandler("GET /api/v1/projects", async (req, { user }) => {
  const query = readQuery(req, listQuerySchema);
  const result = await listProjects(user.id, query);
  return json({ ...result, items: result.items.map(serializeProject) });
});

export const POST = authedHandler("POST /api/v1/projects", async (req, { user, log }) => {
  const input = await readJson(req, projectCreateSchema);
  const project = await createProject(user.id, input);
  log.info({ projectId: project.id, userId: user.id }, "project created");
  return json(serializeProject(project), { status: 201 });
});
