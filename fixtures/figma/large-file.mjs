// Generated Figma REST responses for multi-page tests (no binary or recorded files).
// The shapes follow the documented REST API: GET file → { name, version, lastModified,
// document, styles }; each page (CANVAS) holds 3 frames with a heading text using "Heading/H1"
// and a swatch using the page's own color style "Palette/Color <n>".

/** A file with `pages` pages; `hugePage` gets 2,000 extra nodes (to exceed a response cap). */
export function buildFigmaFile(pages, opts = {}) {
  const styles = {
    "S:h1": { name: "Heading/H1", styleType: "TEXT" },
    "S:primary": { name: "Brand/Primary", styleType: "FILL" },
  };
  const canvases = [];
  for (let p = 1; p <= pages; p++) {
    styles[`S:c${p}`] = { name: `Palette/Color ${p}`, styleType: "FILL" };
    const frames = Array.from({ length: 3 }, (_, f) => ({
      id: `${p}:${f + 10}`,
      name: `Screen ${p}.${f + 1}`,
      type: "FRAME",
      absoluteBoundingBox: { x: 0, y: 0, width: 1440, height: 900 + f },
      children: [
        {
          id: `${p}:${f + 100}`,
          name: "Title",
          type: "TEXT",
          styles: { text: "S:h1" },
          style: { fontFamily: "Inter", fontSize: 48, fontWeight: 700, lineHeightPx: 56 },
          fills: [{ type: "SOLID", color: { r: 0.1, g: 0.1, b: 0.2, a: 1 } }],
        },
        {
          id: `${p}:${f + 200}`,
          name: "Swatch",
          type: "RECTANGLE",
          styles: { fill: `S:c${p}` },
          fills: [{ type: "SOLID", color: { r: p / pages, g: 0.5, b: 0.25, a: 1 } }],
        },
        ...(opts.hugePage === p
          ? Array.from({ length: 2_000 }, (_, i) => ({
              id: `${p}:${5_000 + i}`,
              name: `Filler ${"x".repeat(100)}`,
              type: "RECTANGLE",
            }))
          : []),
      ],
    }));
    canvases.push({ id: `0:${p}`, name: `Page ${p}`, type: "CANVAS", children: frames });
  }
  return {
    name: "Large design",
    version: opts.version ?? "100",
    lastModified: "2026-10-01T00:00:00Z",
    document: { id: "0:0", name: "Document", type: "DOCUMENT", children: canvases },
    styles,
  };
}

/** The styles a page uses (as Figma returns them per node in GET file nodes). */
export function pageStyles(file, pageId) {
  const n = pageId.split(":")[1];
  return { "S:h1": file.styles["S:h1"], [`S:c${n}`]: file.styles[`S:c${n}`] };
}

/**
 * Response body for a REST path of `file`: meta, file (optionally depth=1) or nodes. Returns
 * null for paths it does not know.
 */
export function figmaResponse(file, url) {
  const key = url.pathname.split("/")[3];
  if (url.pathname === `/v1/files/${key}/meta`)
    return { file: { name: file.name, version: file.version } };
  if (url.pathname === `/v1/files/${key}`) {
    const document =
      url.searchParams.get("depth") === "1"
        ? {
            ...file.document,
            children: file.document.children.map(({ children: _c, ...p }) => p),
          }
        : file.document;
    return {
      name: file.name,
      version: file.version,
      lastModified: file.lastModified,
      document,
      styles: file.styles,
    };
  }
  if (url.pathname === `/v1/files/${key}/nodes`) {
    const nodes = {};
    for (const id of url.searchParams.get("ids").split(",")) {
      const page = file.document.children.find((c) => c.id === id);
      nodes[id] = page ? { document: page, styles: pageStyles(file, id) } : null;
    }
    return {
      name: file.name,
      version: url.searchParams.get("version") ?? file.version,
      lastModified: file.lastModified,
      nodes,
    };
  }
  return null;
}
