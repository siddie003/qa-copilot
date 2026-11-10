import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createLogger,
  defaultScanDefaults,
  parseConfig,
  searchTerms,
  type DocumentCoverage,
} from "@qa/core";
import { closeDb, contentRepo, getDb, projectsRepo, schema } from "@qa/db";
import { extractContentBlocks } from "@qa/reference";
import { createLocalStorage, type Storage } from "@qa/storage";
import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPdf, type PdfLine } from "../../../../fixtures/documents/build.mjs";
import { createTestUser, hasTestDb, resetDatabase } from "../../../../tests/setup/db";
import { processNextReferenceJob, type ReferenceRuntime } from "./process";

/** Page n: a chapter heading every 10 pages and two paragraphs with a unique word. */
const textPage = (n: number): PdfLine[] => [
  ...(n % 10 === 1 ? [{ text: `Chapter ${Math.ceil(n / 10)}`, size: 24 }] : []),
  { text: `Page ${n} explains the topic${n} offer in detail.`, size: 11, gap: 12 },
  { text: `Page ${n} second paragraph with supporting words.`, size: 11, gap: 12 },
];

describe.skipIf(!hasTestDb)("large content documents (worker, real PostgreSQL)", () => {
  let storageDir: string;
  let storage: Storage;
  let rt: ReferenceRuntime;
  let ownerId: string;

  beforeAll(async () => {
    await resetDatabase();
    storageDir = await mkdtemp(path.join(os.tmpdir(), "qa-docs-"));
    storage = createLocalStorage(storageDir);
    rt = {
      db: getDb(),
      storage,
      config: parseConfig({
        DATABASE_URL: process.env.TEST_DATABASE_URL,
        BETTER_AUTH_SECRET: "integration-test-secret-0123456789abcdef",
        MAX_UPLOAD_MB: "20",
        DOCUMENT_CHUNK_TOKENS: "200",
      }),
      log: createLogger(),
    };
    ownerId = (await createTestUser()).id;
  }, 60_000);
  afterAll(async () => {
    await rm(storageDir, { recursive: true, force: true });
    await closeDb();
  });

  const newProject = () =>
    projectsRepo.createProject(getDb(), ownerId, {
      name: `Docs ${randomUUID().slice(0, 8)}`,
      websiteUrl: "https://example.com/",
      scanDefaults: defaultScanDefaults(),
    });

  async function addDocument(projectId: string, filename: string, bytes: Buffer) {
    const key = `projects/${projectId}/documents/${randomUUID()}.bin`;
    await storage.put(key, bytes);
    return contentRepo.insertDocument(getDb(), projectId, {
      filename,
      mimeType: "application/octet-stream",
      sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      storageKey: key,
      targetPath: null,
    });
  }

  const drain = async (runtime = rt) => {
    let n = 0;
    while (await processNextReferenceJob(runtime)) n += 1;
    return n;
  };
  const getDoc = async (id: string) =>
    (
      await getDb().select().from(schema.contentDocument).where(eq(schema.contentDocument.id, id))
    )[0]!;
  const blocksOf = (id: string) =>
    getDb()
      .select()
      .from(schema.contentBlock)
      .where(eq(schema.contentBlock.documentId, id))
      .orderBy(asc(schema.contentBlock.order));
  const chunksOf = (id: string) =>
    getDb()
      .select({
        chunkIndex: schema.contentChunk.chunkIndex,
        blockStart: schema.contentChunk.blockStart,
        blockEnd: schema.contentChunk.blockEnd,
        pageStart: schema.contentChunk.pageStart,
        pageEnd: schema.contentChunk.pageEnd,
        headingText: schema.contentChunk.headingText,
        projectId: schema.contentChunk.projectId,
      })
      .from(schema.contentChunk)
      .where(eq(schema.contentChunk.documentId, id))
      .orderBy(asc(schema.contentChunk.chunkIndex));

  it("reads a multi-page PDF page by page with honest coverage, then indexes and retrieves it", async () => {
    const project = await newProject();
    // 120 pages: pages 40–42 image-only (scanned), page 80 blank.
    const pdf = buildPdf(
      Array.from({ length: 120 }, (_, i) => {
        const n = i + 1;
        if (n >= 40 && n <= 42) return { image: true as const };
        return n === 80 ? [] : textPage(n);
      }),
    );
    const doc = await addDocument(project.id, "handbook.pdf", pdf);
    expect(await drain()).toBe(1);

    const row = await getDoc(doc.id);
    const cov = row.coverage as unknown as DocumentCoverage;
    expect(row).toMatchObject({
      parseStatus: "parsed",
      outcome: "partial", // three pages could not be read without OCR
      stage: null,
      checkpoint: null, // every page was reached: nothing to continue
      attempts: 1,
      extractorVersion: "2",
    });
    expect(cov).toMatchObject({
      unit: "page",
      pagesDetected: 120,
      pagesWithText: 116,
      pagesImageOnly: 3,
      imageOnlyPages: [40, 41, 42],
      pagesBlank: 1,
      blankPages: [80],
      pagesFailed: 0,
      notProcessedFrom: null,
      blockLimitReached: false,
    });
    expect(cov.warnings.join(" ")).toMatch(/3 of 120 page\(s\) contain only images.*40–42/);

    // Blocks: one run, gap-free order, locations with pages and heading paths.
    const blocks = await blocksOf(doc.id);
    expect(row.blockCount).toBe(blocks.length);
    expect(cov.blocks).toBe(blocks.length);
    expect(blocks.map((b) => b.order)).toEqual(blocks.map((_, i) => i));
    expect(blocks.find((b) => b.text.includes("topic115"))?.location).toMatchObject({
      page: 115,
      headingPath: ["Chapter 12"],
    });

    // Chunks cover every block exactly once, within one chapter, with page ranges.
    const chunks = await chunksOf(doc.id);
    expect(row.chunkCount).toBe(chunks.length);
    expect(cov.chunks).toBe(chunks.length);
    expect(chunks.length).toBeGreaterThan(12);
    let next = 0;
    for (const c of chunks) {
      expect(c.blockStart).toBe(next);
      next = c.blockEnd + 1;
      expect(c.projectId).toBe(project.id);
      expect(c.pageStart).not.toBeNull();
    }
    expect(next).toBe(blocks.length);

    // Retrieval: a word from page 115 finds that section, nothing else is needed.
    const hits = await contentRepo.searchChunks(getDb(), {
      projectId: project.id,
      terms: searchTerms("what is the topic115 offer")!,
      limit: 3,
    });
    expect(hits[0]).toMatchObject({ filename: "handbook.pdf", headingText: "Chapter 12" });
    expect(hits[0]!.pageStart).toBeLessThanOrEqual(115);
    expect(hits[0]!.pageEnd).toBeGreaterThanOrEqual(115);
    expect(hits[0]!.text).toContain("topic115");

    // Exact retrieval of a block's section (used for content issue explanations).
    const block = blocks.find((b) => b.text.includes("topic77"))!;
    const [section] = await contentRepo.chunksForBlocks(getDb(), doc.id, [block.order]);
    expect(section!.text).toContain("topic77");
    expect(section!.blockStart).toBeLessThanOrEqual(block.order);
  });

  it("cancels between batches, keeps what was read, and continues exactly where it stopped", async () => {
    const project = await newProject();
    const pdf = buildPdf(Array.from({ length: 90 }, (_, i) => textPage(i + 1)));
    const doc = await addDocument(project.id, "long.pdf", pdf);
    // Request cancellation right after the first stored batch (pages 1–30).
    let requested = false;
    await drain({
      ...rt,
      afterDocumentBatch: async (id) => {
        if (requested) return;
        requested = true;
        await contentRepo.cancelDocument(getDb(), id);
      },
    });
    const cancelled = await getDoc(doc.id);
    const covBefore = cancelled.coverage as unknown as DocumentCoverage;
    expect(cancelled).toMatchObject({
      parseStatus: "cancelled",
      parseError: expect.stringMatching(/Retry continues/),
      cancelRequestedAt: null,
    });
    // The batch during which cancellation was noticed (pages 31–55) is stored; nothing after.
    expect(covBefore.pagesWithText).toBe(55);
    expect((cancelled.checkpoint as { pdf: { nextPage: number } }).pdf.nextPage).toBe(56);
    const before = await blocksOf(doc.id);
    expect(Math.max(...before.map((b) => (b.location as { page: number }).page))).toBe(55);

    // A cancelled document is never frozen into a scan.
    expect(await contentRepo.listParsedDocuments(getDb(), project.id)).toHaveLength(0);

    // Continue: resumes at page 56 (earlier blocks are the same rows), then completes.
    expect(await contentRepo.requeueDocument(getDb(), doc.id)).toMatchObject({
      parseStatus: "pending",
      resumable: true,
    });
    await drain();
    const done = await getDoc(doc.id);
    expect(done).toMatchObject({ parseStatus: "parsed", outcome: "completed", checkpoint: null });
    expect((done.coverage as unknown as DocumentCoverage).pagesWithText).toBe(90);
    const after = await blocksOf(doc.id);
    expect(after.slice(0, before.length).map((b) => b.id)).toEqual(before.map((b) => b.id));
    // Identical to reading the whole file in one go.
    const direct = await extractContentBlocks("pdf", pdf);
    expect(after.map((b) => [b.order, b.type, b.level, b.text])).toEqual(
      direct.blocks.map((b) => [b.location.index, b.type, b.level, b.text]),
    );
  });

  it("resumes after a worker crash from the last stored batch", async () => {
    const project = await newProject();
    const pdf = buildPdf(Array.from({ length: 60 }, (_, i) => textPage(i + 1)));
    const doc = await addDocument(project.id, "crash.pdf", pdf);
    // Simulate a crash after the first batch: the run stops writing and the row stays "parsing".
    let crashed = false;
    // One job only (a drain would claim the re-queued document again right away).
    await processNextReferenceJob({
      ...rt,
      afterDocumentBatch: async () => {
        if (crashed) return;
        crashed = true;
        await getDb()
          .update(schema.contentDocument)
          .set({ processingStartedAt: sql`now() - interval '10 minutes'` })
          .where(eq(schema.contentDocument.id, doc.id));
        // The worker process "dies": another worker's stale recovery takes over the row.
        await contentRepo.recoverStaleDocuments(getDb(), 5 * 60_000);
      },
    });
    // The interrupted run noticed it lost the document and wrote nothing more.
    const requeued = await getDoc(doc.id);
    expect(requeued.parseStatus).toBe("pending");
    expect((requeued.checkpoint as { pdf: { nextPage: number } }).pdf.nextPage).toBe(31);
    const firstIds = (await blocksOf(doc.id)).map((b) => b.id);
    await drain();
    const done = await getDoc(doc.id);
    expect(done).toMatchObject({ parseStatus: "parsed", outcome: "completed", attempts: 2 });
    const all = await blocksOf(doc.id);
    expect(all.slice(0, firstIds.length).map((b) => b.id)).toEqual(firstIds);
    expect(all.map((b) => b.order)).toEqual(all.map((_, i) => i));
  });

  it("reuses an identical upload of the same project, never across projects", async () => {
    const a = await newProject();
    const b = await newProject();
    const bytes = Buffer.from(
      Array.from({ length: 40 }, (_, i) => `## Section ${i}\n\nApproved text number ${i}.`).join(
        "\n\n",
      ),
    );
    const first = await addDocument(a.id, "copy.md", bytes);
    await drain();
    const second = await addDocument(a.id, "copy-again.md", bytes);
    const other = await addDocument(b.id, "copy.md", bytes);
    await drain();
    const [r1, r2, r3] = [await getDoc(first.id), await getDoc(second.id), await getDoc(other.id)];
    expect(r2).toMatchObject({
      parseStatus: "parsed",
      blockCount: r1.blockCount,
      chunkCount: r1.chunkCount,
      outcome: r1.outcome,
      meta: expect.objectContaining({ reusedFrom: { documentId: first.id, filename: "copy.md" } }),
    });
    expect((await blocksOf(second.id)).map((x) => x.text)).toEqual(
      (await blocksOf(first.id)).map((x) => x.text),
    );
    expect(r3.meta).not.toHaveProperty("reusedFrom");
    expect(r3.blockCount).toBe(r1.blockCount);
    // Search stays inside the project.
    const terms = searchTerms("Approved text number 7")!;
    const inA = await contentRepo.searchChunks(getDb(), { projectId: a.id, terms });
    const inB = await contentRepo.searchChunks(getDb(), { projectId: b.id, terms });
    expect(inA.every((h) => [first.id, second.id].includes(h.documentId))).toBe(true);
    expect(inB.every((h) => h.documentId === other.id)).toBe(true);
    expect(inB.length).toBeGreaterThan(0);
  });

  it("reports a block cap as partial (not resumable) and an all-image PDF as failed with its pages", async () => {
    const project = await newProject();
    const capped = await addDocument(
      project.id,
      "many.md",
      Buffer.from(Array.from({ length: 300 }, (_, i) => `Line ${i}.`).join("\n\n")),
    );
    const scanned = await addDocument(
      project.id,
      "scan.pdf",
      buildPdf([{ image: true }, { image: true }, { image: true }]),
    );
    await drain({ ...rt, config: { ...rt.config, DOCUMENT_MAX_BLOCKS: 100 } });
    const c = await getDoc(capped.id);
    expect(c).toMatchObject({
      parseStatus: "parsed",
      outcome: "partial",
      blockCount: 100,
      checkpoint: null,
    });
    expect(c.coverage).toMatchObject({ unit: "document", blockLimitReached: true, blocks: 100 });
    const s = await getDoc(scanned.id);
    expect(s).toMatchObject({
      parseStatus: "failed",
      parseError: expect.stringMatching(
        /3 of 3 page\(s\) contain only images.*OCR is not available/,
      ),
      blockCount: 0,
      chunkCount: 0,
    });
    expect(s.coverage).toMatchObject({
      pagesDetected: 3,
      pagesImageOnly: 3,
      imageOnlyPages: [1, 2, 3],
    });
    expect(await blocksOf(scanned.id)).toHaveLength(0);
  });

  it("cancels a queued document at once and indexes documents parsed before chunking existed", async () => {
    const project = await newProject();
    const queued = await addDocument(project.id, "later.txt", Buffer.from("Some text here."));
    expect(await contentRepo.cancelDocument(getDb(), queued.id)).toMatchObject({
      parseStatus: "cancelled",
    });
    expect(await contentRepo.cancelDocument(getDb(), queued.id)).toBeNull();

    // An "old" parsed document: blocks but no chunks and no coverage.
    const old = await addDocument(project.id, "old.txt", Buffer.from("x"));
    await getDb()
      .update(schema.contentDocument)
      .set({ parseStatus: "parsed", outcome: "completed", blockCount: 3 })
      .where(eq(schema.contentDocument.id, old.id));
    await getDb()
      .insert(schema.contentBlock)
      .values(
        ["Old heading", "Old paragraph one.", "Old paragraph two."].map((text, order) => ({
          documentId: old.id,
          order,
          type: order === 0 ? ("heading" as const) : ("paragraph" as const),
          level: order === 0 ? 1 : null,
          text,
          normalizedText: text.toLowerCase(),
          location: { index: order, line: order + 1 },
        })),
      );
    await drain();
    expect(await getDoc(old.id)).toMatchObject({ stage: null, chunkCount: 1, coverage: null });
    expect(await getDoc(queued.id)).toMatchObject({ parseStatus: "cancelled" });
    const [chunk] = await chunksOf(old.id);
    expect(chunk).toMatchObject({ blockStart: 0, blockEnd: 2, headingText: "Old heading" });
  });
});
