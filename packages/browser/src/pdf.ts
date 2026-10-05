import type { Browser } from "playwright";

export interface PdfOptions {
  /** Footer text (plain text; escaped here). Page numbers are added on the right. */
  footer?: string;
  timeoutMs?: number;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Renders a self-contained HTML document to an A4 PDF. The page runs with JavaScript disabled
 * and every network request is aborted, so report content (which includes text from scanned
 * websites) can neither execute code nor make the worker fetch anything.
 */
export async function renderPdf(
  browser: Browser,
  html: string,
  opts: PdfOptions = {},
): Promise<Buffer> {
  const context = await browser.newContext({ javaScriptEnabled: false, offline: true });
  try {
    await context.route("**/*", (route) => route.abort("blockedbyclient"));
    const page = await context.newPage();
    page.setDefaultTimeout(opts.timeoutMs ?? 60_000);
    await page.setContent(html, { waitUntil: "load" });
    const footer = escapeHtml(opts.footer ?? "");
    return await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: "<span></span>",
      footerTemplate: `<div style="width:100%;font-size:7pt;color:#6b7280;padding:0 14mm;display:flex;justify-content:space-between;font-family:system-ui,sans-serif"><span>${footer}</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`,
    });
  } finally {
    await context.close().catch(() => {});
  }
}
