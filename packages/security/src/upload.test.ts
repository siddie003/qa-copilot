import { describe, expect, it } from "vitest";
import { buildDocx, buildPdf, buildZip } from "../../../fixtures/documents/build.mjs";
import { readZipDirectory, sanitizeFilename, validateDocumentUpload } from "./upload";

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
