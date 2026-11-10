// Scripts executed inside the scanned page. They are plain strings on purpose: TypeScript runners
// (tsx/esbuild) rewrite named functions with a `__name()` helper that does not exist in the
// browser, which breaks functions passed to page.evaluate. Strings are sent exactly as written.

import { IN_CONSENT } from "./consent";

/**
 * Installed before any page script runs: records lab Core Web Vitals with PerformanceObserver.
 * TBT is approximated as the sum of (long task duration − 50 ms) observed until measurement.
 */
export const VITALS_INIT_SCRIPT = `(() => {
  const s = (window.__qaVitals = { lcp: null, lcpElement: null, cls: 0, longTasks: 0, tbt: 0 });
  try {
    new PerformanceObserver((list) => {
      const entries = list.getEntries();
      const last = entries[entries.length - 1];
      if (last) {
        s.lcp = last.renderTime || last.loadTime || last.startTime;
        s.lcpElement = last.element ? last.element.tagName.toLowerCase() : null;
      }
    }).observe({ type: "largest-contentful-paint", buffered: true });
  } catch (e) {}
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (!e.hadRecentInput) s.cls += e.value;
    }).observe({ type: "layout-shift", buffered: true });
  } catch (e) {}
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        s.longTasks += 1;
        s.tbt += Math.max(0, e.duration - 50);
      }
    }).observe({ type: "longtask", buffered: true });
  } catch (e) {}
})();`;

/**
 * Collected after load: vitals, layout problems (overflow, clipping, overlaps, tap targets,
 * small text), images and render-blocking resources. Each item carries a CSS selector so
 * findings can point at the exact element.
 */
export const METRICS_SCRIPT = `(() => {
  const de = document.documentElement;
  const vw = de.clientWidth;
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
  const box = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), width: Math.round(r.width), height: Math.round(r.height) }; };
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0;
  };
  ${IN_CONSENT}
  // Cookie-consent overlays are third-party and temporary: not part of the page layout.
  const all = Array.prototype.slice.call(document.body ? document.body.querySelectorAll("*") : []).filter((el) => !inConsent(el));

  // Horizontal overflow and the outermost elements that cause it.
  const overflowPx = Math.max(0, de.scrollWidth - vw);
  const overflowElements = [];
  if (overflowPx > 1) {
    for (const el of all) {
      if (overflowElements.length >= 10) break;
      const r = el.getBoundingClientRect();
      if (r.right <= vw + 1 || !isVisible(el) || getComputedStyle(el).position === "fixed") continue;
      const p = el.parentElement;
      if (p && p !== document.body && p.getBoundingClientRect().right > vw + 1) continue;
      overflowElements.push({ selector: cssPath(el), right: Math.round(r.right), width: Math.round(r.width), box: box(el) });
    }
  }

  // Text cut off by overflow:hidden (ellipsis is intentional truncation and is not reported).
  const clippedText = [];
  for (const el of all) {
    if (clippedText.length >= 10) break;
    const cs = getComputedStyle(el);
    const hides = ["hidden", "clip"].includes(cs.overflowX) || ["hidden", "clip"].includes(cs.overflow);
    if (!hides || cs.textOverflow === "ellipsis") continue;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || !isVisible(el)) continue;
    const text = (el.textContent || "").replace(/\\s+/g, " ").trim();
    if (!text || el.children.length > 3) continue;
    const clipsX = el.scrollWidth > el.clientWidth + 2;
    const clipsY = el.scrollHeight > el.clientHeight + 2;
    // Reveal animations hide each word in an overflow:hidden mask and move it in with a transform
    // when the visitor scrolls to it; content moved out by a transform is not cut-off text.
    const moved = () =>
      Array.prototype.some.call(el.querySelectorAll("*"), (c) => getComputedStyle(c).transform !== "none");
    if (clipsX || (clipsY && !moved()))
      clippedText.push({ selector: cssPath(el), text: text.slice(0, 120), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, box: box(el) });
  }

  // Interactive elements: small targets (WCAG 2.5.8, 24×24 CSS px) and overlaps.
  const interactive = Array.prototype.slice
    .call(document.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=link]'))
    .filter((el) => isVisible(el) && !inConsent(el))
    .slice(0, 400);
  const smallTargets = [];
  for (const el of interactive) {
    if (smallTargets.length >= 20) break;
    const cs = getComputedStyle(el);
    // Links inside running text are exempt from the target-size criterion.
    if (el.tagName === "A" && cs.display === "inline") continue;
    const r = el.getBoundingClientRect();
    if (r.width < 24 || r.height < 24)
      smallTargets.push({ selector: cssPath(el), width: Math.round(r.width), height: Math.round(r.height), label: (el.getAttribute("aria-label") || el.textContent || el.getAttribute("value") || "").trim().slice(0, 60), box: box(el) });
  }
  const overlaps = [];
  for (let i = 0; i < interactive.length && overlaps.length < 10; i++) {
    const a = interactive[i];
    const ra = a.getBoundingClientRect();
    for (let j = i + 1; j < interactive.length && overlaps.length < 10; j++) {
      const b = interactive[j];
      if (a.contains(b) || b.contains(a)) continue;
      const rb = b.getBoundingClientRect();
      const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (w <= 0 || h <= 0) continue;
      const smaller = Math.min(ra.width * ra.height, rb.width * rb.height);
      if (smaller > 0 && (w * h) / smaller > 0.25)
        overlaps.push({ a: cssPath(a), b: cssPath(b), overlapRatio: Math.round(((w * h) / smaller) * 100) / 100, boxA: box(a), boxB: box(b) });
    }
  }

  // Text rendered smaller than 12 CSS px.
  const smallText = { count: 0, samples: [] };
  for (const el of all) {
    const own = Array.prototype.some.call(el.childNodes, (n) => n.nodeType === 3 && n.textContent.trim().length > 1);
    if (!own || !isVisible(el)) continue;
    const size = parseFloat(getComputedStyle(el).fontSize);
    if (size < 12) {
      smallText.count += 1;
      if (smallText.samples.length < 5) smallText.samples.push({ selector: cssPath(el), fontSizePx: size, text: el.textContent.trim().slice(0, 60) });
    }
  }

  const images = Array.prototype.slice.call(document.images, 0, 150).map((img) => {
    const r = img.getBoundingClientRect();
    return {
      src: img.currentSrc || img.src,
      selector: cssPath(img),
      alt: img.getAttribute("alt"),
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      renderedWidth: Math.round(r.width),
      renderedHeight: Math.round(r.height),
      broken: img.complete && img.naturalWidth === 0 && !!(img.currentSrc || img.src),
      loading: img.getAttribute("loading"),
    };
  });

  const head = document.head;
  const renderBlocking = [];
  if (head) {
    for (const s of head.querySelectorAll("script[src]"))
      if (!s.async && !s.defer && s.type !== "module") renderBlocking.push({ type: "script", url: s.src });
    for (const l of head.querySelectorAll('link[rel~="stylesheet"]'))
      if (!l.disabled && (!l.media || l.media === "all" || l.media === "screen")) renderBlocking.push({ type: "stylesheet", url: l.href });
  }

  const vitals = window.__qaVitals || null;
  const viewportMeta = document.querySelector('meta[name="viewport"]');
  return {
    viewportWidth: vw,
    viewportHeight: de.clientHeight,
    documentWidth: de.scrollWidth,
    documentHeight: de.scrollHeight,
    overflowPx,
    overflowElements,
    clippedText,
    smallTargets,
    overlaps,
    smallText,
    images,
    renderBlocking,
    viewportMeta: viewportMeta ? viewportMeta.getAttribute("content") : null,
    vitals: vitals
      ? { lcpMs: vitals.lcp === null ? null : Math.round(vitals.lcp), lcpElement: vitals.lcpElement, cls: Math.round(vitals.cls * 1000) / 1000, tbtMs: Math.round(vitals.tbt), longTasks: vitals.longTasks }
      : null,
  };
})()`;
