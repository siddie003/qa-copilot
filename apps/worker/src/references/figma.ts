import { countSpecValues, errorFields, type Logger } from "@qa/core";
import { designSpecsRepo, referencesRepo } from "@qa/db";
import {
  FigmaClient,
  FigmaError,
  finalizeFigma,
  readFigmaReference,
  type FigmaCheckpoint,
  type FigmaManifest,
} from "@qa/reference";
import type { ReferenceRuntime } from "./process";

type ReferenceSource = NonNullable<Awaited<ReturnType<typeof referencesRepo.claimNextReference>>>;

const HEARTBEAT_MS = 5_000;

/** Longest list of extracted/skipped values stored; the totals are always stored. */
const MAX_LISTED = 1_000;

const asJson = (v: unknown) => v as Record<string, unknown>;

/**
 * Reads a Figma reference through the official REST API (see `readFigmaReference`): metadata
 * first (unchanged files need no file-content request), the whole file or its pages in batches,
 * a manifest persisted after every batch, cancellation between requests, and a checkpoint so a
 * read stopped by a rate limit, network error, cancellation or worker crash continues later.
 * Values found are turned into a draft design reference (also from a partial read, labelled
 * partial — drafts are reviewed before use and never remove values that were not read).
 */
export async function processFigmaReference(
  rt: ReferenceRuntime,
  ref: ReferenceSource,
  token: string,
  log: Logger,
) {
  const previousMeta = (ref.meta ?? {}) as Record<string, unknown>;
  const abort = new AbortController();
  let lost = false;
  const heartbeat = setInterval(() => {
    referencesRepo
      .referenceHeartbeat(rt.db, ref.id)
      .then((row) => {
        if (!row) {
          lost = true;
          abort.abort();
        } else if (row.cancelRequestedAt) abort.abort();
      })
      .catch((err) => log.warn(errorFields(err), "reference heartbeat failed"));
  }, HEARTBEAT_MS);
  try {
    const client = new FigmaClient({
      token,
      baseUrl: rt.figmaBaseUrl,
      fetchImpl: rt.fetchImpl,
      timeoutMs: rt.config.FIGMA_TIMEOUT_MS,
      maxBytes: rt.figmaMaxBytes ?? rt.config.FIGMA_MAX_RESPONSE_MB * 1024 * 1024,
      maxRetries: rt.config.FIGMA_MAX_RETRIES,
      maxRetryWaitMs: rt.config.FIGMA_MAX_RETRY_WAIT_MS,
      retryBaseMs: rt.figmaRetryBaseMs,
      signal: abort.signal,
    });
    const result = await readFigmaReference({
      client,
      fileKey: ref.figmaFileKey!,
      nodeIds: ref.figmaNodeIds ?? [],
      previous: (ref.manifest as unknown as FigmaManifest | null) ?? null,
      checkpoint: (ref.checkpoint as unknown as FigmaCheckpoint | null) ?? null,
      pagesPerRequest: rt.config.FIGMA_PAGES_PER_REQUEST,
      maxResponseMb: rt.config.FIGMA_MAX_RESPONSE_MB,
      onProgress: async (manifest, checkpoint) => {
        const saved = await referencesRepo.saveReferenceProgress(rt.db, ref.id, {
          manifest: asJson(manifest),
          checkpoint: checkpoint ? asJson(checkpoint) : null,
        });
        if (!saved.stored) lost = true;
        await rt.afterReferenceBatch?.(ref.id);
        return saved.stored && !saved.cancelRequested && !abort.signal.aborted;
      },
    });
    if (lost) {
      log.warn("Figma reference was deleted or taken over while processing; stopped");
      return;
    }

    if (result.status === "unchanged") {
      await referencesRepo.completeReference(rt.db, ref.id, {
        status: "ready",
        outcome: ref.outcome ?? "completed",
        manifest: asJson(result.manifest),
        checkpoint: null,
        meta: {
          ...previousMeta,
          note: `Figma reports version ${result.manifest.version}, unchanged since the last complete read: nothing was fetched again.`,
        },
      });
      log.info({ version: result.manifest.version }, "figma reference unchanged");
      return;
    }

    const m = result.manifest;
    const failedPages = m.pages.filter((p) => p.status === "failed").length;
    const pendingPages = m.pages.filter((p) => p.status === "pending").length;
    if (result.status === "stopped" && result.error.code === "CANCELLED") {
      await referencesRepo.completeReference(rt.db, ref.id, {
        status: "cancelled",
        error: "Cancelled by a user. Fetch again continues where it stopped.",
        manifest: asJson(m),
        checkpoint: asJson(result.checkpoint),
      });
      log.info({ pendingPages }, "figma reference cancelled");
      return;
    }
    const donePages = m.pages.filter((p) => p.status === "done").length;
    if (result.status === "stopped" && donePages === 0) {
      // Nothing read yet: failed, but the checkpoint (page list, version) is kept.
      await referencesRepo.completeReference(rt.db, ref.id, {
        status: "failed",
        error: result.error.message,
        manifest: asJson(m),
        checkpoint: result.checkpoint.pending.length ? asJson(result.checkpoint) : null,
      });
      log.warn({ code: result.error.code }, "figma reference stopped before any page was read");
      return;
    }

    const { spec, report } = finalizeFigma(result.collect, ref.figmaFileKey!);
    const values = countSpecValues(spec);
    const draft = values
      ? await designSpecsRepo.upsertDraftFromExtraction(rt.db, ref.projectId, spec, {
          origin: "figma",
          referenceSourceId: ref.id,
        })
      : null;
    const partial = result.status === "stopped" || failedPages > 0;
    const outcome = partial
      ? "partial"
      : m.warnings.length
        ? "completed_with_warnings"
        : "completed";
    const notes = [
      result.status === "stopped"
        ? `Stopped after ${donePages} of ${m.pagesDiscovered ?? m.pages.length} pages: ${result.error.message} Fetch again continues with the remaining ${pendingPages} page(s).`
        : null,
      failedPages ? `${failedPages} page(s) could not be read (listed below).` : null,
      values
        ? draft
          ? null
          : "No new values compared with the active design reference."
        : "No design values found: the pages read have no local text or color styles, Button components or Container frame.",
    ].filter(Boolean);
    await referencesRepo.completeReference(rt.db, ref.id, {
      status: "ready",
      outcome,
      manifest: asJson(m),
      checkpoint: result.status === "stopped" ? asJson(result.checkpoint) : null,
      meta: {
        ...previousMeta,
        fileName: m.fileName,
        lastModified: m.lastModified,
        version: m.version,
        valuesFound: values,
        extracted: report.extracted.slice(0, MAX_LISTED),
        skipped: report.skipped.slice(0, MAX_LISTED),
        extractedTotal: report.extracted.length,
        skippedTotal: report.skipped.length,
        stats: report.stats,
        draftVersion: draft?.version ?? null,
        note: notes.length ? notes.join(" ") : null,
      },
    });
    log.info(
      {
        values,
        draft: draft?.version ?? null,
        outcome,
        mode: m.mode,
        pages: m.pagesDiscovered,
        failedPages,
        pendingPages,
        tier1Requests: m.requests.tier1,
      },
      "figma reference processed",
    );
  } catch (err) {
    if (lost) return;
    // Fatal for this read (token, access, file, response): the checkpoint is discarded.
    if (err instanceof FigmaError) log.warn({ reason: err.message }, "figma reference failed");
    else log.error(errorFields(err), "figma reference processing failed");
    await referencesRepo.completeReference(rt.db, ref.id, {
      status: "failed",
      error:
        err instanceof FigmaError
          ? err.message
          : "Unexpected error while reading the Figma file. Fetch again to retry.",
      checkpoint: null,
    });
  } finally {
    clearInterval(heartbeat);
  }
}
