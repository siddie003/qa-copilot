/**
 * Validation of uploaded documents (content documents and brand guidelines). The file is trusted
 * only after its extension, declared MIME type and actual bytes agree. DOCX files are ZIP
 * archives: their central directory is inspected before any parser runs (zip-bomb guard).
 */

export type DocumentKind = "pdf" | "docx" | "txt" | "md";

export interface UploadLimits {
  maxBytes: number;
  /** Total uncompressed size allowed inside a DOCX archive. */
  maxUncompressedBytes?: number;
  /** Maximum uncompressed/compressed ratio of a single archive entry. */
  maxCompressionRatio?: number;
  maxArchiveEntries?: number;
}

export type UploadCheck =
  | { ok: true; kind: DocumentKind; mimeType: string; filename: string }
  | { ok: false; code: UploadErrorCode; message: string };

export type UploadErrorCode =
  | "EMPTY"
  | "TOO_LARGE"
  | "BAD_NAME"
  | "UNSUPPORTED_TYPE"
  | "TYPE_MISMATCH"
  | "CORRUPT"
  | "ARCHIVE_LIMIT"
  | "ENCODING";

const KINDS: Record<string, DocumentKind> = {
  ".pdf": "pdf",
  ".docx": "docx",
  ".txt": "txt",
  ".md": "md",
  ".markdown": "md",
};

export const DOCUMENT_MIME: Record<DocumentKind, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
};

/** MIME types browsers send for each kind. Empty and octet-stream mean "unknown" and are allowed. */
const ACCEPTED_DECLARED: Record<DocumentKind, string[]> = {
  pdf: ["application/pdf", "application/x-pdf"],
  docx: [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/zip",
    "application/x-zip-compressed",
  ],
  txt: ["text/plain"],
  md: ["text/markdown", "text/x-markdown", "text/plain"],
};

const fail = (code: UploadErrorCode, message: string): UploadCheck => ({
  ok: false,
  code,
  message,
});

/** Keeps only the base name and strips control characters; never used as a storage path. */
export function sanitizeFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  return base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
}

export interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  encrypted: boolean;
}

/** Reads a ZIP central directory without decompressing anything. Throws on malformed archives. */
export function readZipDirectory(buf: Buffer, maxEntries = 5000): ZipEntry[] {
  const EOCD = 0x06054b50;
  const minEocd = 22;
  if (buf.length < minEocd) throw new Error("archive too small");
  let eocd = -1;
  for (let i = buf.length - minEocd; i >= Math.max(0, buf.length - minEocd - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("end of central directory not found");
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdOffset === 0xffffffff)
    throw new Error("ZIP64 archives are not supported");
  if (total > maxEntries) throw new Error(`archive has more than ${maxEntries} entries`);
  if (cdOffset + cdSize > buf.length) throw new Error("central directory out of range");
  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let n = 0; n < total; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50)
      throw new Error("malformed central directory");
    const flags = buf.readUInt16LE(p + 8);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff)
      throw new Error("ZIP64 entries are not supported");
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    entries.push({ name, compressedSize, uncompressedSize, encrypted: (flags & 1) === 1 });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function checkDocx(bytes: Buffer, limits: UploadLimits): UploadCheck | null {
  let entries: ZipEntry[];
  try {
    entries = readZipDirectory(bytes, limits.maxArchiveEntries ?? 5000);
  } catch (err) {
    const msg = (err as Error).message;
    return /ZIP64|more than/.test(msg)
      ? fail("ARCHIVE_LIMIT", `The DOCX file cannot be processed: ${msg}.`)
      : fail("CORRUPT", "The DOCX file is damaged or is not a Word document.");
  }
  const names = new Set(entries.map((e) => e.name));
  if (!names.has("word/document.xml") || !names.has("[Content_Types].xml"))
    return fail("TYPE_MISMATCH", "The file is a ZIP archive but not a Word (DOCX) document.");
  if (entries.some((e) => e.encrypted))
    return fail("CORRUPT", "Password-protected DOCX files are not supported.");
  const maxTotal = limits.maxUncompressedBytes ?? 200 * 1024 * 1024;
  const maxRatio = limits.maxCompressionRatio ?? 200;
  const total = entries.reduce((s, e) => s + e.uncompressedSize, 0);
  if (total > maxTotal)
    return fail(
      "ARCHIVE_LIMIT",
      `The DOCX file expands to ${Math.round(total / 1024 / 1024)} MB, more than the ${Math.round(maxTotal / 1024 / 1024)} MB allowed.`,
    );
  const bomb = entries.find(
    (e) =>
      e.uncompressedSize > 1024 * 1024 &&
      e.uncompressedSize / Math.max(1, e.compressedSize) > maxRatio,
  );
  if (bomb)
    return fail(
      "ARCHIVE_LIMIT",
      "The DOCX file contains an entry with an implausible compression ratio and was rejected.",
    );
  return null;
}

function checkText(bytes: Buffer): UploadCheck | null {
  if (bytes.includes(0))
    return fail("ENCODING", "The file contains binary data. Upload plain UTF-8 text.");
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail("ENCODING", "The file is not valid UTF-8 text. Save it with UTF-8 encoding.");
  }
  return null;
}

/** Validates name, size, declared type and content of an uploaded document. */
export function validateDocumentUpload(input: {
  filename: string;
  declaredType?: string | null;
  bytes: Buffer;
  limits: UploadLimits;
}): UploadCheck {
  const filename = sanitizeFilename(input.filename);
  if (!filename || filename.length > 255)
    return fail("BAD_NAME", "The file needs a name of at most 255 characters.");
  const dot = filename.lastIndexOf(".");
  const kind = dot > 0 ? KINDS[filename.slice(dot).toLowerCase()] : undefined;
  if (!kind)
    return fail("UNSUPPORTED_TYPE", "Only PDF, DOCX, TXT and Markdown (.md) files are supported.");
  if (input.bytes.length === 0) return fail("EMPTY", "The file is empty.");
  if (input.bytes.length > input.limits.maxBytes)
    return fail(
      "TOO_LARGE",
      `The file is larger than the ${Math.round(input.limits.maxBytes / 1024 / 1024)} MB limit.`,
    );

  const declared = (input.declaredType ?? "").split(";")[0]!.trim().toLowerCase();
  if (
    declared &&
    declared !== "application/octet-stream" &&
    !ACCEPTED_DECLARED[kind].includes(declared)
  )
    return fail(
      "TYPE_MISMATCH",
      `The file type (${declared}) does not match its ${kind.toUpperCase()} extension.`,
    );

  const head = input.bytes.subarray(0, 1024);
  if (kind === "pdf" && !head.includes(Buffer.from("%PDF-")))
    return fail("TYPE_MISMATCH", "The file has a .pdf extension but is not a PDF document.");
  if (kind === "docx") {
    if (input.bytes.readUInt32LE(0) !== 0x04034b50)
      return fail("TYPE_MISMATCH", "The file has a .docx extension but is not a Word document.");
    const problem = checkDocx(input.bytes, input.limits);
    if (problem) return problem;
  }
  if (kind === "txt" || kind === "md") {
    const problem = checkText(input.bytes);
    if (problem) return problem;
  }
  return { ok: true, kind, mimeType: DOCUMENT_MIME[kind], filename };
}
