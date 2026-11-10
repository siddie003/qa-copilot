import type { Page } from "playwright";

export interface RenderedFontTarget {
  kind: "heading" | "paragraph";
  /** Index into document.querySelectorAll(query) (as recorded by DESIGN_QUALITY_SCRIPT). */
  index: number;
  query: string;
}

export interface RenderedFontSample extends RenderedFontTarget {
  /** Computed font-family of the element that holds the first text (what CSS asked for). */
  declared: string | null;
  /**
   * Fonts Chromium's font engine actually used for that element's text (DevTools protocol
   * CSS.getPlatformFontsForNode): family name, whether it came from a web font, glyph count.
   */
  fonts: Array<{
    familyName: string;
    postScriptName: string | null;
    isCustomFont: boolean;
    glyphCount: number;
  }>;
  error: string | null;
}

// The element holding the first non-empty text inside the target (headings often wrap their text
// in spans; the font engine reports fonts for an element's own text nodes).
const TEXT_HOLDER = `function () {
  const w = document.createTreeWalker(this, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = w.nextNode())) if (n.textContent && n.textContent.trim()) return n.parentElement;
  return this;
}`;

/**
 * Asks Chromium which fonts it used to render the text of the given elements. Read-only: uses the
 * DevTools protocol on the already-loaded page. Returns an error instead of throwing (the check is
 * then reported as not verifiable).
 */
export async function collectRenderedFonts(
  page: Page,
  targets: RenderedFontTarget[],
): Promise<{ samples: RenderedFontSample[]; error: string | null }> {
  if (!targets.length) return { samples: [], error: null };
  let cdp;
  try {
    cdp = await page.context().newCDPSession(page);
  } catch (err) {
    return { samples: [], error: `DevTools session unavailable: ${(err as Error).message}` };
  }
  const samples: RenderedFontSample[] = [];
  try {
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    await cdp.send("DOM.getDocument", { depth: 0 });
    for (const t of targets) {
      const sample: RenderedFontSample = { ...t, declared: null, fonts: [], error: null };
      try {
        const found = await cdp.send("Runtime.evaluate", {
          expression: `document.querySelectorAll(${JSON.stringify(t.query)})[${Number(t.index)}] || null`,
        });
        const objectId = found.result.objectId;
        if (!objectId) throw new Error("element no longer present");
        const holder = await cdp.send("Runtime.callFunctionOn", {
          objectId,
          functionDeclaration: TEXT_HOLDER,
        });
        const holderId = holder.result.objectId ?? objectId;
        const family = await cdp.send("Runtime.callFunctionOn", {
          objectId: holderId,
          functionDeclaration: "function () { return getComputedStyle(this).fontFamily; }",
          returnByValue: true,
        });
        sample.declared = typeof family.result.value === "string" ? family.result.value : null;
        const { nodeId } = await cdp.send("DOM.requestNode", { objectId: holderId });
        const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
        sample.fonts = fonts.map((f) => ({
          familyName: f.familyName,
          postScriptName: f.postScriptName ?? null,
          isCustomFont: f.isCustomFont,
          glyphCount: f.glyphCount,
        }));
      } catch (err) {
        sample.error = (err as Error).message.split("\n")[0]!.slice(0, 200);
      }
      samples.push(sample);
    }
    return { samples, error: null };
  } catch (err) {
    return { samples, error: (err as Error).message.split("\n")[0]!.slice(0, 200) };
  } finally {
    await cdp.detach().catch(() => {});
  }
}
