import { z } from "zod";
import { authedHandler } from "@/server/api";
import { json, readJson } from "@/server/http";
import { confirmDesignDraft } from "@/server/references";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

const schema = z.object({ version: z.number().int().min(1) });

/** The user confirms the reviewed draft; it becomes the active design reference. */
export const POST = authedHandler<Params>(
  "POST /api/v1/projects/:id/design-spec/draft/confirm",
  async (req, { user, params, log }) => {
    const { id } = await params;
    const { version } = await readJson(req, schema);
    const row = await confirmDesignDraft(user.id, id, version);
    log.info({ projectId: id, version: row.version }, "design spec draft confirmed");
    return json({ version: row.version });
  },
);
