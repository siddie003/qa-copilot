import { getDb, scansRepo } from "@qa/db";
import { authedHandler } from "@/server/api";
import { json, readJson } from "@/server/http";
import { getProject } from "@/server/projects";
import { startScan, startScanSchema } from "@/server/scans";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export const GET = authedHandler<Params>(
  "GET /api/v1/projects/:id/scans",
  async (req, { user, params }) => {
    const project = await getProject(user.id, (await params).id);
    const page = Math.max(1, Number(req.nextUrl.searchParams.get("page")) || 1);
    return json(
      await scansRepo.listScans(getDb(), user.id, { projectId: project.id, page, pageSize: 25 }),
    );
  },
);

/** Starts a QA scan of the project (queued; the worker executes it). */
export const POST = authedHandler<Params>(
  "POST /api/v1/projects/:id/scans",
  async (req, { user, params, log }) => {
    const { id } = await params;
    await readJson(req, startScanSchema);
    const scan = await startScan(user.id, id);
    log.info({ projectId: id, scanId: scan.id, userId: user.id }, "scan queued");
    return json({ id: scan.id, number: scan.number, status: scan.status }, { status: 201 });
  },
  { rateLimit: "scan" },
);
