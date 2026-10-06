import { describe, expect, it } from "vitest";
import { buildDocx, buildPdf, buildZip } from "../../../fixtures/documents/build.mjs";
import {
  readZipDirectory,
  sanitizeFilename,
  validateDocumentUpload,
  verifyDocumentContent,
  type DocumentKind,
} from "./upload";

const limits = { maxBytes: 5 * 1024 * 1024 };
const check = (filename: string, bytes: Buffer, declaredType?: string) =>
  validateDocumentUpload({ filename, bytes, declaredType, limits });

describe("document upload validation", () => {
  it("accepts real PDF, DOCX, TXT and Markdown files", () => {
    expect(check("a.pdf", buildPdf([[{ text: "Hi", size: 12 }]]), "application/pdf")).toMatchObject(
      {
        ok: true,
        kind: "pdf",
      },
    );
    expect(check("a.docx", buildDocx([{ p: "Hi" }]), "")).toMatchObject({ ok: true, kind: "docx" });
    expect(check("notes.txt", Buffer.from("Hello wörld"), "text/plain")).toMatchObject({
      ok: true,
      kind: "txt",
    });
    expect(check("README.MD", Buffer.from("# Hi"), "application/octet-stream")).toMatchObject({
      ok: true,
      kind: "md",
    });
  });

  it("rejects wrong extensions, empty and oversized files", () => {
    expect(check("a.exe", Buffer.from("MZ"))).toMatchObject({
      ok: false,
      code: "UNSUPPORTED_TYPE",
    });
    expect(check("a.html", Buffer.from("<p>"))).toMatchObject({
      ok: false,
      code: "UNSUPPORTED_TYPE",
    });
    expect(check(".pdf", Buffer.from("%PDF-"))).toMatchObject({
      ok: false,
      code: "UNSUPPORTED_TYPE",
    });
    expect(check("a.txt", Buffer.alloc(0))).toMatchObject({ ok: false, code: "EMPTY" });
    expect(check("a.txt", Buffer.alloc(limits.maxBytes + 1, 65))).toMatchObject({
      ok: false,
      code: "TOO_LARGE",
    });
  });

  it("rejects content that does not match the extension or declared type", () => {
    expect(check("a.pdf", Buffer.from("<html>not a pdf</html>"))).toMatchObject({
      ok: false,
      code: "TYPE_MISMATCH",
    });
    expect(check("a.docx", Buffer.from("%PDF-1.4"))).toMatchObject({
      ok: false,
      code: "TYPE_MISMATCH",
    });
    expect(check("a.pdf", buildPdf([[{ text: "x", size: 12 }]]), "text/html")).toMatchObject({
      ok: false,
      code: "TYPE_MISMATCH",
    });
    // A ZIP archive that is not a Word document.
    expect(check("a.docx", buildZip({ "hello.txt": "hi" }))).toMatchObject({
      ok: false,
      code: "TYPE_MISMATCH",
    });
  });

  it("rejects binary or non-UTF-8 text files", () => {
    expect(check("a.txt", Buffer.from([0x48, 0x00, 0x69]))).toMatchObject({
      ok: false,
      code: "ENCODING",
    });
    expect(check("a.md", Buffer.from([0xc3, 0x28]))).toMatchObject({ ok: false, code: "ENCODING" });
  });

  it("guards against zip bombs before any parser runs", () => {
    const bomb = buildZip({
      "[Content_Types].xml": "<Types/>",
      "word/document.xml": Buffer.alloc(30 * 1024 * 1024, 0x20),
    });
    expect(bomb.length).toBeLessThan(200 * 1024);
    expect(check("bomb.docx", bomb)).toMatchObject({ ok: false, code: "ARCHIVE_LIMIT" });
    const tooBig = validateDocumentUpload({
      filename: "big.docx",
      bytes: buildDocx([{ p: "x".repeat(5000) }]),
      limits: { ...limits, maxUncompressedBytes: 1000 },
    });
    expect(tooBig).toMatchObject({ ok: false, code: "ARCHIVE_LIMIT" });
    expect(
      check("broken.docx", Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), Buffer.alloc(40)])),
    ).toMatchObject({
      ok: false,
      code: "CORRUPT",
    });
  });

  it("reads ZIP central directories and sanitizes file names", () => {
    const entries = readZipDirectory(buildZip({ "a.txt": "abc", "dir/b.txt": "hello" }));
    expect(entries.map((e) => [e.name, e.uncompressedSize])).toEqual([
      ["a.txt", 3],
      ["dir/b.txt", 5],
    ]);
    expect(sanitizeFilename("C:\\Users\\x\\..\\report.pdf")).toBe("report.pdf");
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("bad\u0000name.txt")).toBe("badname.txt");
  });
});

// Phase 10: archives that lie about their content, and upload fuzzing.
describe("DOCX content verification (decompression bombs with forged sizes)", () => {
  const docxWith = (documentXml: Buffer, declared?: number) =>
    buildZip(
      { "[Content_Types].xml": "<Types/>", "word/document.xml": documentXml },
      declared === undefined ? {} : { declaredSizes: { "word/document.xml": declared } },
    );

  it("accepts real Word documents", async () => {
    const docx = buildDocx([{ heading: "Title", level: 1 }, { p: "Body text" }]);
    expect(check("a.docx", docx)).toMatchObject({ ok: true });
    expect(await verifyDocumentContent({ kind: "docx", bytes: docx })).toBeNull();
  });

  it("rejects an entry that expands far beyond its declared size, without inflating it all", async () => {
    // 64 MB of spaces deflate to ~64 KB; the headers claim 1 KB, so the static ratio and total
    // checks pass and only real decompression reveals the bomb.
    const bomb = docxWith(Buffer.alloc(64 * 1024 * 1024, 0x20), 1024);
    expect(bomb.length).toBeLessThan(200 * 1024);
    expect(check("lying.docx", bomb)).toMatchObject({ ok: true });
    const started = performance.now();
    expect(await verifyDocumentContent({ kind: "docx", bytes: bomb })).toMatchObject({
      ok: false,
      code: "ARCHIVE_LIMIT",
    });
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it("rejects entries smaller than declared, unknown compression and data outside the file", async () => {
    const shrunk = docxWith(Buffer.from("<w:document/>"), 5000);
    expect(await verifyDocumentContent({ kind: "docx", bytes: shrunk })).toMatchObject({
      ok: false,
      code: "CORRUPT",
    });
    // Patch the compression method of the first entry (local + central header) to 12 (bzip2).
    const odd = Buffer.from(buildDocx([{ p: "x" }]));
    const entries = readZipDirectory(odd);
    odd.writeUInt16LE(12, entries[0]!.localHeaderOffset + 8);
    const cdStart = odd.indexOf(Buffer.from([0x50, 0x4b, 1, 2]));
    odd.writeUInt16LE(12, cdStart + 10);
    expect(await verifyDocumentContent({ kind: "docx", bytes: odd })).toMatchObject({
      ok: false,
      code: "CORRUPT",
    });
    // Point the first central directory entry at an offset past the end of the file.
    const outside = Buffer.from(buildDocx([{ p: "x" }]));
    const cd = outside.indexOf(Buffer.from([0x50, 0x4b, 1, 2]));
    outside.writeUInt32LE(outside.length + 10, cd + 42);
    expect(await verifyDocumentContent({ kind: "docx", bytes: outside })).toMatchObject({
      ok: false,
      code: "CORRUPT",
    });
  });

  it("does nothing for formats that are not archives", async () => {
    expect(await verifyDocumentContent({ kind: "md", bytes: Buffer.from("# x") })).toBeNull();
  });
});

describe("upload fuzzing", () => {
  // Characters are built from codes so the file itself never contains control characters.
  const chr = (...codes: number[]) => String.fromCharCode(...codes);
  const NL = chr(10);
  const BACKSLASH = chr(92);
  // Deterministic PRNG so a failure can be reproduced from the seed.
  const prng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const samples: Array<[string, DocumentKind, Buffer]> = [
    ["a.docx", "docx", buildDocx([{ heading: "H", level: 2 }, { p: "Para" }, { li: "Item" }])],
    [
      "a.pdf",
      "pdf",
      buildPdf([
        [
          { text: "Heading", size: 24 },
          { text: "Body", size: 12 },
        ],
      ]),
    ],
    ["a.md", "md", Buffer.from(["# Title", "", "Text with [link](/x)", "", "- item", ""].join(NL))],
    ["a.txt", "txt", Buffer.from(["Page: About", "Hello world", ""].join(NL))],
  ];

  it("never throws on mutated, truncated or random input (validation is total)", async () => {
    const random = prng(20261005);
    const int = (n: number) => Math.floor(random() * n);
    for (const [name, kind, original] of samples) {
      for (let i = 0; i < 150; i++) {
        let bytes = Buffer.from(original);
        const mode = i % 4;
        if (mode === 0) for (let k = 0; k < 1 + int(16); k++) bytes[int(bytes.length)] = int(256);
        else if (mode === 1) bytes = bytes.subarray(0, int(bytes.length));
        else if (mode === 2)
          bytes = Buffer.concat([
            bytes.subarray(0, int(bytes.length)),
            Buffer.from([0x50, 0x4b, 5, 6]),
            bytes,
          ]);
        else bytes = Buffer.from(Array.from({ length: int(4096) }, () => int(256)));
        const result = validateDocumentUpload({ filename: name, bytes, limits });
        expect(typeof result.ok).toBe("boolean");
        if (!result.ok) {
          expect(result.message.length).toBeGreaterThan(0);
          continue;
        }
        expect(result.kind).toBe(kind);
        const content = await verifyDocumentContent({ kind, bytes });
        if (content) expect(["CORRUPT", "ARCHIVE_LIMIT"]).toContain(content.code);
      }
    }
  });

  it("never derives anything but a clean base name from hostile file names", () => {
    const hostile = [
      "../../../../etc/passwd.md",
      ["..", "..", "windows", "win.ini.txt"].join(BACKSLASH),
      "/absolute/path.pdf",
      ["C:", "x", "y.docx"].join(BACKSLASH),
      `name${chr(0)}.pdf${chr(13, 10)}.md`,
      "a".repeat(400) + ".md",
      ".md",
      "CON.txt",
      `e${chr(0x202e)}txt.md`,
    ];
    for (const raw of hostile) {
      const clean = sanitizeFilename(raw);
      expect(clean.includes("/") || clean.includes(BACKSLASH)).toBe(false);
      expect([...clean].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)).toBe(false);
      const result = validateDocumentUpload({ filename: raw, bytes: Buffer.from("text"), limits });
      if (result.ok) {
        expect(result.filename).toBe(clean);
        expect(result.filename.length).toBeLessThanOrEqual(255);
      }
    }
  });
});
