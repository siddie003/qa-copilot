import { pageLinkCreateSchema } from "@qa/core";
import { authedHandler } from "@/server/api";
import { json, readJson } from "@/server/http";
import { addPageLink, listPageLinks } from "@/server/project-assets";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export const GET = authedHandler<Params>(
  "GET /api/v1/projects/:id/page-links",
  async (_req, { user, params }) =>
    json({ items: await listPageLinks(user.id, (await params).id) }),
);

/** Adds one page of the project's website to every future scan (same site only). */
export const POST = authedHandler<Params>(
  "POST /api/v1/projects/:id/page-links",
  async (req, { user, params, log }) => {
    const { id } = await params;
    const { url } = await readJson(req, pageLinkCreateSchema);
    const link = await addPageLink(user.id, id, url);
    log.info({ projectId: id, pageLinkId: link.id }, "page link added");
    return json(link, { status: 201 });
  },
);
