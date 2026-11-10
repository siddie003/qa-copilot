import {
  AIProviderError,
  CHARS_PER_TOKEN_ESTIMATE,
  createAIProvider,
  extractGuidelineWithAi,
  GUIDELINE_PROMPT_VERSION,
  GUIDELINE_SYSTEM_PROMPT,
  mergeAssistedSpec,
  type AIProvider,
  type AssistedExtraction,
} from "@qa/ai";
import {
  countSpecValues,
  errorFields,
  publicErrorMessage,
  type AppConfig,
  type Logger,
} from "@qa/core";
import { contentRepo, designSpecsRepo, referencesRepo, secretsRepo, type Database } from "@qa/db";
import {
  extractGuidelineDraft,
  extractInIsolation,
  ExtractionError,
  type ExtractionResult,
  FigmaError,
} from "@qa/reference";
import { decryptSecret } from "@qa/security";
import type { Storage } from "@qa/storage";
import { processDocument, processIndexingJob } from "./documents";
import { processFigmaReference } from "./figma";
import { readUpload } from "./upload";

export interface ReferenceRuntime {
  db: Database;
  storage: Storage;
  config: AppConfig;
  log: Logger;
  /** Figma API base URL (tests point it at a local mock). */
  figmaBaseUrl?: string;
  fetchImpl?: typeof fetch;
  /** AI provider for assisted guideline extraction; defaults to the configured one. */
  ai?: AIProvider;
  /** Tests only: called after each stored batch of a content document. */
  afterDocumentBatch?: (documentId: string, blocksStored: number) => Promise<void>;
  /** Tests only: called after each stored batch of a Figma read. */
  afterReferenceBatch?: (referenceId: string) => Promise<void>;
  /** Tests only: response cap in bytes (instead of FIGMA_MAX_RESPONSE_MB) and backoff step. */
  figmaMaxBytes?: number;
  figmaRetryBaseMs?: number;
}

const EXTRACTION_TIMEOUT_MS = 60_000;
/** Upper bound for the AI-assisted part of a guideline extraction. */
const AI_GUIDELINE_TIMEOUT_MS = 180_000;

type Blocks = ExtractionResult["blocks"];

/**
 * AI-assisted reading of a guideline document (only with a configured provider). Failures are
 * reported in the reference's details; the literal extraction is used either way.
 */
async function assistGuideline(
  rt: ReferenceRuntime,
  blocks: Blocks,
  doc: { referenceId: string; filename: string },
  log: Logger,
): Promise<{ result: AssistedExtraction | null; meta: Record<string, unknown> } | null> {
  const provider = rt.ai ?? createAIProvider(rt.config);
  if (provider.id === "none") return null;
  const base = {
    provider: provider.id,
    model: provider.model,
    promptVersion: GUIDELINE_PROMPT_VERSION,
  };
  try {
    const result = await extractGuidelineWithAi(
      provider,
      blocks.map((b) => ({
        index: b.location.index,
        text: b.text,
        page: b.location.page,
        line: b.location.line,
      })),
      doc,
      AbortSignal.timeout(AI_GUIDELINE_TIMEOUT_MS),
      {
        maxInputChars: Math.max(
          2_000,
          rt.config.AI_MAX_INPUT_TOKENS * CHARS_PER_TOKEN_ESTIMATE - GUIDELINE_SYSTEM_PROMPT.length,
        ),
      },
    );
    if (!result)
      return {
        result: null,
        meta: { ...base, status: "skipped", reason: "No line mentions design values" },
      };
    return {
      result,
      meta: {
        ...base,
        model: result.model,
        status: "completed",
        linesSent: result.linesSent,
        relevantLines: result.relevantLines,
        accepted: result.accepted.length,
        rejected: result.rejected.length,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      },
    };
  } catch (err) {
    const error =
      err instanceof AIProviderError ? err.message : `Unexpected error: ${publicErrorMessage(err)}`;
    log.warn({ error }, "AI-assisted guideline extraction failed; literal values are used");
    return { result: null, meta: { ...base, status: "failed", error } };
  }
}

type ReferenceSource = NonNullable<Awaited<ReturnType<typeof referencesRepo.claimNextReference>>>;

/** Reads a stored upload, re-validates it, and extracts it whole in an isolated thread. */
async function readValidated(rt: ReferenceRuntime, storageKey: string, filename: string) {
  const { kind, bytes } = await readUpload(rt, storageKey, filename);
  return extractInIsolation(kind, bytes, {
    timeoutMs: EXTRACTION_TIMEOUT_MS,
    maxMemoryMb: rt.config.DOCUMENT_PARSER_MEMORY_MB,
    maxBlocks: rt.config.DOCUMENT_MAX_BLOCKS,
  });
}

const failureMessage = (err: unknown) =>
  err instanceof ExtractionError || err instanceof FigmaError
    ? err.message
    : `Unexpected error while processing: ${publicErrorMessage(err)}`;

/** The project's own Figma token (encrypted) takes precedence over FIGMA_ACCESS_TOKEN. */
async function figmaToken(rt: ReferenceRuntime, projectId: string): Promise<string | null> {
  const row = await secretsRepo.getProjectSecret(rt.db, projectId, secretsRepo.FIGMA_TOKEN_KIND);
  if (row && rt.config.ENCRYPTION_KEY) {
    try {
      const parsed = JSON.parse(decryptSecret(row.ciphertext, rt.config.ENCRYPTION_KEY, projectId));
      if (typeof parsed.token === "string" && parsed.token) return parsed.token;
    } catch {
      throw new FigmaError(
        "NO_TOKEN",
        "The project's Figma token could not be decrypted (was ENCRYPTION_KEY changed?). Save the token again.",
      );
    }
  }
  return rt.config.FIGMA_ACCESS_TOKEN ?? null;
}

/** Fetches a Figma file or extracts a guideline document, producing a draft design spec. */
export async function processReference(rt: ReferenceRuntime, ref: ReferenceSource) {
  const log = rt.log.child({ referenceId: ref.id, projectId: ref.projectId, kind: ref.kind });
  const previous = (ref.meta ?? {}) as Record<string, unknown>;
  try {
    if (ref.kind === "figma") {
      const token = await figmaToken(rt, ref.projectId);
      if (!token) {
        await referencesRepo.completeReference(rt.db, ref.id, {
          status: "unavailable",
          error:
            "No Figma access token is configured. Add one on the References page (or set FIGMA_ACCESS_TOKEN on the server), or enter design values manually.",
        });
        return;
      }
      await processFigmaReference(rt, ref, token, log);
      return;
    }
    if (ref.kind === "guideline_document") {
      const filename = String(previous.filename ?? "guideline");
      const result = await readValidated(rt, ref.storageKey!, filename);
      const doc = { referenceId: ref.id, filename };
      const literal = extractGuidelineDraft(result.blocks, doc);
      // AI-read values only fill what the literal extraction did not find, each verified
      // against the line it cites.
      const assisted = await assistGuideline(rt, result.blocks, doc, log);
      const merged = assisted?.result
        ? mergeAssistedSpec(literal.spec, assisted.result.spec)
        : { spec: literal.spec, added: new Set<string>() };
      const spec = merged.spec;
      const report = {
        extracted: [
          ...literal.report.extracted,
          ...(assisted?.result?.accepted ?? [])
            .filter((a) => merged.added.has(a.key))
            .map((a) => `AI-assisted: ${a.text}`),
        ],
        skipped: [
          ...literal.report.skipped,
          ...(assisted?.result?.rejected ?? []).map((r) => `AI value not used: ${r}`),
        ],
      };
      const values = countSpecValues(spec);
      const draft = values
        ? await designSpecsRepo.upsertDraftFromExtraction(rt.db, ref.projectId, spec, {
            origin: "document",
            referenceSourceId: ref.id,
          })
        : null;
      await referencesRepo.completeReference(rt.db, ref.id, {
        status: "ready",
        meta: {
          ...previous,
          pages: result.meta.pages ?? null,
          valuesFound: values,
          extracted: report.extracted.slice(0, 1_000),
          skipped: report.skipped.slice(0, 1_000),
          extractedTotal: report.extracted.length,
          skippedTotal: report.skipped.length,
          draftVersion: draft?.version ?? null,
          ai: assisted?.meta ?? null,
          note: values
            ? draft
              ? null
              : "No new values compared with the active design reference."
            : "No design values were found. Values are read only when written literally (e.g. “Primary — #1A56DB”, “H1 — Inter Bold 48px”).",
        },
      });
      log.info({ values, draft: draft?.version ?? null }, "guideline document processed");
      return;
    }
    await referencesRepo.completeReference(rt.db, ref.id, {
      status: "failed",
      error: "This reference type is not processed automatically.",
    });
  } catch (err) {
    if (err instanceof FigmaError || err instanceof ExtractionError)
      log.warn({ reason: err.message }, "reference could not be processed");
    else log.error(errorFields(err), "reference processing failed");
    await referencesRepo.completeReference(rt.db, ref.id, {
      status: "failed",
      error: failureMessage(err),
    });
  }
}

/** Processes one queued item (documents first). Returns false when nothing was queued. */
export async function processNextReferenceJob(rt: ReferenceRuntime): Promise<boolean> {
  const doc = await contentRepo.claimNextDocument(rt.db);
  if (doc) {
    await processDocument(rt, doc);
    return true;
  }
  const ref = await referencesRepo.claimNextReference(rt.db);
  if (ref) {
    await processReference(rt, ref);
    return true;
  }
  // Lowest priority: building missing retrieval indexes of parsed documents.
  const indexing = await contentRepo.claimNextIndexing(rt.db);
  if (indexing) {
    await processIndexingJob(rt, indexing);
    return true;
  }
  return false;
}

export { processDocument };
