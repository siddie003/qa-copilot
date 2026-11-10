import {
  documentOutcome,
  emptyCoverage,
  errorFields,
  publicErrorMessage,
  type DocumentCoverage,
} from "@qa/core";
import { contentRepo } from "@qa/db";
import {
  chunkTokenBudget,
  Chunker,
  EXTRACTOR_VERSION,
  extractStreamInIsolation,
  ExtractionError,
  noTextMessage,
  pageWarnings,
  type ContentChunkDraft,
  type PdfState,
  type StreamBatch,
} from "@qa/reference";
import type { ReferenceRuntime } from "./process";
import { readUpload } from "./upload";

type ContentDocument = NonNullable<Awaited<ReturnType<typeof contentRepo.claimNextDocument>>>;

/** How often a run reports that it is alive and checks for a cancellation request. */
const HEARTBEAT_MS = 5_000;
const MAX_FAILED_PAGES_LISTED = 100;

/** Stored checkpoint of a PDF extraction. */
interface Checkpoint {
  extractorVersion: string;
  pdf: PdfState;
}

const asCoverage = (v: unknown): DocumentCoverage | null =>
  v && typeof v === "object" && "unit" in v ? (v as DocumentCoverage) : null;

/** Adds a batch's page reports and block counts to the coverage. */
export function addBatchToCoverage(c: DocumentCoverage, b: StreamBatch, blocksTotal: number) {
  for (const p of b.pages) {
    if (p.status === "text") c.pagesWithText += 1;
    else if (p.status === "blank") {
      c.pagesBlank += 1;
      c.blankPages.push(p.page);
    } else if (p.status === "image_only") {
      c.pagesImageOnly += 1;
      c.imageOnlyPages.push(p.page);
    } else {
      c.pagesFailed += 1;
      if (c.failedPages.length < MAX_FAILED_PAGES_LISTED)
        c.failedPages.push({ page: p.page, error: p.error ?? "unknown error" });
    }
  }
  c.blocks = blocksTotal;
  c.blocksShortened += b.shortened;
  if (b.truncated) c.blockLimitReached = true;
}

/**
 * Builds the retrieval index (chunks) of a document from its stored blocks, streaming in pages
 * of blocks so memory stays bounded for large documents. Returns the number of chunks.
 */
export async function indexDocument(
  rt: ReferenceRuntime,
  doc: { id: string; projectId: string },
): Promise<number> {
  const budget = chunkTokenBudget(rt.config.DOCUMENT_CHUNK_TOKENS, rt.config.AI_MAX_INPUT_TOKENS);
  let pending: ContentChunkDraft[] = [];
  let total = 0;
  const flush = async () => {
    if (!pending.length) return;
    await contentRepo.insertChunks(rt.db, doc.id, doc.projectId, pending);
    total += pending.length;
    pending = [];
  };
  const chunker = new Chunker(budget, (c) => pending.push(c));
  await contentRepo.forEachBlockPage(rt.db, doc.id, async (blocks) => {
    for (const b of blocks) chunker.push(b);
    if (pending.length >= 200) await flush();
  });
  chunker.finish();
  await flush();
  return total;
}

/** Indexing job: parsed documents without chunks (e.g. parsed before chunking existed). */
export async function processIndexingJob(rt: ReferenceRuntime, doc: ContentDocument) {
  const log = rt.log.child({ documentId: doc.id, projectId: doc.projectId, job: "indexing" });
  try {
    await contentRepo.deleteChunks(rt.db, doc.id);
    const chunks = await indexDocument(rt, doc);
    const coverage = asCoverage(doc.coverage);
    await contentRepo.finishIndexing(
      rt.db,
      doc.id,
      chunks,
      coverage ? { ...coverage, chunks } : null,
    );
    log.info({ chunks }, "content document indexed");
  } catch (err) {
    log.error(errorFields(err), "content document indexing failed");
    // Released for a later attempt by stale recovery (stage stays "indexing" until then).
  }
}

/**
 * Processes one content document in stages: identical earlier upload reused, or extraction in an
 * isolated thread with batches stored as they arrive (PDF: per page range, with a checkpoint),
 * then indexing into retrieval chunks. Coverage is persisted with every batch, so the UI shows
 * real progress and an interrupted or time-limited PDF continues where it stopped.
 */
export async function processDocument(rt: ReferenceRuntime, doc: ContentDocument) {
  const log = rt.log.child({ documentId: doc.id, projectId: doc.projectId });
  const started = Date.now();
  let coverage: DocumentCoverage | null = null;
  const abort = new AbortController();
  let lost = false;
  const heartbeat = setInterval(() => {
    contentRepo
      .documentHeartbeat(rt.db, doc.id)
      .then((row) => {
        if (!row) {
          lost = true;
          abort.abort();
        } else if (row.cancelRequestedAt) abort.abort();
      })
      .catch((err) => log.warn(errorFields(err), "document heartbeat failed"));
  }, HEARTBEAT_MS);
  try {
    const upload = await readUpload(rt, doc.storageKey, doc.filename);

    // Identical bytes already read completely in this project: copy instead of parsing again.
    const checkpoint = doc.checkpoint as Checkpoint | null;
    if (!checkpoint) {
      const same = await contentRepo.findReusableDocument(
        rt.db,
        doc.projectId,
        doc.sha256,
        doc.id,
        EXTRACTOR_VERSION,
      );
      if (same && (await contentRepo.copyDocumentResults(rt.db, doc.id, same.id))) {
        log.info({ reusedFrom: same.id }, "content document reused an identical upload");
        return;
      }
    }

    // Resume a stopped PDF from its checkpoint; everything else starts over.
    const resume =
      upload.kind === "pdf" && checkpoint?.extractorVersion === EXTRACTOR_VERSION
        ? checkpoint.pdf
        : null;
    await contentRepo.prepareDocumentRun(rt.db, doc.id, resume ? resume.collector.nextIndex : null);
    coverage =
      (resume && asCoverage(doc.coverage)) ||
      emptyCoverage(upload.kind === "pdf" ? "page" : "document");
    coverage.notProcessedFrom = null;
    coverage.timeLimitReached = false;
    coverage.stoppedReason = null;
    let blockTotal = resume ? resume.collector.nextIndex : 0;
    let lastState: PdfState | null = resume;
    const cov = coverage;

    const outcome = await extractStreamInIsolation(upload.kind, upload.bytes, {
      resume,
      maxBlocks: rt.config.DOCUMENT_MAX_BLOCKS,
      timeoutMs: rt.config.DOCUMENT_EXTRACTION_TIMEOUT_MS,
      maxMemoryMb: rt.config.DOCUMENT_PARSER_MEMORY_MB,
      signal: abort.signal,
      onStart: ({ totalPages }) => {
        cov.pagesDetected = totalPages;
      },
      onBatch: async (b) => {
        blockTotal += b.blocks.length;
        addBatchToCoverage(cov, b, blockTotal);
        if (b.state) lastState = b.state;
        const stored = await contentRepo.appendDocumentBatch(
          rt.db,
          doc.id,
          b.blocks.map((x) => ({
            type: x.type,
            level: x.level,
            text: x.text,
            normalizedText: x.normalizedText,
            href: x.href,
            pageHint: x.pageHint,
            location: x.location as unknown as Record<string, unknown>,
            order: x.location.index,
          })),
          {
            coverage: cov as unknown as Record<string, unknown>,
            checkpoint: b.state
              ? ({ extractorVersion: EXTRACTOR_VERSION, pdf: b.state } satisfies Checkpoint)
              : null,
            blockCount: blockTotal,
          },
        );
        if (!stored.stored) {
          lost = true;
          abort.abort();
          return;
        }
        await rt.afterDocumentBatch?.(doc.id, blockTotal);
        if (stored.cancelRequested) abort.abort();
      },
    });

    if (lost) {
      log.warn("content document was deleted or taken over while processing; stopped");
      return;
    }
    if (outcome.status === "cancelled") {
      await contentRepo.markDocumentCancelled(
        rt.db,
        doc.id,
        cov as unknown as Record<string, unknown>,
      );
      log.info({ blocks: blockTotal }, "content document processing cancelled");
      return;
    }

    const state = lastState as PdfState | null;
    const pages = cov.pagesDetected ?? 0;
    const morePages = upload.kind === "pdf" && state !== null && state.nextPage <= pages;
    if (outcome.status !== "done") {
      cov.stoppedReason = outcome.reason;
      cov.timeLimitReached = outcome.status === "time_limit";
    } else if (outcome.truncated) cov.blockLimitReached = true;
    if (morePages) cov.notProcessedFrom = state!.nextPage;
    const pageReports = [
      ...cov.imageOnlyPages.map((page) => ({ page, status: "image_only" as const, chars: 0 })),
      ...cov.failedPages.map((p) => ({
        page: p.page,
        status: "failed" as const,
        chars: 0,
        error: p.error,
      })),
    ];
    if (!blockTotal) {
      if (outcome.status !== "done")
        throw new ExtractionError(`${outcome.reason} No text had been read before it stopped.`);
      throw new ExtractionError(
        upload.kind === "pdf"
          ? noTextMessage(
              [
                ...pageReports,
                ...cov.blankPages.map((page) => ({ page, status: "blank" as const, chars: 0 })),
              ],
              pages,
            )
          : "The document contains no text that could be compared.",
      );
    }
    cov.warnings = [
      ...(upload.kind === "pdf" ? pageWarnings(pageReports, pages) : []),
      ...(outcome.status === "done" ? outcome.warnings : []),
    ];

    // Indexing: retrieval chunks from the stored blocks.
    await contentRepo.setDocumentStage(rt.db, doc.id, "indexing");
    const chunks = await indexDocument(rt, doc);
    cov.chunks = chunks;
    const resumable = morePages && !cov.blockLimitReached;
    const finished = await contentRepo.finishDocument(rt.db, doc.id, {
      outcome: documentOutcome(cov),
      coverage: cov as unknown as Record<string, unknown>,
      checkpoint: resumable
        ? ({ extractorVersion: EXTRACTOR_VERSION, pdf: state! } satisfies Checkpoint)
        : null,
      meta: {
        ...(pages ? { pages } : {}),
        warnings: cov.warnings,
        truncated: cov.blockLimitReached,
        extractedAt: new Date().toISOString(),
      },
      blockCount: blockTotal,
      chunkCount: chunks,
      extractorVersion: EXTRACTOR_VERSION,
    });
    log.info(
      {
        blocks: blockTotal,
        chunks,
        pages: cov.pagesDetected,
        outcome: documentOutcome(cov),
        durationMs: Date.now() - started,
        finished,
      },
      "content document processed",
    );
  } catch (err) {
    if (lost) return;
    if (err instanceof ExtractionError)
      log.warn({ reason: err.message }, "content document could not be parsed");
    else log.error(errorFields(err), "content document failed");
    await contentRepo.failDocument(
      rt.db,
      doc.id,
      err instanceof ExtractionError
        ? err.message
        : `Unexpected error while processing: ${publicErrorMessage(err)}`,
      coverage as unknown as Record<string, unknown> | null,
    );
  } finally {
    clearInterval(heartbeat);
  }
}
