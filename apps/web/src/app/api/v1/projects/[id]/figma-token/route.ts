import { z } from "zod";
import { authedHandler } from "@/server/api";
import { readJson } from "@/server/http";
import { clearFigmaToken, setFigmaToken } from "@/server/references";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

const noContent = () =>
  new Response(null, { status: 204, headers: { "cache-control": "no-store" } });

/** Stores the project's Figma token encrypted; it is never sent back to the browser. */
export const PUT = authedHandler<Params>(
  "PUT /api/v1/projects/:id/figma-token",
  async (req, { user, params, log }) => {
    const { id } = await params;
    await setFigmaToken(user.id, id, await readJson(req, z.unknown()));
    log.info({ projectId: id }, "figma token saved");
    return noContent();
  },
);

export const DELETE = authedHandler<Params>(
  "DELETE /api/v1/projects/:id/figma-token",
  async (_req, { user, params, log }) => {
    const { id } = await params;
    await clearFigmaToken(user.id, id);
    log.info({ projectId: id }, "figma token removed");
    return noContent();
  },
);
