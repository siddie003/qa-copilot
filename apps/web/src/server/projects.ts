import "server-only";
import {
  defaultScanDefaults,
  parseFigmaUrl,
  getConfig,
  notFound,
  validationError,
  type ListQuery,
  type ProjectCreateInput,
  type ProjectUpdateInput,
} from "@qa/core";
import { getDb, projectsRepo, referencesRepo, type ProjectSummary } from "@qa/db";
import { validateWebsiteUrl } from "@qa/security";
import { z } from "zod";
import { validatePageLinks } from "./project-assets";

const uuid = z.uuid();

export const FIGMA_AS_WEBSITE_MESSAGE =
  "This is a Figma link. Enter the address of the live website to test here, and add the Figma link as the design reference.";

/** Validates a website URL against the static SSRF rules; returns the normalized URL. */
export function normalizeWebsiteUrl(raw: string): string {
  const result = validateWebsiteUrl(raw, {
    allowedPrivateHosts: getConfig().SCAN_ALLOWED_PRIVATE_HOSTS,
  });
  if (!result.ok)
    throw validationError(result.message, [
      { path: "websiteUrl", message: result.message, code: result.code },
    ]);
  // A design file is not the website: never crawl a Figma link as the site under test.
  const host = new URL(result.url).hostname.toLowerCase();
  if (host === "figma.com" || host.endsWith(".figma.com"))
    throw validationError(FIGMA_AS_WEBSITE_MESSAGE, [
      { path: "websiteUrl", message: FIGMA_AS_WEBSITE_MESSAGE, code: "figma_url" },
    ]);
  return result.url;
}

/** Validates a Figma link and extracts identifiers (no request to Figma is made here). */
export function parseFigmaReference(raw: string) {
  const parsed = parseFigmaUrl(raw);
  if (!parsed.ok)
    throw validationError(parsed.message, [{ path: "figmaUrl", message: parsed.message }]);
  return { figmaUrl: parsed.url, figmaFileKey: parsed.fileKey, figmaNodeIds: parsed.nodeIds };
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
  const websiteUrl = normalizeWebsiteUrl(input.websiteUrl);
  // Page links are validated against the website before anything is stored, so a project is
  // never created with a partial list.
  const pageLinks = input.pageLinks?.length ? validatePageLinks(input.pageLinks, websiteUrl) : [];
  return projectsRepo.createProject(getDb(), userId, {
    name: input.name,
    websiteUrl,
    scanDefaults:
      input.scanDefaults ??
      defaultScanDefaults({ maxPages: cfg.SCAN_MAX_PAGES, maxDepth: cfg.SCAN_MAX_DEPTH }),
    ...(input.figmaUrl ? { figma: parseFigmaReference(input.figmaUrl) } : {}),
    ...(pageLinks.length ? { pageLinks } : {}),
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

export async function listReferences(userId: string, projectId: string) {
  await getProject(userId, projectId); // ownership check (404 otherwise)
  return referencesRepo.listReferenceSources(getDb(), projectId);
}

export async function addFigmaReference(userId: string, projectId: string, figmaUrl: string) {
  await getProject(userId, projectId);
  return referencesRepo.addFigmaReference(getDb(), projectId, parseFigmaReference(figmaUrl));
}
