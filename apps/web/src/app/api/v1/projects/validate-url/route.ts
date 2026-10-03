import { websiteUrlCheckSchema } from "@qa/core";
import { authedHandler } from "@/server/api";
import { json, readJson } from "@/server/http";
import { normalizeWebsiteUrl } from "@/server/projects";

export const runtime = "nodejs";

/** Checks a website URL with the same rules used on save; returns the normalized URL. */
export const POST = authedHandler("POST /api/v1/projects/validate-url", async (req) => {
  const { websiteUrl } = await readJson(req, websiteUrlCheckSchema);
  return json({ ok: true, url: normalizeWebsiteUrl(websiteUrl) });
});
