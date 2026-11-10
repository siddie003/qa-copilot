// Builders for real DOCX and PDF test documents (no binary files in the repository).
// The output is a valid Office Open XML package / PDF 1.4 file that real parsers read.
import zlib from "node:zlib";

/**
 * Minimal ZIP writer (stored or deflated entries). `declaredSizes` overrides the uncompressed
 * size written into the headers (to build archives that lie about their content in tests).
 */
export function buildZip(files, { deflate = true, declaredSizes = {} } = {}) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const packed = deflate ? zlib.deflateRawSync(data) : data;
    const nameBuf = Buffer.from(name, "utf8");
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(declaredSizes[name] ?? data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, packed);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(deflate ? 8 : 0, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(packed.length, 20);
    cd.writeUInt32LE(declaredSizes[name] ?? data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += 30 + nameBuf.length + packed.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, end]);
}

const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Builds a .docx. Blocks: { heading: "Text", level: 1 } | { p: "Text" } | { li: "Text" } |
 * { link: "Text", href: "/x" } | { p: "CTA: ", link: "Text", href: "/x" }.
 */
export function buildDocx(blocks) {
  const rels = [];
  const body = blocks
    .map((b) => {
      if (b.heading)
        return `<w:p><w:pPr><w:pStyle w:val="Heading${b.level ?? 1}"/></w:pPr><w:r><w:t xml:space="preserve">${esc(b.heading)}</w:t></w:r></w:p>`;
      if (b.li)
        return `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t xml:space="preserve">${esc(b.li)}</w:t></w:r></w:p>`;
      const runs = [];
      if (b.p) runs.push(`<w:r><w:t xml:space="preserve">${esc(b.p)}</w:t></w:r>`);
      if (b.link) {
        const id = `rIdLink${rels.length + 1}`;
        rels.push(
          `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${esc(b.href)}" TargetMode="External"/>`,
        );
        runs.push(
          `<w:hyperlink r:id="${id}"><w:r><w:t xml:space="preserve">${esc(b.link)}</w:t></w:r></w:hyperlink>`,
        );
      }
      return `<w:p>${runs.join("")}</w:p>`;
    })
    .join("");
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const headingStyles = [1, 2, 3]
    .map(
      (n) =>
        `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/></w:style>`,
    )
    .join("");
  return buildZip({
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    "word/_rels/document.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>${rels.join("")}</Relationships>`,
    "word/styles.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W}>${headingStyles}<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/></w:style></w:styles>`,
    "word/numbering.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`,
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W} ${R}><w:body>${body}</w:body></w:document>`,
  });
}

const pdfText = (s) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

/**
 * Builds a PDF with Helvetica text. pages: Array<Array<{ text, size }> | { image: true }>; lines
 * are laid out top-down with a gap proportional to the font size. `{ image: true }` is a page
 * that only paints an image (like a scanned page, no text layer); an empty array is a blank page.
 * Text must be Latin-1.
 */
export function buildPdf(pages) {
  const objects = [];
  const add = (body) => {
    objects.push(body);
    return objects.length;
  };
  const catalogId = add(null);
  const pagesId = add(null);
  const fontId = add(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  );
  let imageId = null;
  const pageIds = [];
  for (const page of pages) {
    const ops = [];
    let resources = `<< /Font << /F1 ${fontId} 0 R >> >>`;
    if (!Array.isArray(page) && page.image) {
      // A 2×2 grayscale image scaled over the page.
      imageId ??= add(
        "<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 4 >>\nstream\n\u0000\u00ff\u00ff\u0000\nendstream",
      );
      resources = `<< /XObject << /Im1 ${imageId} 0 R >> >>`;
      ops.push("q 468 0 0 600 72 120 cm /Im1 Do Q");
    } else {
      let y = 800;
      for (const l of page) {
        if (l.gap) y -= l.gap;
        y -= l.size * 1.4;
        ops.push(`BT /F1 ${l.size} Tf 72 ${y.toFixed(1)} Td (${pdfText(l.text)}) Tj ET`);
      }
    }
    const stream = ops.join("\n");
    const contentId = add(
      `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
    );
    pageIds.push(
      add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 842] /Resources ${resources} /Contents ${contentId} 0 R >>`,
      ),
    );
  }
  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] =
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  let out = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
