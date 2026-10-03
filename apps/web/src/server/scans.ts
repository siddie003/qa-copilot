import "server-only";
import { AppError, getConfig, notFound, planScanSteps, type ScanConfigSnapshot } from "@qa/core";
import { getDb, pipelineRepo } from "@qa/db";
import { z } from "zod";
import { getProject } from "./projects";

const uuid = z.uuid();

export const startScanSchema = z.object({
  /** The user confirms they are authorized to test this website (required for every scan). */
  authorizationAttested: z.literal(true, {
    error: "Confirm that you are authorized to scan this website",
  }),
});

export function assertScanId(id: string) {
  if (!uuid.safeParse(id).success) throw notFound("Scan");
}

/** Creates a queued scan from the project's current settings; the worker picks it up. */
export async function startScan(userId: string, projectId: string) {
  const project = await getProject(userId, projectId);
  const db = getDb();
  if (await pipelineRepo.hasActiveScan(db, project.id))
    throw new AppError("CONFLICT", "A scan of this project is already queued or running");
  const cfg = getConfig();
  const d = project.scanDefaults;
  const snapshot: ScanConfigSnapshot = {
    websiteUrl: project.websiteUrl,
    scanners: d.scanners,
    viewports: d.viewports,
    maxPages: d.maxPages,
    maxDepth: d.maxDepth,
    respectRobots: d.respectRobots,
    pageTimeoutMs: cfg.SCAN_PAGE_TIMEOUT_MS,
    concurrency: cfg.SCAN_CONCURRENCY,
    userAgent: cfg.SCAN_USER_AGENT,
    authorizationAttestedAt: new Date().toISOString(),
  };
  const scan = await pipelineRepo.createScan(db, userId, project.id, {
    configSnapshot: snapshot as unknown as Record<string, unknown>,
    steps: planScanSteps(d.scanners),
    triggeredByUserId: userId,
  });
  if (!scan) throw notFound("Project");
  return scan;
}

export async function getScan(userId: string, scanId: string) {
  assertScanId(scanId);
  const detail = await pipelineRepo.getScanDetail(getDb(), userId, scanId);
  if (!detail) throw notFound("Scan");
  return detail;
}

export async function cancelScan(userId: string, scanId: string) {
  assertScanId(scanId);
  const result = await pipelineRepo.requestCancel(getDb(), userId, scanId);
  if (!result) throw notFound("Scan");
  if (!["queued", "running"].includes(result.previousStatus))
    throw new AppError("CONFLICT", "Only queued or running scans can be cancelled");
  return result;
}

export const TERMINAL_SCAN_STATUSES = new Set([
  "completed",
  "completed_with_failures",
  "failed",
  "cancelled",
]);
