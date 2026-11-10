import { authedHandler } from "@/server/api";
import { json } from "@/server/http";
import { searchContent } from "@/server/references";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/**
 * Full-text search over the project's indexed approved content: `?q=` words (any language),
 * optional `&document=` id. Returns ranked excerpts with document, section and pages.
 */
export const GET = authedHandler<Params>(
  "GET /api/v1/projects/:id/content-search",
  async (req, { user, params }) => {
    const sp = req.nextUrl.searchParams;
    return json(await searchContent(user.id, (await params).id, sp.get("q"), sp.get("document")));
  },
);
