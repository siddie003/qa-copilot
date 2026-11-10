/**
 * Validation of uploaded font files (brand fonts). A file is accepted only when its extension,
 * declared MIME type and actual bytes agree AND its font tables can be read: the font's names,
 * weight and style come from the file itself (OpenType `name`, `OS/2`, `head` tables), never from
 * the file name. WOFF tables are inflated and WOFF2 data is Brotli-decompressed with hard output
 * limits (decompression-bomb guard). Font collections (.ttc) are not supported.
 *
 * Nothing here executes font code or hands the file to a font engine; it only reads table bytes
 * with bounds checks.
 */
import { brotliDecompressSync, inflateSync } from "node:zlib";
import { sanitizeFilename } from "./upload";

export type FontFormat = "ttf" | "otf" | "woff" | "woff2";

export const FONT_MIME: Record<FontFormat, string> = {
  ttf: "font/ttf",
  otf: "font/otf",
  woff: "font/woff",
  woff2: "font/woff2",
};

const EXTENSIONS: Record<string, FontFormat> = {
  ".ttf": "ttf",
  ".otf": "otf",
  ".woff": "woff",
  ".woff2": "woff2",
};

/** MIME types browsers and operating systems send for font files ("" and octet-stream = unknown). */
const ACCEPTED_DECLARED = new Set([
  "font/ttf",
  "font/otf",
  "font/woff",
  "font/woff2",
  "font/sfnt",
  "font/collection",
  "application/font-woff",
  "application/font-woff2",
  "application/x-font-woff",
  "application/x-font-ttf",
  "application/x-font-truetype",
  "application/x-font-otf",
  "application/x-font-opentype",
  "application/font-sfnt",
  "application/vnd.ms-opentype",
  "application/x-font",
]);

/** How the font's licence bits (OS/2 fsType) describe embedding; recorded, not enforced. */
export type FontEmbedding = "installable" | "restricted" | "preview_print" | "editable";

export interface FontMetadata {
  /** Container the file uses. */
  format: FontFormat;
  /** Outline technology of the font inside the container. */
  outlines: "truetype" | "cff";
  /** name ID 1 / 2: the family and style names every font has. */
  family: string | null;
  subfamily: string | null;
  /** name ID 16 / 17: typographic family and style (larger families), when present. */
  typographicFamily: string | null;
  typographicSubfamily: string | null;
  /** name ID 4 / 6 / 5. */
  fullName: string | null;
  postScriptName: string | null;
  version: string | null;
  /** OS/2 usWeightClass (100–900), when the OS/2 table is present. */
  weight: number | null;
  /** From OS/2 fsSelection (italic/oblique) or head macStyle. */
  italic: boolean | null;
  embedding: FontEmbedding | null;
  glyphCount: number | null;
  /** Variable font (has an fvar table): one file covers a range of weights/widths. */
  variable: boolean;
}

export type FontUploadErrorCode =
  | "EMPTY"
  | "TOO_LARGE"
  | "BAD_NAME"
  | "UNSUPPORTED_TYPE"
  | "TYPE_MISMATCH"
  | "CORRUPT"
  | "ARCHIVE_LIMIT";

export type FontCheck =
  | { ok: true; format: FontFormat; mimeType: string; filename: string; metadata: FontMetadata }
  | { ok: false; code: FontUploadErrorCode; message: string };

export interface FontLimits {
  maxBytes: number;
  /** Largest decompressed font allowed (WOFF/WOFF2). Default 64 MB. */
  maxDecompressedBytes?: number;
}

const fail = (code: FontUploadErrorCode, message: string): FontCheck => ({
  ok: false,
  code,
  message,
});

class FontError extends Error {
  constructor(
    readonly code: FontUploadErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const tag = (buf: Buffer, at: number) => buf.toString("latin1", at, at + 4);

/** A table's bytes, located inside the (decompressed) font. */
type Tables = Map<string, Buffer>;

function slice(buf: Buffer, offset: number, length: number, what: string): Buffer {
  if (offset < 0 || length < 0 || offset + length > buf.length)
    throw new FontError("CORRUPT", `The font file is damaged (${what} lies outside the file).`);
  return buf.subarray(offset, offset + length);
}

const MAX_TABLES = 256;

/** Plain OpenType/TrueType: table directory at offset 12. */
function readSfnt(buf: Buffer): Tables {
  if (buf.length < 12) throw new FontError("CORRUPT", "The font file is too small to be a font.");
  const numTables = buf.readUInt16BE(4);
  if (numTables === 0 || numTables > MAX_TABLES)
    throw new FontError("CORRUPT", "The font file has an invalid table directory.");
  if (12 + numTables * 16 > buf.length)
    throw new FontError("CORRUPT", "The font file's table directory is truncated.");
  const tables: Tables = new Map();
  for (let i = 0; i < numTables; i++) {
    const at = 12 + i * 16;
    const t = tag(buf, at);
    tables.set(t, slice(buf, buf.readUInt32BE(at + 8), buf.readUInt32BE(at + 12), `table ${t}`));
  }
  return tables;
}

/** WOFF 1.0: each table is zlib-compressed separately (or stored when not smaller). */
function readWoff(buf: Buffer, maxOut: number): Tables {
  if (buf.length < 44) throw new FontError("CORRUPT", "The WOFF file is too small.");
  if (buf.readUInt32BE(8) !== buf.length)
    throw new FontError("CORRUPT", "The WOFF file is truncated or has extra data.");
  const numTables = buf.readUInt16BE(12);
  if (numTables === 0 || numTables > MAX_TABLES)
    throw new FontError("CORRUPT", "The WOFF file has an invalid table directory.");
  if (buf.readUInt32BE(16) > maxOut)
    throw new FontError("ARCHIVE_LIMIT", "The WOFF file expands to more than the allowed size.");
  if (44 + numTables * 20 > buf.length)
    throw new FontError("CORRUPT", "The WOFF table directory is truncated.");
  const tables: Tables = new Map();
  let total = 0;
  for (let i = 0; i < numTables; i++) {
    const at = 44 + i * 20;
    const t = tag(buf, at);
    const offset = buf.readUInt32BE(at + 4);
    const compLength = buf.readUInt32BE(at + 8);
    const origLength = buf.readUInt32BE(at + 12);
    const data = slice(buf, offset, compLength, `table ${t}`);
    total += origLength;
    if (total > maxOut)
      throw new FontError("ARCHIVE_LIMIT", "The WOFF file expands to more than the allowed size.");
    if (compLength > origLength)
      throw new FontError("CORRUPT", `The WOFF file is damaged (table ${t} has invalid sizes).`);
    if (compLength === origLength) {
      tables.set(t, data);
      continue;
    }
    let out: Buffer;
    try {
      out = inflateSync(data, { maxOutputLength: Math.max(1, origLength) });
    } catch {
      throw new FontError("CORRUPT", `The WOFF file is damaged (table ${t} cannot be inflated).`);
    }
    if (out.length !== origLength)
      throw new FontError("CORRUPT", `The WOFF file is damaged (table ${t} has the wrong size).`);
    tables.set(t, out);
  }
  return tables;
}

/** Tags with a one-byte code in the WOFF2 table directory (W3C WOFF2 §5.1, in order). */
const WOFF2_KNOWN_TAGS = [
  "cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post", "cvt ", "fpgm", "glyf", "loca",
  "prep", "CFF ", "VORG", "EBDT", "EBLC", "gasp", "hdmx", "kern", "LTSH", "PCLT", "VDMX", "vhea",
  "vmtx", "BASE", "GDEF", "GPOS", "GSUB", "EBSC", "JSTF", "MATH", "CBDT", "CBLC", "COLR", "CPAL",
  "SVG ", "sbix", "acnt", "avar", "bdat", "bloc", "bsln", "cvar", "fdsc", "feat", "fmtx", "fvar",
  "gvar", "hsty", "just", "lcar", "mort", "morx", "opbd", "prop", "trak", "Zapf", "Silf", "Glat",
  "Gloc", "Feat", "Sill",
]; // prettier-ignore

/** WOFF2 variable-length unsigned integer (UIntBase128). */
function base128(buf: Buffer, pos: { at: number }): number {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    if (pos.at >= buf.length)
      throw new FontError("CORRUPT", "The WOFF2 table directory is truncated.");
    const byte = buf[pos.at++]!;
    if (i === 0 && byte === 0x80)
      throw new FontError("CORRUPT", "The WOFF2 table directory is invalid.");
    if (value & 0xfe000000) throw new FontError("CORRUPT", "The WOFF2 table directory is invalid.");
    value = (value << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) return value >>> 0;
  }
  throw new FontError("CORRUPT", "The WOFF2 table directory is invalid.");
}

/**
 * WOFF 2.0: one Brotli stream holding all tables back to back in directory order. Only tables
 * that are never transformed (name, OS/2, head, maxp, fvar, ...) are read; the transformed glyf/
 * loca/hmtx data is skipped by length.
 */
function readWoff2(buf: Buffer, maxOut: number): Tables {
  if (buf.length < 48) throw new FontError("CORRUPT", "The WOFF2 file is too small.");
  if (tag(buf, 4) === "ttcf")
    throw new FontError(
      "UNSUPPORTED_TYPE",
      "Font collections are not supported; upload each font separately.",
    );
  if (buf.readUInt32BE(8) !== buf.length)
    throw new FontError("CORRUPT", "The WOFF2 file is truncated or has extra data.");
  const numTables = buf.readUInt16BE(12);
  if (numTables === 0 || numTables > MAX_TABLES)
    throw new FontError("CORRUPT", "The WOFF2 file has an invalid table directory.");
  const totalSfntSize = buf.readUInt32BE(16);
  const totalCompressedSize = buf.readUInt32BE(20);
  if (totalSfntSize > maxOut)
    throw new FontError("ARCHIVE_LIMIT", "The WOFF2 file expands to more than the allowed size.");
  const pos = { at: 48 };
  const entries: Array<{ tag: string; length: number }> = [];
  for (let i = 0; i < numTables; i++) {
    if (pos.at >= buf.length)
      throw new FontError("CORRUPT", "The WOFF2 table directory is truncated.");
    const flags = buf[pos.at++]!;
    let t: string;
    if ((flags & 0x3f) === 0x3f) {
      if (pos.at + 4 > buf.length)
        throw new FontError("CORRUPT", "The WOFF2 table directory is truncated.");
      t = tag(buf, pos.at);
      pos.at += 4;
    } else t = WOFF2_KNOWN_TAGS[flags & 0x3f]!;
    const transform = (flags >> 6) & 3;
    const origLength = base128(buf, pos);
    // glyf/loca: version 0 is the transformed form; every other table: version 0 is untouched.
    const transformed = t === "glyf" || t === "loca" ? transform !== 3 : transform !== 0;
    const length = transformed ? base128(buf, pos) : origLength;
    entries.push({ tag: t, length });
  }
  const stream = slice(buf, pos.at, totalCompressedSize, "compressed font data");
  let data: Buffer;
  try {
    data = brotliDecompressSync(stream, { maxOutputLength: Math.max(1, maxOut) });
  } catch (err) {
    if (/maxOutputLength|buffer.*large|Cannot create a Buffer/i.test(String(err)))
      throw new FontError("ARCHIVE_LIMIT", "The WOFF2 file expands to more than the allowed size.");
    throw new FontError(
      "CORRUPT",
      "The WOFF2 file is damaged (its font data cannot be decompressed).",
    );
  }
  const tables: Tables = new Map();
  let offset = 0;
  for (const e of entries) {
    tables.set(e.tag, slice(data, offset, e.length, `table ${e.tag}`));
    offset += e.length;
  }
  return tables;
}

const CLEAN = /[\u0000-\u001f\u007f-\u009f]/g;
const cleanName = (s: string) => {
  const v = s.replace(CLEAN, "").trim().slice(0, 200);
  return v || null;
};

/** Reads names from the `name` table, preferring Windows English, then any Unicode, then Mac. */
function readNames(name: Buffer): Map<number, string> {
  const out = new Map<number, string>();
  if (name.length < 6) return out;
  const count = name.readUInt16BE(2);
  const storage = name.readUInt16BE(4);
  const ranked = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 12;
    if (at + 12 > name.length) break;
    const platform = name.readUInt16BE(at);
    const encoding = name.readUInt16BE(at + 2);
    const language = name.readUInt16BE(at + 4);
    const nameId = name.readUInt16BE(at + 6);
    const length = name.readUInt16BE(at + 8);
    const offset = storage + name.readUInt16BE(at + 10);
    if (![1, 2, 4, 5, 6, 16, 17].includes(nameId) || offset + length > name.length) continue;
    const bytes = name.subarray(offset, offset + length);
    let text: string | null = null;
    let rank = 0;
    if (platform === 3 && (encoding === 1 || encoding === 10)) {
      text = length % 2 === 0 ? Buffer.from(bytes).swap16().toString("utf16le") : null;
      rank = language === 0x409 ? 4 : 3;
    } else if (platform === 0) {
      text = length % 2 === 0 ? Buffer.from(bytes).swap16().toString("utf16le") : null;
      rank = 2;
    } else if (platform === 1 && encoding === 0) {
      text = bytes.toString("latin1");
      rank = 1;
    }
    if (text === null) continue;
    const v = cleanName(text);
    if (!v || (ranked.get(nameId) ?? 0) >= rank) continue;
    ranked.set(nameId, rank);
    out.set(nameId, v);
  }
  return out;
}

function embeddingOf(fsType: number): FontEmbedding {
  if (fsType & 0x0008) return "editable";
  if (fsType & 0x0004) return "preview_print";
  if (fsType & 0x0002) return "restricted";
  return "installable";
}

function describe(format: FontFormat, tables: Tables, flavor: string): FontMetadata {
  const name = tables.get("name");
  if (!name)
    throw new FontError(
      "CORRUPT",
      "The font file has no name table, so its family cannot be read.",
    );
  const hasOutlines = tables.has("glyf") || tables.has("CFF ") || tables.has("CFF2");
  if (!hasOutlines || !tables.has("cmap"))
    throw new FontError("CORRUPT", "The file does not contain usable font outlines.");
  const head = tables.get("head");
  if (!head || head.length < 54 || head.readUInt32BE(12) !== 0x5f0f3cf5)
    throw new FontError("CORRUPT", "The font file is damaged (its head table is invalid).");
  const names = readNames(name);
  if (!names.get(1) && !names.get(16))
    throw new FontError("CORRUPT", "The font file does not name its font family.");
  const os2 = tables.get("OS/2");
  const maxp = tables.get("maxp");
  const fsSelection = os2 && os2.length >= 64 ? os2.readUInt16BE(62) : null;
  const macStyle = head.readUInt16BE(44);
  return {
    format,
    outlines: flavor === "OTTO" || tables.has("CFF ") || tables.has("CFF2") ? "cff" : "truetype",
    family: names.get(1) ?? null,
    subfamily: names.get(2) ?? null,
    typographicFamily: names.get(16) ?? null,
    typographicSubfamily: names.get(17) ?? null,
    fullName: names.get(4) ?? null,
    postScriptName: names.get(6) ?? null,
    version: names.get(5) ?? null,
    weight: os2 && os2.length >= 6 ? os2.readUInt16BE(4) : null,
    italic: fsSelection !== null ? (fsSelection & 0x0201) !== 0 : (macStyle & 0x2) !== 0,
    embedding: os2 && os2.length >= 10 ? embeddingOf(os2.readUInt16BE(8)) : null,
    glyphCount: maxp && maxp.length >= 6 ? maxp.readUInt16BE(4) : null,
    variable: tables.has("fvar"),
  };
}

/** Reads the font's tables and names; throws FontError when the file is not a usable font. */
export function readFontMetadata(bytes: Buffer, maxDecompressedBytes = 64 * 1024 * 1024) {
  if (bytes.length < 12) throw new FontError("CORRUPT", "The file is too small to be a font.");
  const signature = tag(bytes, 0);
  if (signature === "ttcf")
    throw new FontError(
      "UNSUPPORTED_TYPE",
      "Font collections (.ttc) are not supported; upload each font separately.",
    );
  if (signature === "wOFF") {
    const flavor = tag(bytes, 4);
    return describe("woff", readWoff(bytes, maxDecompressedBytes), flavor);
  }
  if (signature === "wOF2") {
    const flavor = tag(bytes, 4);
    return describe("woff2", readWoff2(bytes, maxDecompressedBytes), flavor);
  }
  if (bytes.readUInt32BE(0) === 0x00010000 || signature === "true")
    return describe("ttf", readSfnt(bytes), signature);
  if (signature === "OTTO") return describe("otf", readSfnt(bytes), signature);
  throw new FontError("TYPE_MISMATCH", "The file is not a font (unknown file signature).");
}

/** Validates name, size, declared type and content of an uploaded font file. */
export function validateFontUpload(input: {
  filename: string;
  declaredType?: string | null;
  bytes: Buffer;
  limits: FontLimits;
}): FontCheck {
  const filename = sanitizeFilename(input.filename);
  if (!filename || filename.length > 255)
    return fail("BAD_NAME", "The file needs a name of at most 255 characters.");
  const dot = filename.lastIndexOf(".");
  const ext = dot > 0 ? EXTENSIONS[filename.slice(dot).toLowerCase()] : undefined;
  if (!ext)
    return fail(
      "UNSUPPORTED_TYPE",
      "Only font files in WOFF2, WOFF, TTF or OTF format are supported.",
    );
  if (input.bytes.length === 0) return fail("EMPTY", "The file is empty.");
  if (input.bytes.length > input.limits.maxBytes)
    return fail(
      "TOO_LARGE",
      `The font file is larger than the ${Math.round(input.limits.maxBytes / 1024 / 1024)} MB limit.`,
    );
  const declared = (input.declaredType ?? "").split(";")[0]!.trim().toLowerCase();
  if (declared && declared !== "application/octet-stream" && !ACCEPTED_DECLARED.has(declared))
    return fail(
      "TYPE_MISMATCH",
      `The file type (${declared}) does not match its .${ext} extension.`,
    );
  let metadata: FontMetadata;
  try {
    metadata = readFontMetadata(input.bytes, input.limits.maxDecompressedBytes);
  } catch (err) {
    if (err instanceof FontError) return fail(err.code, err.message);
    return fail("CORRUPT", "The font file could not be read.");
  }
  // The container must match the extension; TTF and OTF are both plain OpenType (sfnt) files and
  // are often named interchangeably, so either sfnt flavour is accepted for .ttf and .otf.
  const sfnt = metadata.format === "ttf" || metadata.format === "otf";
  const extSfnt = ext === "ttf" || ext === "otf";
  if (sfnt !== extSfnt || (!sfnt && metadata.format !== ext))
    return fail(
      "TYPE_MISMATCH",
      `The file has a .${ext} extension but contains a ${metadata.format.toUpperCase()} font.`,
    );
  return {
    ok: true,
    format: metadata.format,
    mimeType: FONT_MIME[metadata.format],
    filename,
    metadata,
  };
}

/** Families a font can be referred to by in CSS (family, typographic family, full name). */
export function fontFamilyNames(
  m: Pick<FontMetadata, "family" | "typographicFamily" | "fullName" | "postScriptName">,
): string[] {
  return [
    ...new Set(
      [m.typographicFamily, m.family, m.fullName, m.postScriptName]
        .filter((v): v is string => Boolean(v))
        .map((v) => v.trim()),
    ),
  ];
}
