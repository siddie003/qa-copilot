/** Query parameters that only track visits and never change page content. */
const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "gclid",
  "fbclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "_ga",
]);

/** File extensions that are resources, not pages: linked to, but never crawled as pages. */
const NON_PAGE_EXTENSIONS =
  /\.(pdf|zip|gz|rar|7z|tar|dmg|exe|msi|apk|png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff?|mp3|mp4|m4a|wav|ogg|webm|mov|avi|woff2?|ttf|otf|eot|css|js|mjs|json|xml|rss|txt|csv|docx?|xlsx?|pptx?)$/i;

/**
 * Canonical form used for de-duplication: lowercase scheme/host, no default port, no fragment,
 * tracking parameters removed, remaining query parameters sorted. Returns null for anything that
 * is not an http(s) URL.
 */
export function normalizeUrl(raw: string, base?: string): string | null {
  let url: URL;
  try {
    url = base ? new URL(raw, base) : new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.hash = "";
  url.username = "";
  url.password = "";
  if (
    (url.protocol === "http:" && url.port === "80") ||
    (url.protocol === "https:" && url.port === "443")
  )
    url.port = "";
  const params = [...url.searchParams.entries()]
    .filter(([k]) => !TRACKING_PARAMS.has(k.toLowerCase()))
    .sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
  url.search = "";
  for (const [k, v] of params) url.searchParams.append(k, v);
  return url.toString();
}

const stripWww = (host: string) => host.toLowerCase().replace(/^www\./, "");

/** Same site = same scheme-agnostic host, treating "www." and the bare domain as one site. */
export function isSameSite(url: string, siteUrl: string): boolean {
  try {
    const a = new URL(url);
    const b = new URL(siteUrl);
    return stripWww(a.hostname) === stripWww(b.hostname) && (a.port || "") === (b.port || "");
  } catch {
    return false;
  }
}

export function looksLikePage(url: string): boolean {
  try {
    return !NON_PAGE_EXTENSIONS.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

export function isHtmlContentType(contentType: string | null | undefined): boolean {
  return /^(text\/html|application\/xhtml\+xml)\b/i.test(contentType ?? "");
}
