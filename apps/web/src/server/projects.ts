import "server-only";
import {
  defaultScanDefaults,
  getConfig,
  notFound,
  validationError,
  type ListQuery,
  type ProjectCreateInput,
  type ProjectUpdateInput,
} from "@qa/core";
import { getDb, projectsRepo, type ProjectSummary } from "@qa/db";
import { validateWebsiteUrl } from "@qa/security";
import { z } from "zod";

const uuid = z.uuid();

/** Validates a website URL against the static SSRF rules; returns the normalized URL. */
export function normalizeWebsiteUrl(raw: string): string {
  const result = validateWebsiteUrl(raw, {
    allowedPrivateHosts: getConfig().SCAN_ALLOWED_PRIVATE_HOSTS,
  });
  if (!result.ok)
    throw validationError(result.message, [
      { path: "websiteUrl", message: result.message, code: result.code },
    ]);
  return result.url;
}

function assertProjectId(id: string) {
  // Malformed ids are indistinguishable from missing ones (no information leak, no SQL error).
  if (!uuid.safeParse(id).success) throw notFound("Project");
}

/** JSON shape returned by the API (dates as ISO strings). */
export function serializeProject(p: ProjectSummary) {
  return {
    ...p,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    lastScan: p.lastScan
      ? {
          ...p.lastScan,
          createdAt: p.lastScan.createdAt.toISOString(),
          finishedAt: p.lastScan.finishedAt?.toISOString() ?? null,
        }
      : null,
  };
}

export async function listProjects(userId: string, query: ListQuery) {
  const { items, total } = await projectsRepo.listProjects(getDb(), userId, query);
  return { items, total, page: query.page, pageSize: query.pageSize };
}

export async function getProject(userId: string, id: string) {
  assertProjectId(id);
  const project = await projectsRepo.getProject(getDb(), userId, id);
  if (!project) throw notFound("Project");
  return project;
}

export async function createProject(userId: string, input: ProjectCreateInput) {
  const cfg = getConfig();
  return projectsRepo.createProject(getDb(), userId, {
    name: input.name,
    websiteUrl: normalizeWebsiteUrl(input.websiteUrl),
    scanDefaults:
      input.scanDefaults ??
      defaultScanDefaults({ maxPages: cfg.SCAN_MAX_PAGES, maxDepth: cfg.SCAN_MAX_DEPTH }),
  });
}

export async function updateProject(userId: string, id: string, input: ProjectUpdateInput) {
  assertProjectId(id);
  const patch = {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.websiteUrl !== undefined
      ? { websiteUrl: normalizeWebsiteUrl(input.websiteUrl) }
      : {}),
    ...(input.scanDefaults !== undefined ? { scanDefaults: input.scanDefaults } : {}),
  };
  const updated = await projectsRepo.updateProject(getDb(), userId, id, patch);
  if (!updated) throw notFound("Project");
  return updated;
}

export async function deleteProject(userId: string, id: string) {
  assertProjectId(id);
  const deleted = await projectsRepo.softDeleteProject(getDb(), userId, id);
  if (!deleted) throw notFound("Project");
}
