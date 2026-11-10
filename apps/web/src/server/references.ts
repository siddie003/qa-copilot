import "server-only";
import { createHash, randomUUID } from "node:crypto";
import {
  AppError,
  countSpecValues,
  designSpecSchema,
  diffSpecs,
  emptyDesignSpec,
  getConfig,
  notFound,
  searchTerms,
  validationError,
  zodIssues,
} from "@qa/core";
import { contentRepo, designSpecsRepo, getDb, referencesRepo, secretsRepo } from "@qa/db";
import { encryptSecret, validateDocumentUpload, verifyDocumentContent } from "@qa/security";
import { createLocalStorage } from "@qa/storage";
import { z } from "zod";
import type { UploadedFile } from "./http";
import { getProject } from "./projects";

export const MAX_CONTENT_DOCUMENTS = 50;
export const MAX_GUIDELINE_DOCUMENTS = 10;

const uuid = z.uuid();
const storage = () => createLocalStorage(getConfig().storageDirAbsolute);
const maxUploadBytes = () => getConfig().MAX_UPLOAD_MB * 1024 * 1024;

function assertId(id: string, what: string) {
  if (!uuid.safeParse(id).success) throw notFound(what);
}

/** Validates an uploaded document and stores it under a random key (never the user's name). */
async function storeUpload(projectId: string, file: UploadedFile, folder: string) {
  const check = validateDocumentUpload({
    filename: file.filename,
    declaredType: file.declaredType,
    bytes: file.bytes,
    limits: { maxBytes: maxUploadBytes() },
  });
  if (!check.ok)
    throw check.code === "TOO_LARGE"
      ? new AppError("PAYLOAD_TOO_LARGE", check.message)
      : validationError(check.message, [{ path: "file", message: check.message }]);
  // DOCX: every archive entry must expand to exactly its declared size (zip-bomb guard).
  const content = await verifyDocumentContent({ kind: check.kind, bytes: file.bytes });
  if (content) throw validationError(content.message, [{ path: "file", message: content.message }]);
  const ext = check.kind === "md" ? "md" : check.kind;
  const storageKey = `projects/${projectId}/${folder}/${randomUUID()}.${ext}`;
  await storage().put(storageKey, file.bytes);
  return {
    storageKey,
    filename: check.filename,
    mimeType: check.mimeType,
    kind: check.kind,
    sizeBytes: file.bytes.length,
    sha256: createHash("sha256").update(file.bytes).digest("hex"),
  };
}

const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;

/** Everything the References page shows: design spec state, sources and documents. */
export async function getReferenceState(userId: string, projectId: string) {
  const project = await getProject(userId, projectId);
  const db = getDb();
  const cfg = getConfig();
  const [sources, specState, documents, figmaSecret] = await Promise.all([
    referencesRepo.listReferenceSources(db, project.id),
    designSpecsRepo.getDesignSpecState(db, project.id),
    contentRepo.listDocuments(db, project.id),
    secretsRepo.getProjectSecret(db, project.id, secretsRepo.FIGMA_TOKEN_KIND),
  ]);
  const activeSpec = specState.active ? designSpecsRepo.specOf(specState.active) : null;
  const draftSpec = specState.draft ? designSpecsRepo.specOf(specState.draft) : null;
  return {
    designSpec: {
      active: specState.active
        ? {
            id: specState.active.id,
            version: specState.active.version,
            origin: specState.active.origin,
            confirmedAt: iso(specState.active.confirmedAt),
            valueCount: countSpecValues(activeSpec!),
            spec: activeSpec!,
          }
        : null,
      draft: specState.draft
        ? {
            version: specState.draft.version,
            origin: specState.draft.origin,
            createdAt: iso(specState.draft.createdAt),
            referenceSourceId: specState.draft.referenceSourceId,
            valueCount: countSpecValues(draftSpec!),
            spec: draftSpec!,
            changes: diffSpecs(activeSpec ?? emptyDesignSpec(), draftSpec!),
          }
        : null,
      history: specState.history.map((h) => ({
        version: h.version,
        origin: h.origin,
        confirmedAt: iso(h.confirmedAt),
      })),
    },
    sources: sources.map((s) => ({
      ...s,
      // Frame lists stay on the server (large files have thousands); counts are kept.
      manifest: s.manifest
        ? {
            ...s.manifest,
            pages: ((s.manifest.pages ?? []) as Array<Record<string, unknown>>).map(
              ({ frames: _frames, ...p }) => p,
            ),
          }
        : null,
      fetchedAt: iso(s.fetchedAt),
      createdAt: s.createdAt.toISOString(),
    })),
    documents: documents.map((d) => ({
      ...d,
      createdAt: d.createdAt.toISOString(),
      updatedAt: d.updatedAt.toISOString(),
    })),
    figma: {
      serverTokenConfigured: Boolean(cfg.FIGMA_ACCESS_TOKEN),
      projectTokenConfigured: Boolean(figmaSecret),
      encryptionAvailable: Boolean(cfg.ENCRYPTION_KEY),
    },
    limits: { maxUploadMb: cfg.MAX_UPLOAD_MB, maxDocuments: MAX_CONTENT_DOCUMENTS },
  };
}

export type ReferenceState = Awaited<ReturnType<typeof getReferenceState>>;

// ---- design spec -----------------------------------------------------------------------------

/** Saves manually entered (or pasted JSON) design values as a new confirmed version. */
export async function saveDesignSpec(userId: string, projectId: string, input: unknown) {
  const project = await getProject(userId, projectId);
  const parsed = designSpecSchema.safeParse(input);
  if (!parsed.success)
    throw validationError("The design reference is not valid", zodIssues(parsed.error));
  try {
    return await designSpecsRepo.saveConfirmedSpec(getDb(), project.id, parsed.data, { userId });
  } catch (err) {
    if (err instanceof designSpecsRepo.DraftPendingError)
      throw new AppError(
        "CONFLICT",
        "Extracted values are waiting for review. Confirm or discard the draft before saving manual changes.",
      );
    throw err;
  }
}

export async function confirmDesignDraft(userId: string, projectId: string, version: number) {
  const project = await getProject(userId, projectId);
  const row = await designSpecsRepo.confirmDraft(getDb(), project.id, version, userId);
  if (!row) throw new AppError("CONFLICT", "This draft is no longer pending. Reload the page.");
  return row;
}

export async function discardDesignDraft(userId: string, projectId: string) {
  const project = await getProject(userId, projectId);
  if (!(await designSpecsRepo.discardDraft(getDb(), project.id))) throw notFound("Draft");
}

// ---- reference sources (Figma, guideline documents) --------------------------------------------

export async function uploadGuideline(userId: string, projectId: string, file: UploadedFile) {
  const project = await getProject(userId, projectId);
  const db = getDb();
  const existing = (await referencesRepo.listReferenceSources(db, project.id)).filter(
    (s) => s.kind === "guideline_document",
  );
  if (existing.length >= MAX_GUIDELINE_DOCUMENTS)
    throw new AppError(
      "CONFLICT",
      `A project can have at most ${MAX_GUIDELINE_DOCUMENTS} guideline documents.`,
    );
  const duplicate = existing.find(
    (s) => s.meta?.sha256 === createHash("sha256").update(file.bytes).digest("hex"),
  );
  if (duplicate)
    throw new AppError(
      "CONFLICT",
      `This brand guideline is already uploaded to the project (as “${String(duplicate.meta?.filename ?? "a guideline")}”).`,
    );
  const stored = await storeUpload(project.id, file, "guidelines");
  return referencesRepo.addGuidelineReference(db, project.id, {
    storageKey: stored.storageKey,
    meta: {
      filename: stored.filename,
      mimeType: stored.mimeType,
      sizeBytes: stored.sizeBytes,
      sha256: stored.sha256,
    },
  });
}

export async function refreshReference(userId: string, projectId: string, referenceId: string) {
  const project = await getProject(userId, projectId);
  assertId(referenceId, "Reference");
  const row = await referencesRepo.requeueReference(getDb(), project.id, referenceId);
  if (!row) {
    const exists = await referencesRepo.getReference(getDb(), project.id, referenceId);
    if (!exists) throw notFound("Reference");
    throw new AppError("CONFLICT", "This reference is already being processed.");
  }
  return row;
}

/** Cancels a queued reference at once, or asks the worker to stop a running read. */
export async function cancelReference(userId: string, projectId: string, referenceId: string) {
  const project = await getProject(userId, projectId);
  assertId(referenceId, "Reference");
  const row = await referencesRepo.cancelReference(getDb(), project.id, referenceId);
  if (!row) {
    const exists = await referencesRepo.getReference(getDb(), project.id, referenceId);
    if (!exists) throw notFound("Reference");
    throw new AppError(
      "CONFLICT",
      "Only references that are queued or being read can be cancelled.",
    );
  }
  return row;
}

export async function deleteReference(userId: string, projectId: string, referenceId: string) {
  const project = await getProject(userId, projectId);
  assertId(referenceId, "Reference");
  const row = await referencesRepo.deleteReference(getDb(), project.id, referenceId);
  if (!row) throw notFound("Reference");
  // Values already merged into design spec versions keep their citations; only the file goes.
  if (row.storageKey)
    await storage()
      .removePrefix(row.storageKey)
      .catch(() => {});
}

const figmaTokenSchema = z.object({
  token: z.string().trim().min(10, "Enter the Figma personal access token").max(200),
});

export async function setFigmaToken(userId: string, projectId: string, input: unknown) {
  const project = await getProject(userId, projectId);
  const parsed = figmaTokenSchema.safeParse(input);
  if (!parsed.success) throw validationError("Invalid token", zodIssues(parsed.error));
  const key = getConfig().ENCRYPTION_KEY;
  if (!key)
    throw new AppError(
      "CONFIG_ERROR",
      "The Figma token cannot be stored because ENCRYPTION_KEY is not configured on the server",
      { expose: true },
    );
  await secretsRepo.setProjectSecret(
    getDb(),
    project.id,
    secretsRepo.FIGMA_TOKEN_KIND,
    encryptSecret(JSON.stringify({ token: parsed.data.token }), key, project.id),
    { configured: true },
  );
}

export async function clearFigmaToken(userId: string, projectId: string) {
  const project = await getProject(userId, projectId);
  await secretsRepo.deleteProjectSecret(getDb(), project.id, secretsRepo.FIGMA_TOKEN_KIND);
}

// ---- content documents --------------------------------------------------------------------------

const targetPath = (raw: string | undefined) => {
  const v = (raw ?? "").trim();
  if (!v) return null;
  if (!/^\/[^\s]*$/.test(v) || v.length > 500)
    throw validationError("Invalid page path", [
      { path: "targetPath", message: "Use a site path that starts with /, e.g. /about" },
    ]);
  return v;
};

export async function uploadContentDocument(userId: string, projectId: string, file: UploadedFile) {
  const project = await getProject(userId, projectId);
  const db = getDb();
  if ((await contentRepo.countDocuments(db, project.id)) >= MAX_CONTENT_DOCUMENTS)
    throw new AppError(
      "CONFLICT",
      `A project can have at most ${MAX_CONTENT_DOCUMENTS} content documents.`,
    );
  const path = targetPath(file.fields.targetPath);
  const sha256 = createHash("sha256").update(file.bytes).digest("hex");
  const same = await contentRepo.findDocumentBySha(db, project.id, sha256);
  if (same)
    throw new AppError(
      "CONFLICT",
      `This document is already uploaded to the project (as “${same.filename}”). Change its website page there instead of uploading it again.`,
    );
  const stored = await storeUpload(project.id, file, "documents");
  return contentRepo.insertDocument(db, project.id, {
    filename: stored.filename,
    mimeType: stored.mimeType,
    sizeBytes: stored.sizeBytes,
    sha256: stored.sha256,
    storageKey: stored.storageKey,
    targetPath: path,
  });
}

async function ownedDocument(userId: string, documentId: string) {
  assertId(documentId, "Document");
  const doc = await contentRepo.getOwnedDocument(getDb(), userId, documentId);
  if (!doc) throw notFound("Document");
  return doc;
}

export async function updateContentDocument(userId: string, documentId: string, raw: string) {
  const doc = await ownedDocument(userId, documentId);
  return contentRepo.setTargetPath(getDb(), doc.id, targetPath(raw));
}

export async function deleteContentDocument(userId: string, documentId: string) {
  const doc = await ownedDocument(userId, documentId);
  await contentRepo.deleteDocument(getDb(), doc.id);
  await storage()
    .removePrefix(doc.storageKey)
    .catch(() => {});
}

export async function retryContentDocument(userId: string, documentId: string) {
  const doc = await ownedDocument(userId, documentId);
  const row = await contentRepo.requeueDocument(getDb(), doc.id);
  if (!row)
    throw new AppError(
      "CONFLICT",
      "Only documents that failed, were cancelled, or stopped before their last page can be processed again.",
    );
  return row;
}

export async function cancelContentDocument(userId: string, documentId: string) {
  const doc = await ownedDocument(userId, documentId);
  const row = await contentRepo.cancelDocument(getDb(), doc.id);
  if (!row)
    throw new AppError(
      "CONFLICT",
      "Only documents that are queued or being processed can be cancelled.",
    );
  return row;
}

/**
 * Searches the project's indexed approved content (full text, any language, no stemming).
 * Owner-checked; results are excerpts with their document, pages and section.
 */
export async function searchContent(
  userId: string,
  projectId: string,
  q: string | null,
  documentId: string | null,
) {
  const project = await getProject(userId, projectId);
  const query = (q ?? "").trim().slice(0, 500);
  const terms = searchTerms(query);
  if (!terms) return { query, results: [] };
  if (documentId) assertId(documentId, "Document");
  const rows = await contentRepo.searchChunks(getDb(), {
    projectId: project.id,
    terms,
    documentIds: documentId ? [documentId] : undefined,
    limit: 20,
  });
  return {
    query,
    results: rows.map((r) => ({
      documentId: r.documentId,
      filename: r.filename,
      section: r.headingText,
      pageHint: r.pageHint,
      pageStart: r.pageStart,
      pageEnd: r.pageEnd,
      chunkIndex: r.chunkIndex,
      excerpt: r.text.length > 600 ? `${r.text.slice(0, 600)}…` : r.text,
      rank: Number(r.rank),
    })),
  };
}

export async function listContentBlocks(userId: string, documentId: string) {
  const doc = await ownedDocument(userId, documentId);
  const blocks = await contentRepo.listBlocks(getDb(), doc.id);
  return { document: { id: doc.id, filename: doc.filename, blockCount: doc.blockCount }, blocks };
}
