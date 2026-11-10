import "server-only";
import { createHash, randomUUID } from "node:crypto";
import {
  AppError,
  checkPageLink,
  getConfig,
  MAX_FONT_FILE_MB,
  MAX_PAGE_LINKS,
  notFound,
  pageLinkKey,
  validationError,
  type ScanFontReference,
} from "@qa/core";
import { fontsRepo, getDb, pageLinksRepo, type ProjectFontRow } from "@qa/db";
import {
  fontFamilyNames,
  validateFontUpload,
  validateWebsiteUrl,
  type FontMetadata,
} from "@qa/security";
import { createLocalStorage } from "@qa/storage";
import { z } from "zod";
import type { UploadedFile } from "./http";
import { getProject } from "./projects";

export const MAX_FONTS = 20;
/** Font files are small; a much lower limit than documents keeps the parser's work bounded. */
export const MAX_FONT_MB = MAX_FONT_FILE_MB;

const uuid = z.uuid();
const storage = () => createLocalStorage(getConfig().storageDirAbsolute);

function assertId(id: string, what: string) {
  if (!uuid.safeParse(id).success) throw notFound(what);
}

// ---- page links --------------------------------------------------------------------------------

/**
 * Validates page links for a website: same site, http(s), passes the static SSRF rules (private
 * and internal addresses are rejected unless allowed for scanning), no duplicates. Returns the
 * links to store; throws a validation error naming each problem (path `pageLinks.<n>`).
 */
export function validatePageLinks(raw: string[], websiteUrl: string) {
  const cfg = getConfig();
  const out: Array<{ url: string; linkKey: string }> = [];
  const problems: Array<{ path: string; message: string }> = [];
  const keys = new Set<string>();
  raw.forEach((value, i) => {
    const r = checkPageLink(value, websiteUrl);
    if (!r.ok) return problems.push({ path: `pageLinks.${i}`, message: r.message });
    const safe = validateWebsiteUrl(r.url, { allowedPrivateHosts: cfg.SCAN_ALLOWED_PRIVATE_HOSTS });
    if (!safe.ok) return problems.push({ path: `pageLinks.${i}`, message: safe.message });
    const linkKey = pageLinkKey(r.url);
    if (keys.has(linkKey))
      return problems.push({ path: `pageLinks.${i}`, message: `${r.path} is listed twice.` });
    keys.add(linkKey);
    out.push({ url: r.url, linkKey });
  });
  if (problems.length) throw validationError(problems[0]!.message, problems);
  if (out.length > MAX_PAGE_LINKS)
    throw validationError(`A project can have at most ${MAX_PAGE_LINKS} page links.`);
  return out;
}

const serializeLink = (l: { id: string; url: string; createdAt: Date }) => ({
  id: l.id,
  url: l.url,
  path: (() => {
    const u = new URL(l.url);
    return `${u.pathname}${u.search}`;
  })(),
  createdAt: l.createdAt.toISOString(),
});

export async function listPageLinks(userId: string, projectId: string) {
  const project = await getProject(userId, projectId);
  return (await pageLinksRepo.listPageLinks(getDb(), project.id)).map(serializeLink);
}

export async function addPageLink(userId: string, projectId: string, url: string) {
  const project = await getProject(userId, projectId);
  const db = getDb();
  let link: { url: string; linkKey: string };
  try {
    [link] = validatePageLinks([url], project.websiteUrl) as [{ url: string; linkKey: string }];
  } catch (err) {
    // Single-link API: report the problem on the `url` field.
    if (err instanceof AppError && err.code === "VALIDATION_ERROR")
      throw validationError(err.message, [{ path: "url", message: err.message }]);
    throw err;
  }
  const existing = await pageLinksRepo.findPageLinkByKey(db, project.id, link.linkKey);
  if (existing)
    throw new AppError(
      "CONFLICT",
      `This page is already in the list (${serializeLink(existing).path}).`,
    );
  if ((await pageLinksRepo.countPageLinks(db, project.id)) >= MAX_PAGE_LINKS)
    throw new AppError("CONFLICT", `A project can have at most ${MAX_PAGE_LINKS} page links.`);
  const row = await pageLinksRepo.addPageLink(db, project.id, link);
  if (!row) throw new AppError("CONFLICT", "This page is already in the list.");
  return serializeLink(row);
}

export async function deletePageLink(userId: string, projectId: string, linkId: string) {
  const project = await getProject(userId, projectId);
  assertId(linkId, "Page link");
  const row = await pageLinksRepo.deletePageLink(getDb(), project.id, linkId);
  if (!row) throw notFound("Page link");
}

// ---- brand fonts -------------------------------------------------------------------------------

const serializeFont = (f: ProjectFontRow) => {
  const m = f.metadata as unknown as FontMetadata;
  return {
    id: f.id,
    filename: f.filename,
    format: f.format,
    sizeBytes: f.sizeBytes,
    family: m.typographicFamily ?? m.family,
    style: m.typographicSubfamily ?? m.subfamily,
    fullName: m.fullName,
    postScriptName: m.postScriptName,
    weight: m.weight,
    italic: m.italic,
    variable: m.variable,
    embedding: m.embedding,
    glyphCount: m.glyphCount,
    createdAt: f.createdAt.toISOString(),
  };
};
export type ProjectFont = ReturnType<typeof serializeFont>;

export async function listFonts(userId: string, projectId: string) {
  const project = await getProject(userId, projectId);
  return (await fontsRepo.listFonts(getDb(), project.id)).map(serializeFont);
}

/**
 * Validates a font file (extension, MIME type, signature, readable font tables) and stores it
 * under a random key. Nothing is stored when the file is not a usable font.
 */
export async function uploadFont(userId: string, projectId: string, file: UploadedFile) {
  const project = await getProject(userId, projectId);
  const db = getDb();
  const maxBytes = Math.min(MAX_FONT_MB, getConfig().MAX_UPLOAD_MB) * 1024 * 1024;
  const check = validateFontUpload({
    filename: file.filename,
    declaredType: file.declaredType,
    bytes: file.bytes,
    limits: { maxBytes },
  });
  if (!check.ok)
    throw check.code === "TOO_LARGE"
      ? new AppError("PAYLOAD_TOO_LARGE", check.message)
      : validationError(check.message, [{ path: "file", message: check.message }]);
  const sha256 = createHash("sha256").update(file.bytes).digest("hex");
  const existing = await fontsRepo.findFontBySha(db, project.id, sha256);
  if (existing)
    throw new AppError(
      "CONFLICT",
      `This font file is already uploaded to the project (as “${existing.filename}”).`,
    );
  if ((await fontsRepo.countFonts(db, project.id)) >= MAX_FONTS)
    throw new AppError("CONFLICT", `A project can have at most ${MAX_FONTS} font files.`);
  const storageKey = `projects/${project.id}/fonts/${randomUUID()}.${check.format}`;
  await storage().put(storageKey, file.bytes);
  const row = await fontsRepo.insertFont(db, project.id, {
    filename: check.filename,
    format: check.format,
    mimeType: check.mimeType,
    sizeBytes: file.bytes.length,
    sha256,
    storageKey,
    metadata: check.metadata as unknown as Record<string, unknown>,
  });
  if (!row) {
    // A concurrent upload of the same file won the race: keep its row, drop this copy.
    await storage()
      .removePrefix(storageKey)
      .catch(() => {});
    throw new AppError("CONFLICT", "This font file is already uploaded to the project.");
  }
  return serializeFont(row);
}

export async function deleteFont(userId: string, projectId: string, fontId: string) {
  const project = await getProject(userId, projectId);
  assertId(fontId, "Font");
  const row = await fontsRepo.deleteFont(getDb(), project.id, fontId);
  if (!row) throw notFound("Font");
  await storage()
    .removePrefix(row.storageKey)
    .catch(() => {});
}

/** The project's fonts as frozen into a scan (names only, never the files). */
export async function fontReferencesForScan(projectId: string): Promise<ScanFontReference[]> {
  return (await fontsRepo.listFonts(getDb(), projectId)).map((f) => {
    const m = f.metadata as unknown as FontMetadata;
    return {
      id: f.id,
      filename: f.filename,
      families: fontFamilyNames(m),
      weight: m.weight,
      italic: m.italic,
    };
  });
}
