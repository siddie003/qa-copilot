import {
  coverageGapNote,
  documentState,
  DOCUMENT_STATES,
  formatPageList,
  pagesNotProcessed,
  type DocumentCoverage,
} from "@qa/core/content";
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  CircleDashed,
  Loader2,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";

export interface DocumentStatusInput {
  parseStatus: string;
  stage?: string | null;
  outcome?: string | null;
  coverage?: unknown;
  blockCount: number;
  chunkCount?: number;
  cancelRequestedAt?: string | Date | null;
}

const ICONS: Record<string, { Icon: LucideIcon; cls: string }> = {
  neutral: { Icon: CircleDashed, cls: "text-subtle" },
  info: { Icon: Loader2, cls: "text-info [&_svg]:animate-spin motion-reduce:[&_svg]:animate-none" },
  success: { Icon: CheckCircle2, cls: "text-success" },
  warning: { Icon: AlertTriangle, cls: "text-warning" },
  danger: { Icon: XCircle, cls: "text-danger" },
};

const asCoverage = (v: unknown): DocumentCoverage | null =>
  v && typeof v === "object" && "unit" in v ? (v as DocumentCoverage) : null;

const n = (v: number) => v.toLocaleString("en-US");

/** Pages handled so far by the current run (from the persisted coverage). */
function pagesRead(c: DocumentCoverage) {
  return c.pagesWithText + c.pagesBlank + c.pagesImageOnly + c.pagesFailed;
}

/**
 * The document's persisted state (Upload received, Extracting text, Indexing sections,
 * Completed, Completed with warnings, Partial, Failed, Cancelled) with the real progress counts
 * the worker stored — never an estimated percentage. An icon accompanies every state.
 */
export function DocumentStatus({ doc }: { doc: DocumentStatusInput }) {
  const state = documentState(doc);
  const meta = DOCUMENT_STATES[state];
  const { Icon, cls } =
    state === "cancelled" ? { Icon: Ban, cls: "text-muted" } : ICONS[meta.tone]!;
  const c = asCoverage(doc.coverage);
  let progress: string | null = null;
  if (state === "extracting" && c)
    progress =
      c.unit === "page" && c.pagesDetected
        ? `${n(pagesRead(c))} of ${n(c.pagesDetected)} pages read · ${n(c.blocks)} blocks`
        : `${n(c.blocks)} blocks read`;
  if (state === "indexing") progress = `${n(doc.blockCount)} blocks`;
  return (
    <span className="inline-flex flex-col gap-0.5">
      <span className={cn("inline-flex items-center gap-1.5 text-sm font-medium", cls)}>
        <Icon aria-hidden className="size-4" />
        {meta.label}
      </span>
      {progress && <span className="text-xs text-muted">{progress}</span>}
      {doc.cancelRequestedAt && doc.parseStatus === "parsing" && (
        <span className="text-xs text-muted">Cancelling…</span>
      )}
    </span>
  );
}

/**
 * What processing read: pages detected / with text / image-only (no OCR) / blank / failed /
 * not reached, blocks and indexed sections. Shows nothing for documents processed before
 * coverage was recorded, except a note.
 */
export function CoverageSummary({ doc }: { doc: DocumentStatusInput }) {
  const c = asCoverage(doc.coverage);
  if (!c) {
    return doc.parseStatus === "parsed" ? (
      <span className="block text-xs text-subtle">
        {n(doc.blockCount)} blocks
        {doc.chunkCount ? ` · ${n(doc.chunkCount)} indexed sections` : " · indexing pending"} ·
        page-level coverage was not recorded (processed by an earlier version)
      </span>
    ) : null;
  }
  const parts: string[] = [];
  if (c.unit === "page" && c.pagesDetected !== null) {
    parts.push(`${n(c.pagesDetected)} page${c.pagesDetected === 1 ? "" : "s"} detected`);
    parts.push(`${n(c.pagesWithText)} with text`);
    if (c.pagesBlank) parts.push(`${n(c.pagesBlank)} blank`);
  }
  if (doc.parseStatus !== "failed") {
    parts.push(`${n(c.blocks)} blocks`);
    if (doc.parseStatus === "parsed")
      parts.push(`${n(doc.chunkCount ?? c.chunks)} indexed sections`);
  }
  const notRead = pagesNotProcessed(c);
  const gap = coverageGapNote(c);
  return (
    <span className="block space-y-0.5 text-xs">
      <span className="block text-subtle">{parts.join(" · ")}</span>
      {c.pagesImageOnly > 0 && (
        <span className="block text-warning">
          {n(c.pagesImageOnly)} image-only page{c.pagesImageOnly === 1 ? "" : "s"} (
          {formatPageList(c.imageOnlyPages)}): no text layer, and OCR is not available, so they were
          not read.
        </span>
      )}
      {c.pagesFailed > 0 && (
        <span className="block text-warning">
          {n(c.pagesFailed)} page{c.pagesFailed === 1 ? "" : "s"} could not be read:{" "}
          {c.failedPages
            .slice(0, 3)
            .map((p) => `page ${p.page} (${p.error})`)
            .join("; ")}
          {c.pagesFailed > 3 ? "; …" : ""}
        </span>
      )}
      {notRead > 0 && (
        <span className="block text-warning">
          {n(notRead)} page{notRead === 1 ? "" : "s"} not read yet (from page {c.notProcessedFrom}):{" "}
          {c.stoppedReason ?? "processing stopped"}
        </span>
      )}
      {c.blockLimitReached && (
        <span className="block text-warning">
          The block limit was reached; the rest of the document was not read.
        </span>
      )}
      {c.blocksShortened > 0 && (
        <span className="block text-subtle">
          {n(c.blocksShortened)} very long block{c.blocksShortened === 1 ? " was" : "s were"}{" "}
          shortened to 5,000 characters.
        </span>
      )}
      {!gap && c.stoppedReason && <span className="block text-warning">{c.stoppedReason}</span>}
    </span>
  );
}
