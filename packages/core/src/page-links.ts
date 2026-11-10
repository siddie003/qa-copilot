/**
 * Page links: specific pages of the project's website that the user wants included in every scan
 * (in addition to the pages the crawler discovers). Browser-safe: the wizard validates as the user
 * types; the server validates again (plus the SSRF rules in @qa/security) before storing.
 */

export type PageLinkCheck =
  { ok: true; url: string; path: string } | { ok: false; message: string };

const stripWww = (host: string) => host.toLowerCase().replace(/^www\./, "");

/** File types that are resources, not pages (kept in step with the crawler's list). */
const NON_PAGE =
  /\.(pdf|zip|gz|rar|7z|tar|dmg|exe|msi|apk|png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff?|mp3|mp4|m4a|wav|ogg|webm|mov|avi|woff2?|ttf|otf|eot|css|js|mjs|json|xml|rss|txt|csv|docx?|xlsx?|pptx?)$/i;

/**
 * Validates one page link against the project's website: a full URL or a path such as "/about"
 * (resolved against the website). Same site only ("www." and the bare domain count as one site,
 * as in the crawler). Returns the normalized URL (no fragment, default port removed) and its path.
 */
export function checkPageLink(raw: string, websiteUrl: string): PageLinkCheck {
  const v = raw.trim();
  if (!v) return { ok: false, message: "Enter a page URL, for example https://example.com/about." };
  let site: URL;
  try {
    site = new URL(websiteUrl);
  } catch {
    return { ok: false, message: "Enter the website URL first." };
  }
  let url: URL;
  try {
    if (v.startsWith("/")) url = new URL(v, site.origin);
    else url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(v) ? v : `https://${v}`);
  } catch {
    return { ok: false, message: "This is not a valid URL." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return { ok: false, message: "Only http:// and https:// page addresses are supported." };
  if (url.username || url.password)
    return {
      ok: false,
      message:
        "Remove the user name or password from the URL; add site credentials in project settings instead.",
    };
  const host = url.hostname.toLowerCase();
  if (host === "figma.com" || host.endsWith(".figma.com"))
    return {
      ok: false,
      message:
        "This is a Figma link. Page links are pages of the live website; the Figma link belongs in the Figma design URL field.",
    };
  if (stripWww(host) !== stripWww(site.hostname) || url.port !== site.port)
    return {
      ok: false,
      message: `This page is on a different website (${url.host}). Page links must be pages of ${site.host}.`,
    };
  if (NON_PAGE.test(url.pathname))
    return { ok: false, message: "This links to a file, not a web page." };
  url.hash = "";
  if (!v.startsWith("/") && !/^[a-z][a-z\d+.-]*:\/\//i.test(v)) url.protocol = site.protocol;
  return { ok: true, url: url.toString(), path: `${url.pathname}${url.search}` };
}

/** Identity used to detect duplicate page links (host without www, path, sorted query). */
export function pageLinkKey(url: string): string {
  try {
    const u = new URL(url);
    const params = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
    const q = params.length ? `?${new URLSearchParams(params).toString()}` : "";
    const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : u.pathname;
    return `${stripWww(u.hostname)}${u.port ? `:${u.port}` : ""}${path}${q}`;
  } catch {
    return url;
  }
}
