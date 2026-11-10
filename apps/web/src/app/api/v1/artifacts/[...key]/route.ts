import { Readable } from "node:stream";
import { getConfig, notFound } from "@qa/core";
import { getDb, pipelineRepo } from "@qa/db";
import { assertValidKey, contentTypeForKey, createLocalStorage } from "@qa/storage";
import { authedHandler } from "@/server/api";

export const runtime = "nodejs";

type Params = { params: Promise<{ key: string[] }> };

const SCAN_KEY = /^scans\/([0-9a-f-]{36})\//;

/** Streams a stored artifact (screenshot, snapshot) after checking the user owns its scan. */
export const GET = authedHandler<Params>(
  "GET /api/v1/artifacts/*",
  async (_req, { user, params }) => {
    const key = (await params).key.join("/");
    try {
      assertValidKey(key);
    } catch {
      throw notFound("Artifact");
    }
    const scanId = SCAN_KEY.exec(key)?.[1];
    if (!scanId || !(await pipelineRepo.canReadScanArtifacts(getDb(), user.id, scanId)))
      throw notFound("Artifact");
    const storage = createLocalStorage(getConfig().storageDirAbsolute);
    if (!(await storage.exists(key))) throw notFound("Artifact");
    const { stream, sizeBytes } = await storage.stream(key);
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      headers: {
        "content-type": contentTypeForKey(key),
        "content-length": String(sizeBytes),
        "cache-control": "private, max-age=3600",
        "x-content-type-options": "nosniff",
        // Artifacts are data: never executed or framed as part of the application.
        "content-security-policy":
          "default-src 'none'; img-src 'self'; sandbox; frame-ancestors 'none'",
        "content-disposition": "inline",
      },
    });
  },
);
