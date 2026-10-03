import { guardedFetch, type FetchOptions, type FetchResult } from "./fetcher";
import { extractLinks, extractTitle, type ExtractedLink } from "./links";
import type { RobotsRules } from "./robots";
import { isHtmlContentType, isSameSite, looksLikePage, normalizeUrl } from "./url";

export interface CrawlOptions {
  startUrl: string;
  maxPages: number;
  maxDepth: number;
  concurrency: number;
  fetch: FetchOptions;
  /** null when robots.txt is not respected for this scan. */
  robots: RobotsRules | null;
  signal?: AbortSignal;
  /**
   * Optional: returns links from the JavaScript-rendered DOM (via a real browser), so sites that
   * build navigation client-side (React, Vue, ...) are crawled too.
   */
  renderLinks?: (url: string) => Promise<string[]>;
}

export interface CrawledPage {
  url: string;
  depth: number;
  discoveredFrom: string | null;
  result: FetchResult | null;
  title: string | null;
  links: ExtractedLink[];
  /** Links found only after JavaScript rendering. */
  renderedOnlyLinks: string[];
  renderError: string | null;
  blockedByRobots: boolean;
  isHtml: boolean;
}

export interface CrawlSummary {
  siteUrl: string;
  pagesFetched: number;
  blockedByRobots: number;
  failed: number;
  limitReached: boolean;
  queuedButNotVisited: number;
  cancelled: boolean;
}

interface QueueItem {
  url: string;
  depth: number;
  from: string | null;
}

/**
 * Breadth-first crawl of one site. Each discovered URL is normalized and visited at most once;
 * only same-site, page-like URLs are followed. `onPage` is awaited for every visited (or
 * robots-blocked) URL so callers can persist results as they arrive.
 */
export async function crawl(
  opts: CrawlOptions,
  onPage: (page: CrawledPage) => Promise<void>,
): Promise<CrawlSummary> {
  const start = normalizeUrl(opts.startUrl);
  if (!start) throw new Error(`Invalid start URL: ${opts.startUrl}`);
  let siteUrl = start;
  const seen = new Set<string>([start]);
  const queue: QueueItem[] = [{ url: start, depth: 0, from: null }];
  const summary: CrawlSummary = {
    siteUrl,
    pagesFetched: 0,
    blockedByRobots: 0,
    failed: 0,
    limitReached: false,
    queuedButNotVisited: 0,
    cancelled: false,
  };
  let active = 0;

  const enqueue = (raw: string, depth: number, from: string) => {
    const n = normalizeUrl(raw);
    if (!n || seen.has(n) || !isSameSite(n, siteUrl) || !looksLikePage(n) || depth > opts.maxDepth)
      return;
    seen.add(n);
    queue.push({ url: n, depth, from });
  };

  const visit = async (item: QueueItem) => {
    if (opts.robots && !opts.robots.isAllowed(item.url)) {
      summary.blockedByRobots += 1;
      await onPage({
        url: item.url,
        depth: item.depth,
        discoveredFrom: item.from,
        result: null,
        title: null,
        links: [],
        renderedOnlyLinks: [],
        renderError: null,
        blockedByRobots: true,
        isHtml: false,
      });
      return;
    }
    summary.pagesFetched += 1;
    const result = await guardedFetch(item.url, { ...opts.fetch, signal: opts.signal });
    if (result.error || (result.status ?? 0) >= 400) summary.failed += 1;

    // The first page decides the site's canonical host (e.g. example.com → www.example.com).
    if (item.depth === 0 && result.status && result.status < 400) {
      const finalNorm = normalizeUrl(result.finalUrl);
      if (finalNorm) {
        siteUrl = finalNorm;
        summary.siteUrl = finalNorm;
        seen.add(finalNorm);
      }
    } else {
      const finalNorm = normalizeUrl(result.finalUrl);
      if (finalNorm) seen.add(finalNorm);
    }

    const isHtml = isHtmlContentType(result.contentType) && result.body !== null;
    const onSite = isSameSite(result.finalUrl, siteUrl);
    let links: ExtractedLink[] = [];
    let title: string | null = null;
    const renderedOnly: string[] = [];
    let renderError: string | null = null;
    if (isHtml && onSite && result.status && result.status < 400) {
      links = extractLinks(result.body!, result.finalUrl);
      title = extractTitle(result.body!);
      if (opts.renderLinks) {
        try {
          const known = new Set(links.map((l) => normalizeUrl(l.url)));
          for (const href of await opts.renderLinks(result.finalUrl)) {
            const n = normalizeUrl(href);
            if (n && !known.has(n)) {
              known.add(n);
              renderedOnly.push(href);
            }
          }
        } catch (err) {
          renderError = (err as Error).message;
        }
      }
      for (const l of links) enqueue(l.url, item.depth + 1, item.url);
      for (const href of renderedOnly) enqueue(href, item.depth + 1, item.url);
    }
    await onPage({
      url: item.url,
      depth: item.depth,
      discoveredFrom: item.from,
      result,
      title,
      links,
      renderedOnlyLinks: renderedOnly,
      renderError,
      blockedByRobots: false,
      isHtml,
    });
  };

  await new Promise<void>((resolve, reject) => {
    const pump = () => {
      if (opts.signal?.aborted) summary.cancelled = true;
      while (!summary.cancelled && active < opts.concurrency && queue.length > 0) {
        if (summary.pagesFetched + active >= opts.maxPages) {
          summary.limitReached = true;
          break;
        }
        const item = queue.shift()!;
        active += 1;
        visit(item)
          .then(() => {
            active -= 1;
            pump();
          })
          .catch(reject);
      }
      if (active === 0 && (queue.length === 0 || summary.limitReached || summary.cancelled))
        resolve();
    };
    pump();
  });
  summary.queuedButNotVisited = queue.length;
  return summary;
}
