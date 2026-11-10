import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { brotliCompressSync, deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { fontFamilyNames, readFontMetadata, validateFontUpload } from "./font";

// ---- synthetic fonts (test data built byte by byte from the OpenType / WOFF / WOFF2 specs) -----

function nameTable(names: Record<number, string>): Buffer {
  const entries = Object.entries(names).map(([id, text]) => ({
    id: Number(id),
    bytes: Buffer.from(text, "utf16le").swap16(),
  }));
  const header = Buffer.alloc(6 + entries.length * 12);
  header.writeUInt16BE(0, 0);
  header.writeUInt16BE(entries.length, 2);
  header.writeUInt16BE(header.length, 4);
  let offset = 0;
  entries.forEach((e, i) => {
    const at = 6 + i * 12;
    header.writeUInt16BE(3, at); // Windows
    header.writeUInt16BE(1, at + 2); // Unicode BMP
    header.writeUInt16BE(0x409, at + 4); // en-US
    header.writeUInt16BE(e.id, at + 6);
    header.writeUInt16BE(e.bytes.length, at + 8);
    header.writeUInt16BE(offset, at + 10);
    offset += e.bytes.length;
  });
  return Buffer.concat([header, ...entries.map((e) => e.bytes)]);
}

function tables(
  opts: { family?: string; weight?: number; italic?: boolean; fsType?: number } = {},
) {
  const head = Buffer.alloc(54);
  head.writeUInt32BE(0x5f0f3cf5, 12);
  head.writeUInt16BE(opts.italic ? 2 : 0, 44);
  const os2 = Buffer.alloc(78);
  os2.writeUInt16BE(opts.weight ?? 700, 4);
  os2.writeUInt16BE(opts.fsType ?? 0, 8);
  os2.writeUInt16BE(opts.italic ? 1 : 0x40, 62);
  const maxp = Buffer.alloc(6);
  maxp.writeUInt32BE(0x00005000, 0);
  maxp.writeUInt16BE(42, 4);
  return new Map<string, Buffer>([
    ["OS/2", os2],
    ["cmap", Buffer.alloc(36, 1)],
    ["glyf", Buffer.alloc(120, 7)],
    ["head", head],
    ["loca", Buffer.alloc(8)],
    ["maxp", maxp],
    [
      "name",
      nameTable({
        1: opts.family ?? "Brand Sans",
        2: opts.italic ? "Bold Italic" : "Bold",
        4: `${opts.family ?? "Brand Sans"} Bold`,
        6: "BrandSans-Bold",
      }),
    ],
  ]);
}

function sfnt(t = tables(), signature = 0x00010000): Buffer {
  const entries = [...t.entries()];
  const dir = Buffer.alloc(12 + entries.length * 16);
  dir.writeUInt32BE(signature, 0);
  dir.writeUInt16BE(entries.length, 4);
  let offset = dir.length;
  const bodies: Buffer[] = [];
  entries.forEach(([tag, data], i) => {
    const at = 12 + i * 16;
    dir.write(tag, at, "latin1");
    dir.writeUInt32BE(offset, at + 8);
    dir.writeUInt32BE(data.length, at + 12);
    const padded = Buffer.concat([data, Buffer.alloc((4 - (data.length % 4)) % 4)]);
    bodies.push(padded);
    offset += padded.length;
  });
  return Buffer.concat([dir, ...bodies]);
}

function woff(t = tables()): Buffer {
  const entries = [...t.entries()].map(([tag, data]) => {
    const z = deflateSync(data);
    return { tag, data, stored: z.length < data.length ? z : data };
  });
  const header = Buffer.alloc(44 + entries.length * 20);
  header.write("wOFF", 0, "latin1");
  header.writeUInt32BE(0x00010000, 4);
  header.writeUInt16BE(entries.length, 12);
  header.writeUInt32BE(
    12 + entries.length * 16 + entries.reduce((n, e) => n + e.data.length, 0),
    16,
  );
  let offset = header.length;
  const bodies: Buffer[] = [];
  entries.forEach((e, i) => {
    const at = 44 + i * 20;
    header.write(e.tag, at, "latin1");
    header.writeUInt32BE(offset, at + 4);
    header.writeUInt32BE(e.stored.length, at + 8);
    header.writeUInt32BE(e.data.length, at + 12);
    bodies.push(e.stored);
    offset += e.stored.length;
  });
  const out = Buffer.concat([header, ...bodies]);
  out.writeUInt32BE(out.length, 8);
  return out;
}

const KNOWN = [
  "cmap",
  "head",
  "hhea",
  "hmtx",
  "maxp",
  "name",
  "OS/2",
  "post",
  "cvt ",
  "fpgm",
  "glyf",
  "loca",
];

function base128(n: number): Buffer {
  const bytes = [n & 0x7f];
  for (let v = n >>> 7; v > 0; v >>>= 7) bytes.unshift(0x80 | (v & 0x7f));
  return Buffer.from(bytes);
}

/** WOFF2 with every table untransformed (glyf/loca use transform version 3 = null transform). */
function woff2(t = tables(), opts: { totalSfntSize?: number } = {}): Buffer {
  const entries = [...t.entries()];
  const dir = Buffer.concat(
    entries.map(([tag, data]) => {
      const idx = KNOWN.indexOf(tag);
      const nullTransform = tag === "glyf" || tag === "loca" ? 3 << 6 : 0;
      const flags = Buffer.from([(idx === -1 ? 0x3f : idx) | nullTransform]);
      return Buffer.concat([
        flags,
        idx === -1 ? Buffer.from(tag, "latin1") : Buffer.alloc(0),
        base128(data.length),
      ]);
    }),
  );
  const compressed = brotliCompressSync(Buffer.concat(entries.map(([, d]) => d)));
  const header = Buffer.alloc(48);
  header.write("wOF2", 0, "latin1");
  header.writeUInt32BE(0x00010000, 4);
  header.writeUInt16BE(entries.length, 12);
  header.writeUInt32BE(opts.totalSfntSize ?? 4096, 16);
  header.writeUInt32BE(compressed.length, 20);
  const out = Buffer.concat([header, dir, compressed]);
  out.writeUInt32BE(out.length, 8);
  return out;
}

const check = (filename: string, bytes: Buffer, declaredType = "", maxBytes = 1024 * 1024) =>
  validateFontUpload({ filename, declaredType, bytes, limits: { maxBytes } });

describe("font upload validation (synthetic test fonts)", () => {
  it("reads names, weight and style from TTF, OTF, WOFF and WOFF2 containers", () => {
    for (const [name, bytes, format] of [
      ["brand.ttf", sfnt(), "ttf"],
      ["brand.otf", sfnt(tables(), 0x4f54544f), "otf"],
      ["brand.woff", woff(), "woff"],
      ["brand.woff2", woff2(), "woff2"],
    ] as const) {
      const r = check(name, bytes, `font/${format}`);
      expect(r.ok, name).toBe(true);
      if (!r.ok) continue;
      expect(r.format).toBe(format);
      expect(r.metadata).toMatchObject({
        family: "Brand Sans",
        subfamily: "Bold",
        fullName: "Brand Sans Bold",
        postScriptName: "BrandSans-Bold",
        weight: 700,
        italic: false,
        embedding: "installable",
        glyphCount: 42,
        variable: false,
      });
    }
  });

  it("reports italic fonts and restricted embedding bits", () => {
    const r = check("brand-italic.woff2", woff2(tables({ italic: true, fsType: 2 })));
    expect(r.ok && r.metadata).toMatchObject({ italic: true, embedding: "restricted" });
  });

  it("rejects unsupported extensions, empty and oversized files", () => {
    expect(check("brand.ttc", sfnt())).toMatchObject({ ok: false, code: "UNSUPPORTED_TYPE" });
    expect(check("brand.exe", sfnt())).toMatchObject({ ok: false, code: "UNSUPPORTED_TYPE" });
    expect(check("brand.ttf", Buffer.alloc(0))).toMatchObject({ ok: false, code: "EMPTY" });
    expect(check("brand.ttf", sfnt(), "", 100)).toMatchObject({ ok: false, code: "TOO_LARGE" });
  });

  it("does not trust the extension or the declared type", () => {
    expect(check("brand.ttf", Buffer.from("<html>not a font</html>"))).toMatchObject({
      ok: false,
      code: "TYPE_MISMATCH",
    });
    expect(check("brand.woff2", sfnt())).toMatchObject({ ok: false, code: "TYPE_MISMATCH" });
    expect(check("brand.ttf", woff())).toMatchObject({ ok: false, code: "TYPE_MISMATCH" });
    expect(check("brand.ttf", sfnt(), "text/html")).toMatchObject({
      ok: false,
      code: "TYPE_MISMATCH",
    });
    // A font collection is recognized and refused with a clear message.
    const ttc = Buffer.concat([Buffer.from("ttcf", "latin1"), Buffer.alloc(40)]);
    expect(check("brand.ttf", ttc)).toMatchObject({ ok: false, code: "UNSUPPORTED_TYPE" });
  });

  it("rejects damaged fonts instead of guessing", () => {
    const truncated = sfnt().subarray(0, 60);
    expect(check("brand.ttf", truncated)).toMatchObject({ ok: false, code: "CORRUPT" });
    const noName = tables();
    noName.delete("name");
    expect(check("brand.ttf", sfnt(noName))).toMatchObject({ ok: false, code: "CORRUPT" });
    const badHead = tables();
    badHead.set("head", Buffer.alloc(54));
    expect(check("brand.ttf", sfnt(badHead))).toMatchObject({ ok: false, code: "CORRUPT" });
    const woffBytes = woff();
    woffBytes.writeUInt32BE(woffBytes.length + 10, 8); // declared length disagrees
    expect(check("brand.woff", woffBytes)).toMatchObject({ ok: false, code: "CORRUPT" });
  });

  it("refuses WOFF2 files that would expand beyond the limit (decompression bomb guard)", () => {
    const big = woff2(tables(), { totalSfntSize: 500 * 1024 * 1024 });
    expect(check("brand.woff2", big)).toMatchObject({ ok: false, code: "ARCHIVE_LIMIT" });
    const t = tables();
    t.set("glyf", Buffer.alloc(3 * 1024 * 1024));
    expect(() => readFontMetadata(woff2(t, { totalSfntSize: 4096 }), 1024 * 1024)).toThrow(
      /allowed size|damaged/,
    );
  });

  it("lists the names CSS can use for a font", () => {
    expect(
      fontFamilyNames({
        family: "Brand Sans",
        typographicFamily: "Brand",
        fullName: "Brand Sans Bold",
        postScriptName: "BrandSans-Bold",
      }),
    ).toEqual(["Brand", "Brand Sans", "Brand Sans Bold", "BrandSans-Bold"]);
  });
});

// Real, openly licensed font files shipped with Next.js (Geist, SIL OFL) when installed.
const nm = path.resolve(import.meta.dirname, "../../../node_modules/next/dist");
const geistTtf = path.join(nm, "compiled/@vercel/og/Geist-Regular.ttf");
const geistWoff2 = path.join(nm, "next-devtools/server/font/geist-latin.woff2");

describe.skipIf(!existsSync(geistTtf) || !existsSync(geistWoff2))("real font files", () => {
  it("reads Geist from a TTF and a WOFF2 file", () => {
    const ttf = check("Geist-Regular.ttf", readFileSync(geistTtf), "font/ttf", 5 * 1024 * 1024);
    expect(ttf.ok && ttf.metadata).toMatchObject({
      format: "ttf",
      family: "Geist",
      postScriptName: "Geist-Regular",
      weight: 400,
      italic: false,
    });
    const w2 = check("geist-latin.woff2", readFileSync(geistWoff2), "font/woff2");
    expect(w2.ok && w2.metadata).toMatchObject({
      format: "woff2",
      family: "Geist",
      variable: true,
    });
  });
});
