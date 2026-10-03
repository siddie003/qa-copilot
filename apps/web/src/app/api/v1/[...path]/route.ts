import { notFound } from "@qa/core";
import { apiHandler } from "@/server/http";

export const runtime = "nodejs";

// Unknown API routes return problem+json instead of the HTML 404 page.
const handler = apiHandler("unknown /api/v1/*", async () => {
  throw notFound("API route");
});

export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE };
