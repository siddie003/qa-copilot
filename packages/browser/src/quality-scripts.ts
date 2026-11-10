// Scripts collecting Design Quality & Typography data inside the scanned page. Plain strings on
// purpose (see page-scripts.ts: tsx/esbuild rewrites named functions with a `__name()` helper that
// does not exist in the browser). They only read the page; nothing is modified.

import { IN_CONSENT } from "./consent";

/** Elements whose text the browser's font engine is asked about (index into a fixed query). */
export const HEADING_QUERY = "h1, h2, h3, h4, h5, h6";
export const PARAGRAPH_QUERY = "p";

/**
 * Computed typography of every visible heading (H1–H6) and a sample of body paragraphs, the
 * page's web-font faces, images with their intrinsic and rendered sizes, and layout measurements
 * of sibling groups (left-edge alignment and repeated gaps) plus the spacing values used by
 * content elements. Every item carries a CSS selector and a bounding box.
 */
export const DESIGN_QUALITY_SCRIPT = `(() => {
  const cssPath = (el) => {
    if (!(el instanceof Element)) return null;
    if (el.id && /^[A-Za-z][\\w-]*$/.test(el.id)) return "#" + el.id;
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body && parts.length < 5) {
      let part = node.tagName.toLowerCase();
      if (node.id && /^[A-Za-z][\\w-]*$/.test(node.id)) { parts.unshift("#" + node.id); break; }
      const parent = node.parentElement;
      if (parent) {
        const same = Array.prototype.filter.call(parent.children, (c) => c.tagName === node.tagName);
        if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(" > ");
  };
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0;
  };
  const box = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), width: Math.round(r.width), height: Math.round(r.height) }; };
  const clean = (s, max) => (s || "").replace(/\\s+/g, " ").trim().slice(0, max);
  const px = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? Math.round(n * 100) / 100 : null; };
  const CHROME = "nav, header, footer, [role=navigation], [role=banner], [role=contentinfo]";
  ${IN_CONSENT}
  const typo = (el) => {
    const cs = getComputedStyle(el);
    return {
      fontFamily: cs.fontFamily,
      fontSize: px(cs.fontSize),
      fontWeight: cs.fontWeight,
      fontStyle: cs.fontStyle,
      lineHeight: cs.lineHeight === "normal" ? "normal" : px(cs.lineHeight),
      letterSpacing: cs.letterSpacing,
      textTransform: cs.textTransform,
      textAlign: cs.textAlign,
      color: cs.color,
    };
  };

  const headings = [];
  const allHeadings = document.querySelectorAll(${JSON.stringify(HEADING_QUERY)});
  for (let i = 0; i < allHeadings.length && headings.length < 200; i++) {
    const el = allHeadings[i];
    if (!isVisible(el) || inConsent(el) || !clean(el.textContent, 1)) continue;
    const cs = getComputedStyle(el);
    headings.push(Object.assign({
      index: i,
      level: Number(el.tagName.slice(1)),
      selector: cssPath(el),
      text: clean(el.textContent, 120),
      inChrome: !!el.closest(CHROME),
      marginTop: px(cs.marginTop),
      marginBottom: px(cs.marginBottom),
      box: box(el),
    }, typo(el)));
  }

  const paragraphs = [];
  const allParagraphs = document.querySelectorAll(${JSON.stringify(PARAGRAPH_QUERY)});
  for (let i = 0; i < allParagraphs.length && paragraphs.length < 20; i++) {
    const el = allParagraphs[i];
    if (el.closest(CHROME) || inConsent(el) || !isVisible(el) || clean(el.textContent, 30).length < 20) continue;
    paragraphs.push(Object.assign({ index: i, selector: cssPath(el), text: clean(el.textContent, 80), box: box(el) }, typo(el)));
  }

  const fonts = [];
  try { document.fonts.forEach((f) => { if (fonts.length < 100) fonts.push({ family: f.family.replace(/^["']|["']$/g, ""), status: f.status, weight: f.weight, style: f.style }); }); } catch (e) {}

  const images = [];
  for (const img of Array.prototype.slice.call(document.images, 0, 200)) {
    const r = img.getBoundingClientRect();
    const cs = getComputedStyle(img);
    const src = img.currentSrc || img.src || "";
    images.push({
      src,
      selector: cssPath(img),
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      renderedWidth: Math.round(r.width * 100) / 100,
      renderedHeight: Math.round(r.height * 100) / 100,
      objectFit: cs.objectFit,
      visible: isVisible(img),
      complete: img.complete,
      broken: img.complete && img.naturalWidth === 0 && !!src,
      isSvg: /\\.svg(\\?|#|$)/i.test(src) || /^data:image\\/svg/i.test(src),
      box: box(img),
    });
  }

  // Sibling groups inside content: near-miss left edges (1–4px apart) of stacked blocks, and
  // uneven gaps between repeated items (same tag and class) laid out in one row or column.
  const alignment = [];
  const gaps = [];
  const spacing = new Map();
  const addSpacing = (prop, value, el) => {
    if (value === null || value <= 0) return;
    const key = prop + ":" + value;
    const e = spacing.get(key);
    if (e) e.count += 1;
    else spacing.set(key, { property: prop, value, count: 1, sample: cssPath(el) });
  };
  // Items of one kind: same tag and same first class ("card" and "card featured" are both cards).
  const signature = (el) => el.tagName + "." + (typeof el.className === "string" ? el.className.trim().split(/\\s+/)[0] : "");
  const parents = Array.prototype.slice.call(document.body ? document.body.querySelectorAll("*") : [], 0, 4000);
  const BLOCKISH = new Set(["block", "flex", "grid", "list-item", "table", "flow-root"]);
  for (const parent of parents) {
    if (alignment.length >= 30 && gaps.length >= 30) break;
    if (parent.closest(CHROME) || parent.children.length < 2 || parent.children.length > 60) continue;
    const kids = Array.prototype.filter.call(parent.children, (c) => isVisible(c) && !["SCRIPT", "STYLE", "TEMPLATE", "BR"].includes(c.tagName));
    if (kids.length < 2) continue;
    const rects = kids.map((k) => ({ el: k, r: k.getBoundingClientRect(), cs: getComputedStyle(k) }));
    for (const x of rects) {
      if (spacing.size >= 400) break;
      addSpacing("margin-top", px(x.cs.marginTop), x.el);
      addSpacing("margin-bottom", px(x.cs.marginBottom), x.el);
      addSpacing("padding-top", px(x.cs.paddingTop), x.el);
      addSpacing("padding-bottom", px(x.cs.paddingBottom), x.el);
      addSpacing("padding-left", px(x.cs.paddingLeft), x.el);
      addSpacing("padding-right", px(x.cs.paddingRight), x.el);
    }
    const pcs = getComputedStyle(parent);
    if (pcs.display === "flex" || pcs.display === "grid") {
      addSpacing("row-gap", px(pcs.rowGap), parent);
      addSpacing("column-gap", px(pcs.columnGap), parent);
    }
    if (alignment.length < 30) {
      const stacked = rects.filter((x) => BLOCKISH.has(x.cs.display) && x.cs.position === "static" && x.r.width >= 40 && ["left", "start"].includes(x.cs.textAlign) && x.cs.float === "none");
      for (let i = 1; i < stacked.length; i++) {
        const a = stacked[i - 1], b = stacked[i];
        if (b.r.top < a.r.bottom - 1) continue;
        const d = Math.abs(b.r.left - a.r.left);
        if (d > 1 && d <= 4) {
          alignment.push({ parent: cssPath(parent), a: { selector: cssPath(a.el), left: Math.round(a.r.left * 100) / 100, box: box(a.el) }, b: { selector: cssPath(b.el), left: Math.round(b.r.left * 100) / 100, box: box(b.el) }, offsetPx: Math.round(d * 100) / 100 });
          break;
        }
      }
    }
    if (gaps.length < 30) {
      // Runs of consecutive siblings of the same kind (an element of another kind ends the run,
      // so a gap is never measured across it). Inline items (links or spans inside running text)
      // are positioned by line wrapping, not by spacing rules, so they are not measured.
      const groups = [];
      let run = [];
      for (const x of rects) {
        const inFlow =
          (x.cs.position === "static" || x.cs.position === "relative") &&
          !/^inline(?!-(block|flex|grid))/.test(x.cs.display);
        if (inFlow && run.length && signature(run[0].el) === signature(x.el)) run.push(x);
        else {
          groups.push(run);
          run = inFlow ? [x] : [];
        }
      }
      groups.push(run);
      for (const g of groups) {
        if (g.length < 3) continue;
        const column = g.every((x, i) => i === 0 || x.r.top >= g[i - 1].r.bottom - 1);
        const row = g.every((x, i) => i === 0 || (x.r.left >= g[i - 1].r.right - 1 && Math.abs(x.r.top - g[0].r.top) <= 2));
        if (!column && !row) continue;
        const values = g.slice(1).map((x, i) => Math.round((column ? x.r.top - g[i].r.bottom : x.r.left - g[i].r.right) * 100) / 100);
        const spread = Math.max(...values) - Math.min(...values);
        if (spread > 2)
          gaps.push({ parent: cssPath(parent), axis: column ? "vertical" : "horizontal", item: g[0].el.tagName.toLowerCase() + (typeof g[0].el.className === "string" && g[0].el.className.trim() ? "." + g[0].el.className.trim().split(/\\s+/)[0] : ""), gaps: values, items: g.slice(0, 12).map((x) => ({ selector: cssPath(x.el), box: box(x.el) })) });
        if (gaps.length >= 30) break;
      }
    }
  }

  return {
    viewportWidth: document.documentElement.clientWidth,
    viewportHeight: document.documentElement.clientHeight,
    headingsTotal: allHeadings.length,
    headings,
    paragraphs,
    fonts,
    images,
    alignment,
    gaps,
    spacing: Array.from(spacing.values()).sort((a, b) => b.count - a.count).slice(0, 200),
  };
})()`;
