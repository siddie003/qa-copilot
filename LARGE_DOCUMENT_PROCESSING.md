# Large Document Processing

How QA Copilot reads approved-content documents (PDF, DOCX, Markdown, TXT) of any size, keeps
track of exactly what it read, indexes it for retrieval, and uses it in scans — without ever
sending a whole document to an AI provider. Implemented in Phase 13 (2026-10-09).

## 1. Pipeline

```
Upload (web)                 Worker: reference loop (one document at a time)
───────────                  ───────────────────────────────────────────────
validate name/type/bytes     claim (SKIP LOCKED, attempts+1, stage = extracting)
store file (random key)  ──► re-validate the stored file (type, encoding, DOCX zip-bomb sizes)
row: pending                 identical upload in this project already read? → copy its results
                             extract in an isolated thread, streaming batches:
                               PDF: page by page (pages 1–30, then 25 per batch)
                               others: whole document, delivered in slices of 1,000 blocks
                             each batch → one transaction: blocks + coverage + checkpoint
                             stage = indexing → chunks (sections) + full-text index
                             parsed with outcome, or failed / cancelled
```

Code: `packages/reference/src/extract/` (`pdf.ts`, `isolated.ts`, `thread-entry.mjs`),
`packages/reference/src/chunk.ts`, `apps/worker/src/references/documents.ts`,
`packages/db/src/repositories/content.ts`, `packages/core/src/content.ts` (coverage, states,
search terms). Schema: migration `0007_large_documents` (columns on `content_document`, table
`content_chunk`, status `cancelled`).

## 2. States users see

All states come from persisted columns (`parse_status`, `stage`, `outcome`, `coverage`); the UI
never estimates progress.

| State | Meaning |
|---|---|
| Upload received | Queued (`pending`) |
| Extracting text | Being read; shows "N of M pages read · K blocks" from the stored coverage |
| Indexing sections | Text read; building retrieval sections |
| Completed | Every page/part read |
| Completed with warnings | Everything read, something adjusted (very long blocks shortened, Word converter messages) |
| Partial | Some content could not be read: image-only pages (no OCR), failed pages, pages not reached (time/memory limit), block limit |
| Failed | Nothing usable (e.g. password-protected, corrupt, all pages image-only); coverage is kept so the reason is visible |
| Cancelled | Stopped by a user; what was read is kept and **Continue reading** resumes |

Actions on the References page: **Cancel** (queued: at once; processing: within one batch),
**Continue reading** (cancelled, or partial with pages not reached), **Retry** (failed: starts
over), **View text**, **Delete**. A search box searches all indexed sections of the project.

## 3. Coverage (what was read)

Persisted on `content_document.coverage` after every batch:

- `pagesDetected`, `pagesWithText`, `pagesBlank`, `pagesImageOnly` (+ page list),
  `pagesFailed` (+ first 100 with their error), `notProcessedFrom` (first page not read)
- `blocks`, `blocksShortened`, `blockLimitReached`, `chunks` (indexed sections)
- `timeLimitReached`, `stoppedReason`, `warnings`

**PDF pages:** each page is reported. A page whose text cannot be read is `failed` with its error
and the other pages continue. A page without text is checked for painted images: with images it is
`image_only` (probably scanned — **OCR is not available**, so it is reported as not read), without
anything it is `blank` (listed, not a warning). Nothing is skipped silently.

**Other formats** have no pages (`unit: "document"`). DOCX has no page numbers in its content;
Markdown and TXT blocks keep their line numbers.

## 4. Limits and configuration

| Variable | Default | Effect |
|---|---|---|
| `MAX_UPLOAD_MB` | 20 (max 200) | Upload size |
| `DOCUMENT_EXTRACTION_TIMEOUT_MS` | 300000 | One processing run. A PDF stopped by it keeps the pages read (partial) and can continue |
| `DOCUMENT_PARSER_MEMORY_MB` | 512 | Heap of the parsing thread. Exceeding it stops the run (PDF: pages read so far kept) |
| `DOCUMENT_MAX_BLOCKS` | 50000 (was a fixed 5000) | Blocks stored per document; beyond it the document is partial and says so |
| `DOCUMENT_CHUNK_TOKENS` | 600 | Section size, capped at a quarter of `AI_MAX_INPUT_TOKENS` |

Fixed limits: 5,000 characters per block (longer blocks are shortened and counted), first 30 PDF
pages to determine the body font size, 25 pages per later batch, 5 s heartbeat, a run idle for
5 minutes is recovered, 3 attempts before a document fails, 20 search results, 2 sections of at
most 800 characters per content issue sent to AI.

## 5. Checkpoints, resume, cancellation, retries

- Each batch is stored atomically with its coverage and **checkpoint** (PDF: next page, body font
  size, heading sizes, heading path, next block index). A run that is interrupted (worker crash,
  restart, time limit, memory limit, cancellation) loses at most the batch in flight.
- **Worker crash:** stale recovery re-queues the document (attempts < 3); the next run keeps the
  stored blocks (same rows) and continues at the checkpoint. After 3 interrupted attempts it fails
  with a retry hint.
- **Cancellation:** requested on the row; the run notices after the current batch (or within 5 s
  via the heartbeat), stops the thread, and does not store batches still queued. A run that was
  cancelled is never reported as complete.
- **Lost run:** if the document was deleted or recovered by another worker meanwhile, the run
  stops writing.
- Only PDFs resume; DOCX/MD/TXT are fast and start over. Resume requires the same
  `EXTRACTOR_VERSION`.
- A resumed PDF produces exactly the blocks of an uninterrupted run (tested).

## 6. Duplicate uploads

A document whose bytes (SHA-256) equal a completely read document **of the same project** with the
same extractor version is not parsed again: blocks, sections and coverage are copied and the
document shows "Identical to … : its results were reused". Never across projects.

## 7. Indexing and retrieval

- **Sections (chunks):** consecutive blocks of one section — a new section starts at headings of
  level 1–3 and at page markers (`Page:` / `URL:`), and a section holds blocks up to the token
  budget (3 characters per token estimate; one longer block is its own section). Every block is in
  exactly one section. Each section stores document, project, index, heading path, page range,
  page marker, block range, character offsets, token estimate and SHA-256.
- **Index:** PostgreSQL full-text search (`to_tsvector('simple', …)`, generated column + GIN index).
  The `simple` configuration has no stemming and no stop words, so it works for any language.
  **No vector database and no embeddings** (no paid API, no extra service). Trade-off: matching is
  by words, not meaning.
- **Search** (`GET /api/v1/projects/:id/content-search?q=&document=`, References page): sections
  containing all the words first; if there are none, sections with any of them (PostgreSQL ranks
  by frequency, not rarity, so "any word" alone favours common words). Owner-checked and limited to
  the project.
- **AI explanations of content issues:** the section that contains each finding's approved block
  is looked up exactly (document id + block position stored in the finding's evidence) — at most
  2 sections, at most 800 characters each, credential-shaped strings removed. The AI may quote
  these sections (they are part of the grounding corpus); anything else it writes is still checked
  against the evidence. The document itself is never sent.

## 8. Scans and comparisons

- Content comparison stays deterministic (text similarity and word diff); it never depends on AI.
- A scan freezes each parsed document's block count, outcome and a coverage note. It compares only
  the blocks that existed at scan start (a document continued later does not change a running
  scan), and for partial documents it adds an inconclusive check, e.g. "Document handbook.pdf:
  Only partly read: 3 image-only page(s) (40–42) could not be read without OCR. That content was
  not compared." Content that could not be read is never reported as missing from the website.
- The scan's content snapshot hash includes the block count of partial documents, so scan
  comparisons see when a partial document was continued.

## 9. Security

Unchanged guarantees: uploads need an authenticated owner; extension + declared MIME + magic bytes
+ encoding are validated on upload and again in the worker; DOCX entries are inflated and measured
before parsing; parsing runs in a worker thread with heap and time limits; random storage keys;
uploaded content is never executed. New: UTF-16 text is accepted only with a byte-order mark and
must decode; search and section lookups are project-scoped (tested across projects); duplicate
reuse never crosses projects; document text is not logged (logs carry ids and counts only).

## 10. Measured performance (2026-10-09, this machine, test database)

Synthetic text-only PDFs generated by `fixtures/documents/build.mjs` (Helvetica, 6 paragraphs per
page), processed end to end by the worker (validation, isolated extraction, storage, indexing):

| Pages | File | Blocks | Sections | Time | Per page | Process memory (baseline → peak) |
|---|---|---|---|---|---|---|
| 1,000 | 0.99 MB | 6,100 | 400 | 1.69 s | 1.7 ms | 169 → 300 MB |
| 3,000 | 2.99 MB | 18,300 | 1,200 | 4.08 s | 1.4 ms | 192 → 350 MB |

Full-text search over these sections took 3–9 ms. Real PDFs with embedded fonts, images and complex
layouts are slower; these numbers are not a benchmark of real documents.

## 11. Tests

All local (no external service): `packages/reference/src/large-documents.test.ts` (page batches,
resume equivalence, failing page isolation, block cap, image-only/encrypted/corrupt PDFs, streaming,
cancellation, encodings, chunking), `packages/core/src/coverage.test.ts`,
`packages/security/src/upload.test.ts` (UTF-16), `packages/ai/src/approved-sections.test.ts`,
`packages/scanners/src/comparison.test.ts` (partial documents), `apps/web/src/components/references/document-status.test.ts`
(rendered states), and on the real test database `apps/worker/src/references/documents.int.test.ts`
(120-page PDF with image-only and blank pages, cancel/continue, crash/resume, duplicate reuse,
project isolation, block cap, all-image PDF, indexing of older documents),
`apps/web/src/server/references-api.int.test.ts` (search, cancel, continue, ownership) and
`apps/worker/src/pipeline/issues.int.test.ts` (approved sections in AI requests).

## 12. Limitations

- **No OCR.** Image-only pages are detected and reported, not read.
- Tables in PDFs are read as lines of text, not as tables. DOCX has no page numbers.
- The PDF body font size is fixed from the first 30 pages; a heading size first seen later gets the
  next level by size rank, so heading levels of very long documents can differ slightly from a
  whole-document analysis.
- DOCX/Markdown/TXT are read in one piece (not resumable); very large Word files are bounded by the
  parser memory and time limits.
- Full-text search matches words, not meaning (no stemming, no embeddings).
- Pages are processed one document at a time per worker process.
- The References page and wizard changes were checked by typecheck and server-rendered component
  tests; they were not viewed in a browser in this phase (the only running app used the
  development database with real data).
