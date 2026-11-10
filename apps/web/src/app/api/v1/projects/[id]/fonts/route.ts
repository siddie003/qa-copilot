import { authedHandler } from "@/server/api";
import { json, readUpload } from "@/server/http";
import { listFonts, MAX_FONT_MB, uploadFont } from "@/server/project-assets";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export const GET = authedHandler<Params>(
  "GET /api/v1/projects/:id/fonts",
  async (_req, { user, params }) => json({ items: await listFonts(user.id, (await params).id) }),
);

/** Uploads a brand font file (WOFF2, WOFF, TTF, OTF); its names are read from the font tables. */
export const POST = authedHandler<Params>(
  "POST /api/v1/projects/:id/fonts",
  async (req, { user, params, log }) => {
    const { id } = await params;
    const file = await readUpload(req, MAX_FONT_MB * 1024 * 1024);
    const font = await uploadFont(user.id, id, file);
    log.info({ projectId: id, fontId: font.id, sizeBytes: font.sizeBytes }, "font uploaded");
    return json(font, { status: 201 });
  },
  { rateLimit: "upload" },
);
