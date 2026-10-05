import { z } from "zod";
import { authedHandler } from "@/server/api";
import { json, readJson } from "@/server/http";
import { getReferenceState, saveDesignSpec } from "@/server/references";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** Active design spec, pending draft (with its changes) and version history. */
export const GET = authedHandler<Params>(
  "GET /api/v1/projects/:id/design-spec",
  async (_req, { user, params }) =>
    json((await getReferenceState(user.id, (await params).id)).designSpec),
);

/** Saves manual or JSON design values as a new confirmed version (validated in the service). */
export const PUT = authedHandler<Params>(
  "PUT /api/v1/projects/:id/design-spec",
  async (req, { user, params, log }) => {
    const { id } = await params;
    const body = await readJson(req, z.unknown());
    const row = await saveDesignSpec(user.id, id, body);
    log.info({ projectId: id, version: row.version }, "design spec saved");
    return json({ version: row.version }, { status: 201 });
  },
);
