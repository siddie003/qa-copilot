// Scripts collecting reference-comparison data inside the scanned page. Plain strings on purpose
// (see page-scripts.ts: tsx/esbuild rewrites named functions with a `__name()` helper that does
// not exist in the browser). They only read the page; nothing is modified.

const HELPERS = `
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
  const query = (sel) => { try { return Array.prototype.slice.call(document.querySelectorAll(sel)); } catch (e) { return null; } };
`;

/**
 * Computed styles of the elements each design role maps to (headings, body text, links, buttons,
 * header, footer, page, container, plus explicit selectors from the design reference), grouped
 * into style variants with an example element, the colors used on the page and web-font status.
 */
export function designStylesScript(explicitSelectors: string[]): string {
  return `(() => {
  ${HELPERS}
  const transparent = (c) => !c || c === "transparent" || /rgba\\([^)]*,\\s*0\\)$/.test(c);
  const effectiveBackground = (el) => {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const bg = getComputedStyle(n).backgroundColor;
      if (!transparent(bg)) return bg;
    }
    return "rgb(255, 255, 255)";
  };
  const STYLE_KEYS = ["color", "backgroundColor", "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "borderTopLeftRadius", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "maxWidth"];
  const stylesOf = (el) => {
    const cs = getComputedStyle(el);
    const out = {};
    for (const k of STYLE_KEYS) out[k] = cs[k];
    out.effectiveBackground = effectiveBackground(el);
    return out;
  };
  const outside = (el, sel) => !el.closest(sel);
  const sampleRole = (elements, method, selector) => {
    const els = (elements || []).filter(isVisible).slice(0, 300);
    const groups = new Map();
    for (const el of els) {
      const styles = stylesOf(el);
      const key = JSON.stringify(styles);
      const g = groups.get(key);
      if (g) g.count += 1;
      else groups.set(key, { count: 1, styles, sample: { selector: cssPath(el), text: clean(el.textContent, 80), box: box(el) } });
    }
    const variants = Array.from(groups.values()).sort((a, b) => b.count - a.count).slice(0, 6);
    return { method: els.length ? method : "none", selector, count: els.length, variants };
  };
  const firstNonEmpty = (candidates) => {
    for (const [sel, filter] of candidates) {
      const els = (query(sel) || []).filter((e) => isVisible(e) && (!filter || filter(e)));
      if (els.length) return { sel, els };
    }
    return { sel: candidates[0][0], els: [] };
  };
  const notChrome = (e) => outside(e, "nav, header, footer, [role=navigation], [role=banner], [role=contentinfo]");
  const buttonLike = (e) => e.matches("button, [role=button], input[type=submit], input[type=button]") || /(^|[\\s_-])(btn|button)([\\s_-]|$)/i.test(e.className || "");

  const roles = {};
  for (let i = 1; i <= 6; i++) roles["h" + i] = sampleRole(query("h" + i), "semantic", "h" + i);
  const body = firstNonEmpty([["main p, article p, [role=main] p", notChrome], ["body p", notChrome]]);
  roles.body = sampleRole(body.els, "semantic", body.sel);
  const link = firstNonEmpty([["main p a[href], main li a[href], article p a[href], [role=main] p a[href]", (e) => notChrome(e) && !buttonLike(e)], ["body p a[href]", (e) => notChrome(e) && !buttonLike(e)]]);
  roles.link = sampleRole(link.els, "semantic", link.sel);
  const buttons = (query("button, [role=button], input[type=submit], input[type=button], a[href]") || []).filter((e) => isVisible(e) && buttonLike(e));
  roles.button = sampleRole(buttons, "semantic", "button, [role=button], .btn, .button");
  const variantSel = (v) => ".btn-" + v + ", .button-" + v + ", .btn--" + v + ", .button--" + v + ", ." + v + "-button, ." + v + "-btn, [data-variant=" + v + "], [class*=btn-" + v + "], [class*=button-" + v + "]";
  roles.buttonPrimary = sampleRole(query(variantSel("primary")), "heuristic", variantSel("primary"));
  roles.buttonSecondary = sampleRole(query(variantSel("secondary")), "heuristic", variantSel("secondary"));
  const topLevel = (e) => outside(e.parentElement || document.body, "article, section, main, aside, [role=main]");
  roles.header = sampleRole((query("header, [role=banner]") || []).filter(topLevel).slice(0, 1), "semantic", "header, [role=banner]");
  roles.footer = sampleRole((query("footer, [role=contentinfo]") || []).filter(topLevel).slice(0, 1), "semantic", "footer, [role=contentinfo]");
  roles.page = sampleRole(document.body ? [document.body] : [], "semantic", "body");
  const containers = (query(".container, .wrapper, .site-container, .content-container, .page-container, main, main > div, [role=main]") || [])
    .filter((e) => isVisible(e) && getComputedStyle(e).maxWidth !== "none");
  roles.container = sampleRole(containers.slice(0, 1), "heuristic", ".container, .wrapper, main (with max-width)");

  const explicit = {};
  for (const sel of ${JSON.stringify(explicitSelectors)}) {
    const els = query(sel);
    explicit[sel] = els === null ? { error: "invalid selector", method: "none", selector: sel, count: 0, variants: [] } : sampleRole(els, "explicit", sel);
  }

  // Colors used on the page: text colors of elements with their own text, and backgrounds.
  const textColors = new Map();
  const bgColors = new Map();
  const add = (map, color, el) => {
    const e = map.get(color);
    if (e) e.count += 1;
    else map.set(color, { color, count: 1, sample: cssPath(el) });
  };
  const all = Array.prototype.slice.call(document.body ? document.body.querySelectorAll("*") : [], 0, 4000);
  for (const el of all) {
    // Native form controls carry the browser's default colors, not the site's palette.
    if (!isVisible(el) || el.closest("button, input, select, textarea, option")) continue;
    const cs = getComputedStyle(el);
    const ownText = Array.prototype.some.call(el.childNodes, (n) => n.nodeType === 3 && n.textContent.trim().length > 0);
    if (ownText) add(textColors, cs.color, el);
    const r = el.getBoundingClientRect();
    if (!transparent(cs.backgroundColor) && r.width * r.height >= 100) add(bgColors, cs.backgroundColor, el);
  }
  const top = (map) => Array.from(map.values()).sort((a, b) => b.count - a.count).slice(0, 40);
  const fonts = [];
  try { document.fonts.forEach((f) => { if (fonts.length < 50) fonts.push({ family: f.family.replace(/^["']|["']$/g, ""), status: f.status, weight: f.weight, style: f.style }); }); } catch (e) {}
  return { viewportWidth: document.documentElement.clientWidth, roles, explicit, palette: { text: top(textColors), background: top(bgColors) }, fonts };
})()`;
}

/**
 * Visible text of the page as blocks (the nearest block-level container of each text node),
 * plus visible links and buttons with their targets. Uses textContent of visible elements, so
 * CSS text-transform does not change the compared wording.
 */
export const TEXT_BLOCKS_SCRIPT = `(() => {
  ${HELPERS}
  const INLINE = new Set(["inline", "inline-block", "contents"]);
  const containerOf = (el) => {
    let n = el;
    while (n && n !== document.body) {
      const tag = n.tagName.toLowerCase();
      if (/^(h[1-6]|p|li|td|th|dt|dd|figcaption|blockquote|button|label|summary|caption|legend)$/.test(tag)) return n;
      if (!INLINE.has(getComputedStyle(n).display)) return n;
      n = n.parentElement;
    }
    return document.body;
  };
  const seen = new Set();
  const blocks = [];
  if (document.body) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (t) => {
        if (!t.textContent || !t.textContent.trim()) return NodeFilter.FILTER_REJECT;
        const p = t.parentElement;
        if (!p || p.closest("script, style, noscript, template, svg")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    while (walker.nextNode() && blocks.length < 3000) {
      const el = containerOf(walker.currentNode.parentElement);
      if (seen.has(el)) continue;
      seen.add(el);
      if (!isVisible(el)) continue;
      const text = clean(el.textContent, 2000);
      if (text) blocks.push({ tag: el.tagName.toLowerCase(), text, selector: cssPath(el) });
    }
  }
  const links = (query("a[href], button, [role=button], input[type=submit], input[type=button]") || [])
    .filter(isVisible)
    .slice(0, 1000)
    .map((el) => ({
      kind: el.tagName === "A" ? "link" : "button",
      text: clean(el.tagName === "INPUT" ? el.value : (el.textContent || el.getAttribute("aria-label") || ""), 300),
      href: el.tagName === "A" ? el.href : null,
      selector: cssPath(el),
    }))
    .filter((l) => l.text);
  return { title: document.title, blocks, links };
})()`;
