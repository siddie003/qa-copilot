import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { AIProviderError, type AIProvider, type StructuredRequest } from "@qa/ai";
import { createLogger, defaultScanDefaults, designSpecSchema, parseConfig } from "@qa/core";
import {
  closeDb,
  contentRepo,
  designSpecsRepo,
  getDb,
  projectsRepo,
  referencesRepo,
  schema,
  secretsRepo,
} from "@qa/db";
import { encryptSecret } from "@qa/security";
import { createLocalStorage, type Storage } from "@qa/storage";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDocx, buildPdf } from "../../../../fixtures/documents/build.mjs";
import { createTestUser, hasTestDb, resetDatabase } from "../../../../tests/setup/db";
import { processNextReferenceJob, type ReferenceRuntime } from "./process";

const ENCRYPTION_KEY = "cd".repeat(32);
const figmaFile = readFileSync(
  new URL("../../../../fixtures/figma/design-file.json", import.meta.url),
  "utf8",
);

describe.skipIf(!hasTestDb)("reference processing (worker)", () => {
  let storageDir: string;
  let storage: Storage;
  let rt: ReferenceRuntime;
  let ownerId: string;
  let figma: http.Server;
  let figmaUrl: string;
  const figmaRequests: Array<{ url: string; token: string | undefined }> = [];

  beforeAll(async () => {
    await resetDatabase();
    storageDir = await mkdtemp(path.join(os.tmpdir(), "qa-ref-"));
    storage = createLocalStorage(storageDir);
    // Local stand-in for api.figma.com: serves the fixture file for one token only.
    figma = http.createServer((req, res) => {
      figmaRequests.push({ url: req.url ?? "", token: req.headers["x-figma-token"] as string });
      if (req.headers["x-figma-token"] !== "figd_valid") {
        res.writeHead(403, { "content-type": "application/json" });
        return res.end('{"status":403,"err":"Invalid token"}');
      }
      if (req.url === "/v1/files/AbCdEfGh1234") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(figmaFile);
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end('{"status":404,"err":"Not found"}');
    });
    await new Promise<void>((r) => figma.listen(0, "127.0.0.1", () => r()));
    figmaUrl = `http://127.0.0.1:${(figma.address() as { port: number }).port}`;
    rt = {
      db: getDb(),
      storage,
      config: parseConfig({
        DATABASE_URL: process.env.TEST_DATABASE_URL,
        BETTER_AUTH_SECRET: "integration-test-secret-0123456789abcdef",
        ENCRYPTION_KEY,
        MAX_UPLOAD_MB: "5",
      }),
      log: createLogger(),
      figmaBaseUrl: figmaUrl,
    };
    ownerId = (await createTestUser()).id;
  }, 60_000);
  afterAll(async () => {
    await new Promise((r) => figma?.close(r));
    await rm(storageDir, { recursive: true, force: true });
    await closeDb();
  });

  const newProject = async () =>
    projectsRepo.createProject(getDb(), ownerId, {
      name: `Refs ${randomUUID().slice(0, 8)}`,
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

  const drain = async () => {
    let n = 0;
    while (await processNextReferenceJob(rt)) n += 1;
    return n;
  };

  it("parses MD, DOCX, PDF and TXT documents and fails unreadable ones clearly", async () => {
    const project = await newProject();
    const md = await addDocument(
      project.id,
      "approved-content.md",
      readFileSync(new URL("../../../../fixtures/documents/approved-content.md", import.meta.url)),
    );
    const docx = await addDocument(
      project.id,
      "about.docx",
      buildDocx([{ heading: "About us", level: 1 }, { p: "We sell demo products." }]),
    );
    const pdf = await addDocument(
      project.id,
      "about.pdf",
      buildPdf([
        [
          { text: "About us", size: 24 },
          { text: "We sell demo products.", size: 11 },
        ],
      ]),
    );
    const txt = await addDocument(
      project.id,
      "notes.txt",
      Buffer.from("Hello\n\nWorld text here."),
    );
    const fake = await addDocument(project.id, "fake.pdf", Buffer.from("<html>not a pdf</html>"));
    const scanned = await addDocument(project.id, "scanned.pdf", buildPdf([[]]));

    expect(await drain()).toBe(6);
    const docs = new Map(
      (await contentRepo.listDocuments(getDb(), project.id)).map((d) => [d.id, d]),
    );
    expect(docs.get(md.id)).toMatchObject({ parseStatus: "parsed", blockCount: 13 });
    expect(docs.get(docx.id)).toMatchObject({ parseStatus: "parsed", blockCount: 2 });
    expect(docs.get(pdf.id)).toMatchObject({
      parseStatus: "parsed",
      blockCount: 2,
      meta: { pages: 1 },
    });
    expect(docs.get(txt.id)).toMatchObject({ parseStatus: "parsed" });
    expect(docs.get(fake.id)).toMatchObject({
      parseStatus: "failed",
      parseError: expect.stringMatching(/not a PDF/),
      blockCount: 0,
    });
    expect(docs.get(scanned.id)!.parseError).toMatch(/OCR is not available/);

    const blocks = await contentRepo.listBlocks(getDb(), md.id);
    expect(blocks.find((b) => b.type === "cta")).toMatchObject({
      text: "Contact our team",
      href: "/contact",
      pageHint: "/about",
    });
    expect(blocks.filter((b) => b.pageHint === "Careers")).toHaveLength(2);

    // Retry re-queues failed documents only.
    expect(await contentRepo.requeueDocument(getDb(), md.id)).toBeNull();
    expect(await contentRepo.requeueDocument(getDb(), fake.id)).toMatchObject({
      parseStatus: "pending",
    });
    await drain();
  });

  it("reads a Figma file into a draft, confirms it, and reports token problems", async () => {
    const project = await newProject();
    const ref = await referencesRepo.addFigmaReference(getDb(), project.id, {
      figmaUrl: "https://www.figma.com/design/AbCdEfGh1234",
      figmaFileKey: "AbCdEfGh1234",
      figmaNodeIds: [],
    });

    // No token anywhere → unavailable, with guidance (nothing is fabricated).
    await drain();
    let row = await referencesRepo.getReference(getDb(), project.id, ref.id);
    expect(row).toMatchObject({
      status: "unavailable",
      error: expect.stringMatching(/No Figma access token/),
    });
    expect((await designSpecsRepo.getDesignSpecState(getDb(), project.id)).draft).toBeNull();

    // A rejected token → failed with the API's meaning.
    await secretsRepo.setProjectSecret(
      getDb(),
      project.id,
      secretsRepo.FIGMA_TOKEN_KIND,
      encryptSecret(JSON.stringify({ token: "figd_wrong" }), ENCRYPTION_KEY, project.id),
      { configured: true },
    );
    await referencesRepo.requeueReference(getDb(), project.id, ref.id);
    await drain();
    row = await referencesRepo.getReference(getDb(), project.id, ref.id);
    expect(row).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/rejected the access token/),
    });

    // The project token (encrypted) is used and sent only in the X-Figma-Token header.
    await secretsRepo.setProjectSecret(
      getDb(),
      project.id,
      secretsRepo.FIGMA_TOKEN_KIND,
      encryptSecret(JSON.stringify({ token: "figd_valid" }), ENCRYPTION_KEY, project.id),
      { configured: true },
    );
    await referencesRepo.requeueReference(getDb(), project.id, ref.id);
    await drain();
    row = await referencesRepo.getReference(getDb(), project.id, ref.id);
    expect(row).toMatchObject({
      status: "ready",
      error: null,
      meta: { fileName: "Demo Store – Design System", version: "4242", draftVersion: 1 },
    });
    expect(figmaRequests.at(-1)).toEqual({ url: "/v1/files/AbCdEfGh1234", token: "figd_valid" });
    expect(figmaRequests.every((r) => !r.url.includes("figd_"))).toBe(true);

    const state = await designSpecsRepo.getDesignSpecState(getDb(), project.id);
    expect(state.active).toBeNull();
    expect(state.draft).toMatchObject({ version: 1, origin: "figma", confirmedByUser: false });
    const draft = designSpecsRepo.specOf(state.draft!);
    expect(draft.typography.h1).toMatchObject({
      fontSize: 48,
      source: { type: "figma", nodeId: "1:10" },
    });

    // Manual saves are refused while a draft waits for review; confirming activates it.
    await expect(
      designSpecsRepo.saveConfirmedSpec(getDb(), project.id, draft, { userId: ownerId }),
    ).rejects.toBeInstanceOf(designSpecsRepo.DraftPendingError);
    expect(await designSpecsRepo.confirmDraft(getDb(), project.id, 1, ownerId)).toMatchObject({
      version: 1,
      confirmedByUser: true,
    });
    expect(await designSpecsRepo.confirmDraft(getDb(), project.id, 1, ownerId)).toBeNull();

    // Fetching the unchanged file again produces no new draft.
    await referencesRepo.requeueReference(getDb(), project.id, ref.id);
    await drain();
    row = await referencesRepo.getReference(getDb(), project.id, ref.id);
    expect(row!.meta).toMatchObject({
      draftVersion: null,
      note: expect.stringMatching(/No new values/),
    });
  });

  it("extracts guideline drafts without overwriting manually entered values", async () => {
    const project = await newProject();
    // The user entered the link color manually.
    await designSpecsRepo.saveConfirmedSpec(
      getDb(),
      project.id,
      designSpecSchema.parse({ colors: { Link: { value: "#123456", role: "link" } } }),
      { userId: ownerId },
    );
    const bytes = Buffer.from(
      "Brand guide\n\nLink: #1A56DB\n\nPrimary Blue - #1A56DB\n\nH1 — Georgia Bold, 48px / 56px\n",
    );
    const key = `projects/${project.id}/guidelines/${randomUUID()}.txt`;
    await storage.put(key, bytes);
    const ref = await referencesRepo.addGuidelineReference(getDb(), project.id, {
      storageKey: key,
      meta: { filename: "brand.txt", sizeBytes: bytes.length },
    });
    await drain();
    const row = await referencesRepo.getReference(getDb(), project.id, ref.id);
    expect(row).toMatchObject({
      status: "ready",
      meta: { filename: "brand.txt", draftVersion: 2 },
    });
    const state = await designSpecsRepo.getDesignSpecState(getDb(), project.id);
    const draft = designSpecsRepo.specOf(state.draft!);
    expect(draft.colors.Link).toMatchObject({ value: "#123456", source: { type: "manual" } });
    expect(draft.colors["Primary Blue"]).toMatchObject({
      value: "#1a56db",
      source: { type: "document", filename: "brand.txt", line: 5 },
    });
    expect(draft.typography.h1).toMatchObject({ fontFamily: "Georgia", fontSize: 48 });
    expect(await designSpecsRepo.discardDraft(getDb(), project.id)).toBe(true);
    expect((await designSpecsRepo.getDesignSpecState(getDb(), project.id)).active!.version).toBe(1);
  });

  it("adds AI-read guideline values only when the cited line contains them", async () => {
    const project = await newProject();
    const bytes = Buffer.from(
      "Brand guide\n\nPrimary Blue - #1A56DB\n\nOur body copy is set in Inter Regular at 16px.\n\nAccent orange is used sparingly.\n",
    );
    const key = `projects/${project.id}/guidelines/${randomUUID()}.txt`;
    await storage.put(key, bytes);
    const ref = await referencesRepo.addGuidelineReference(getDb(), project.id, {
      storageKey: key,
      meta: { filename: "prose.txt", sizeBytes: bytes.length },
    });
    const none = {
      fontFamily: null,
      fontSize: null,
      fontSizeUnit: null,
      fontWeight: null,
      lineHeight: null,
      lineHeightUnit: null,
      color: null,
    };
    const requests: string[] = [];
    const ai: AIProvider = {
      id: "anthropic",
      model: "claude-test",
      label: "Scripted",
      async generateStructured<T>(req: StructuredRequest<T>) {
        requests.push(req.input);
        const lineOf = (needle: string) =>
          [...req.input.matchAll(/"id":"(L\d+)","text":"([^"]*)"/g)].find((m) =>
            m[2]!.includes(needle),
          )![1]!;
        const data = {
          colors: [
            // Already read literally: the literal value wins.
            { lineId: lineOf("Primary Blue"), name: "Primary Blue", value: "#1a56db", role: null },
          ],
          typography: [
            // Prose the literal extractor cannot read; every value is in the cited line.
            {
              ...none,
              lineId: lineOf("body copy"),
              role: "body",
              fontFamily: "Inter",
              fontSize: 16,
              fontSizeUnit: "px",
              fontWeight: 400,
            },
          ],
          buttons: [
            // Fabricated: the cited line has no button and no color code.
            {
              lineId: lineOf("body copy"),
              variant: "primary",
              background: "#ff7a00",
              color: null,
              borderRadius: null,
            },
          ],
        };
        return {
          data: req.schema.parse(data),
          usage: { inputTokens: 300, outputTokens: 80, cacheReadTokens: 0 },
          model: "claude-test",
          latencyMs: 3,
          stopReason: "end_turn",
          fallbackUsed: false,
        };
      },
    };
    while (await processNextReferenceJob({ ...rt, ai })) {
      // drain with the scripted provider
    }
    expect(requests).toHaveLength(1);
    expect(requests[0]).not.toContain("Accent orange"); // lines without design values are not sent
    const row = await referencesRepo.getReference(getDb(), project.id, ref.id);
    expect(row!.meta).toMatchObject({
      // Two values verified (Primary Blue, body); only body is new, the literal color wins.
      ai: {
        provider: "anthropic",
        model: "claude-test",
        status: "completed",
        accepted: 2,
        rejected: 1,
      },
      extracted: expect.arrayContaining([expect.stringMatching(/^AI-assisted: body, line 5$/)]),
      skipped: expect.arrayContaining([
        "AI value not used: primary button: not named in the cited line",
      ]),
    });
    const draft = designSpecsRepo.specOf(
      (await designSpecsRepo.getDesignSpecState(getDb(), project.id)).draft!,
    );
    expect(draft.typography.body).toMatchObject({
      fontFamily: "Inter",
      fontSize: 16,
      fontWeight: 400,
      source: {
        type: "document",
        line: 5,
        method: "ai",
        excerpt: "Our body copy is set in Inter Regular at 16px.",
      },
    });
    expect(draft.colors["Primary Blue"]!.source.method).toBeUndefined();
    expect(draft.components.buttonPrimary).toBeUndefined();

    // A failing provider never blocks the literal extraction.
    await referencesRepo.requeueReference(getDb(), project.id, ref.id);
    const failing: AIProvider = {
      ...ai,
      async generateStructured() {
        throw new AIProviderError("rate_limit", "The Anthropic API rate limit was exceeded");
      },
    };
    while (await processNextReferenceJob({ ...rt, ai: failing })) {
      // drain
    }
    const again = await referencesRepo.getReference(getDb(), project.id, ref.id);
    expect(again).toMatchObject({
      status: "ready",
      meta: { ai: { status: "failed", error: "The Anthropic API rate limit was exceeded" } },
    });
    expect((again!.meta as { valuesFound: number }).valuesFound).toBeGreaterThan(0);
  });

  it("fails documents and references left processing by a stopped worker", async () => {
    const project = await newProject();
    const doc = await addDocument(project.id, "a.txt", Buffer.from("Hello there."));
    await getDb()
      .update(schema.contentDocument)
      .set({ parseStatus: "parsing", processingStartedAt: sql`now() - interval '10 minutes'` })
      .where(eq(schema.contentDocument.id, doc.id));
    expect(await contentRepo.recoverStaleDocuments(getDb(), 5 * 60_000)).toEqual([doc.id]);
    const [after] = await contentRepo.listDocuments(getDb(), project.id);
    expect(after).toMatchObject({
      parseStatus: "failed",
      parseError: expect.stringMatching(/Retry/),
    });
  });
});
