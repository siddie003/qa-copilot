import { createHash } from "node:crypto";

/** Characters per token used for chunk sizing (same estimate as AI request sizing). */
export const CHUNK_CHARS_PER_TOKEN = 3;

/** A stored block as the chunker needs it (document order). */
export interface ChunkSourceBlock {
  order: number;
  type: string;
  level: number | null;
  text: string;
  pageHint: string | null;
  location: Record<string, unknown> | null;
}

export interface ContentChunkDraft {
  chunkIndex: number;
  text: string;
  headingText: string | null;
  pageHint: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  blockStart: number;
  blockEnd: number;
  charStart: number;
  charEnd: number;
  tokenEstimate: number;
  contentHash: string;
}

/**
 * Chunk size in tokens: DOCUMENT_CHUNK_TOKENS, but at most a quarter of an AI request's input
 * budget so a request can carry several retrieved sections next to the finding data.
 */
export function chunkTokenBudget(chunkTokens: number, aiMaxInputTokens: number): number {
  return Math.max(100, Math.min(chunkTokens, Math.floor(aiMaxInputTokens / 4)));
}

interface Open {
  blocks: ChunkSourceBlock[];
  chars: number;
  headingText: string | null;
  pageHint: string | null;
  charStart: number;
}

/**
 * Splits a document's blocks into retrieval chunks, streaming: feed blocks in order with
 * `push`, then `finish`. A chunk never mixes page markers (website pages), starts at headings of
 * level 1–3, and holds blocks up to the token budget (a single longer block is its own chunk).
 * Every block ends up in exactly one chunk; offsets refer to the document text = block texts
 * joined by "\n".
 */
export class Chunker {
  private open: Open | null = null;
  private index = 0;
  private offset = 0;
  private readonly maxChars: number;

  constructor(
    tokenBudget: number,
    private readonly emit: (chunk: ContentChunkDraft) => void,
  ) {
    this.maxChars = tokenBudget * CHUNK_CHARS_PER_TOKEN;
  }

  push(b: ChunkSourceBlock) {
    const headingPath = (b.location?.headingPath as string[] | undefined) ?? [];
    const isSectionHeading = b.type === "heading" && (b.level ?? 9) <= 3;
    const o = this.open;
    if (
      o &&
      (o.pageHint !== b.pageHint || isSectionHeading || o.chars + b.text.length + 1 > this.maxChars)
    )
      this.close();
    if (!this.open) {
      const path = b.type === "heading" ? [...headingPath, b.text] : headingPath;
      this.open = {
        blocks: [],
        chars: 0,
        headingText: path.length ? path.join(" › ") : null,
        pageHint: b.pageHint,
        charStart: this.offset,
      };
    }
    this.open.blocks.push(b);
    this.open.chars += b.text.length + (this.open.blocks.length > 1 ? 1 : 0);
    this.offset += b.text.length + 1;
  }

  finish() {
    this.close();
  }

  private close() {
    const o = this.open;
    if (!o || !o.blocks.length) return;
    this.open = null;
    const text = o.blocks.map((b) => b.text).join("\n");
    const pages = o.blocks
      .map((b) => b.location?.page)
      .filter((p): p is number => typeof p === "number");
    this.emit({
      chunkIndex: this.index++,
      text,
      headingText: o.headingText,
      pageHint: o.pageHint,
      pageStart: pages.length ? Math.min(...pages) : null,
      pageEnd: pages.length ? Math.max(...pages) : null,
      blockStart: o.blocks[0]!.order,
      blockEnd: o.blocks[o.blocks.length - 1]!.order,
      charStart: o.charStart,
      charEnd: o.charStart + text.length,
      tokenEstimate: Math.ceil(text.length / CHUNK_CHARS_PER_TOKEN),
      contentHash: createHash("sha256").update(text).digest("hex"),
    });
  }
}

/** Convenience for tests and small inputs. */
export function chunkBlocks(blocks: ChunkSourceBlock[], tokenBudget: number): ContentChunkDraft[] {
  const out: ContentChunkDraft[] = [];
  const c = new Chunker(tokenBudget, (x) => out.push(x));
  for (const b of blocks) c.push(b);
  c.finish();
  return out;
}
