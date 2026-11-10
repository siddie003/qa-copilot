import { guardedFetch } from "@qa/crawler";
import * as cheerio from "cheerio";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { Severity } from "@qa/core";
import type {
  CheckSummary,
  EvidenceDraft,
  FindingDraft,
  PageRecord,
  Scanner,
  ScannerContext,
  Verdict,
} from "./types";
import { analyzablePages, captureFor, displayUrl, header, sample, truncate } from "./util";

const TITLE_MIN = 10;
const TITLE_MAX = 60;
const DESC_MIN = 50;
const DESC_MAX = 160;

interface PageFacts {
  p: PageRecord;
  url: string;
  source: "rendered DOM" | "served HTML";
  title: string | null;
  description: string | null;
  h1: string[];
  headingSequence: number[];
  canonical: string[];
  robotsMeta: string | null;
  lang: string | null;
  viewport: string | null;
  imagesWithoutAlt: string[];
  og: Record<string, string | null>;
  jsonLd: Array<{ ok: boolean; error?: string; snippet: string }>;
}

async function factsFor(p: PageRecord, desktopViewport: string): Promise<PageFacts | null> {
  const rendered = await captureFor(p, desktopViewport)?.loadDom();
  const raw = rendered ? null : await p.loadRawHtml();
  const html = rendered ?? raw;
  if (!html) return null;
  const $ = cheerio.load(html);
  const text = (sel: string) => $(sel).first().text().replace(/\s+/g, " ").trim() || null;
  const meta = (name: string) =>
    $(`meta[name="${name}" i]`).first().attr("content")?.trim() ?? null;
  const prop = (name: string) =>
    $(`meta[property="${name}" i]`).first().attr("content")?.trim() ?? null;
  return {
    p,
    url: displayUrl(p),
    source: rendered ? "rendered DOM" : "served HTML",
    title: text("head > title") ?? text("title"),
    description: meta("description"),
    h1: $("h1")
      .map((_, el) => $(el).text().replace(/\s+/g, " ").trim())
      .get(),
    headingSequence: $("h1, h2, h3, h4, h5, h6")
      .map((_, el) => Number(el.tagName.slice(1)))
      .get(),
    canonical: $('link[rel="canonical" i]')
      .map((_, el) => $(el).attr("href") ?? "")
      .get(),
    robotsMeta: meta("robots"),
    lang: $("html").attr("lang")?.trim() || null,
    viewport: meta("viewport"),
    imagesWithoutAlt: $("img:not([alt])")
      .map((_, el) => truncate($.html(el) ?? "", 200))
      .get(),
    og: {
      "og:title": prop("og:title"),
      "og:description": prop("og:description"),
      "og:image": prop("og:image"),
    },
    jsonLd: $('script[type="application/ld+json" i]')
      .map((_, el) => {
        const body = $(el).text();
        try {
          JSON.parse(body);
          return { ok: true, snippet: truncate(body.trim(), 200) };
        } catch (err) {
          return { ok: false, error: (err as Error).message, snippet: truncate(body.trim(), 300) };
        }
      })
      .get(),
  };
}

function pageFinding(
  f: PageFacts,
  ruleId: string,
  title: string,
  message: string,
  severity: Severity,
  verdict: Verdict,
  expected: string,
  actual: string,
  data: Record<string, unknown>,
  extra: Partial<FindingDraft> = {},
): FindingDraft {
  const evidence: EvidenceDraft[] = [
    { kind: "document", data: { url: f.url, source: f.source, ...data } },
  ];
  return {
    ruleId,
    title,
    message,
    subcategory: "on-page",
    pageId: f.p.id,
    pageUrl: f.url,
    severity,
    verdict,
    confidence: verdict === "confirmed" ? 0.95 : 0.7,
    expected,
    actual,
    evidence,
    ...extra,
  };
}

export const seoScanner: Scanner = {
  key: "seo",
  idPrefix: "SEO",
  version: "1.0.0",
  async run(ctx: ScannerContext) {
    const checks: CheckSummary = { evaluated: 0, inconclusive: [] };
    const findings: FindingDraft[] = [];
    const desktop = ctx.viewports[0]?.name ?? "desktop";
    const facts: PageFacts[] = [];
    for (const p of analyzablePages(ctx.pages)) {
      const f = await factsFor(p, desktop);
      if (f) facts.push(f);
      else
        checks.inconclusive.push({
          check: "On-page SEO",
          reason: "Page HTML not available",
          pageUrl: displayUrl(p),
        });
    }

    for (const f of facts) {
      checks.evaluated += 12;
      // Title
      if (!f.title)
        findings.push(
          pageFinding(
            f,
            "title-missing",
            "Page has no title",
            "The page has no <title>. Search engines show the title as the result headline.",
            "high",
            "confirmed",
            "A unique, descriptive <title>",
            "No <title> element",
            { title: null },
          ),
        );
      else if (f.title.length < TITLE_MIN || f.title.length > TITLE_MAX)
        findings.push(
          pageFinding(
            f,
            "title-length",
            `Title is ${f.title.length < TITLE_MIN ? "very short" : "longer than about 60 characters"}`,
            `The title has ${f.title.length} characters; titles outside ${TITLE_MIN}–${TITLE_MAX} characters are often unhelpful or truncated in search results.`,
            "low",
            "potential",
            `${TITLE_MIN}–${TITLE_MAX} characters`,
            `${f.title.length} characters: “${f.title}”`,
            { title: f.title, length: f.title.length },
          ),
        );
      // Description
      if (!f.description)
        findings.push(
          pageFinding(
            f,
            "meta-description-missing",
            "Meta description is missing",
            "Without a meta description, search engines choose a snippet themselves.",
            "medium",
            "confirmed",
            '<meta name="description"> with 50–160 characters',
            "No meta description",
            { description: null },
          ),
        );
      else if (f.description.length < DESC_MIN || f.description.length > DESC_MAX)
        findings.push(
          pageFinding(
            f,
            "meta-description-length",
            "Meta description length is outside the recommended range",
            `The description has ${f.description.length} characters (recommended ${DESC_MIN}–${DESC_MAX}).`,
            "low",
            "potential",
            `${DESC_MIN}–${DESC_MAX} characters`,
            `${f.description.length} characters: “${truncate(f.description, 200)}”`,
            { description: f.description, length: f.description.length },
          ),
        );
      // Headings
      if (f.h1.length === 0)
        findings.push(
          pageFinding(
            f,
            "h1-missing",
            "Page has no H1 heading",
            "The page has no top-level heading describing its content.",
            "medium",
            "confirmed",
            "Exactly one <h1>",
            "No <h1>",
            { h1: [] },
          ),
        );
      else if (f.h1.length > 1)
        findings.push(
          pageFinding(
            f,
            "h1-multiple",
            "Page has more than one H1 heading",
            `The page has ${f.h1.length} <h1> elements, which blurs the main topic.`,
            "low",
            "confirmed",
            "Exactly one <h1>",
            `${f.h1.length} <h1> elements: ${f.h1.map((h) => `“${truncate(h, 60)}”`).join(", ")}`,
            { h1: f.h1 },
          ),
        );
      const skipAt = f.headingSequence.findIndex(
        (lvl, i) => i > 0 && lvl > f.headingSequence[i - 1]! + 1,
      );
      if (skipAt > 0)
        findings.push(
          pageFinding(
            f,
            "heading-level-skipped",
            "Heading levels are skipped",
            `The heading outline jumps from H${f.headingSequence[skipAt - 1]} to H${f.headingSequence[skipAt]}.`,
            "low",
            "confirmed",
            "Headings that descend one level at a time",
            `H${f.headingSequence[skipAt - 1]} followed by H${f.headingSequence[skipAt]}`,
            { headingSequence: f.headingSequence.map((l) => `h${l}`) },
          ),
        );
      // Indexability
      const xRobots = header(f.p, "x-robots-tag");
      if (/noindex/i.test(f.robotsMeta ?? "") || /noindex/i.test(xRobots ?? ""))
        findings.push(
          pageFinding(
            f,
            "noindex",
            "Page is excluded from search engines (noindex)",
            "The page asks search engines not to index it. This is correct for private pages and a serious problem for pages meant to be found.",
            "medium",
            "potential",
            "Indexable unless intentionally hidden",
            `meta robots: ${f.robotsMeta ?? "—"}; X-Robots-Tag: ${xRobots ?? "—"}`,
            { robotsMeta: f.robotsMeta, xRobotsTag: xRobots },
          ),
        );
      if (f.canonical.length > 1)
        findings.push(
          pageFinding(
            f,
            "canonical-multiple",
            "Page declares more than one canonical URL",
            "Conflicting canonical links are ignored by search engines.",
            "medium",
            "confirmed",
            "One rel=canonical link",
            `${f.canonical.length}: ${f.canonical.join(", ")}`,
            { canonical: f.canonical },
          ),
        );
      if (!f.lang)
        findings.push(
          pageFinding(
            f,
            "html-lang-missing",
            "Page language is not declared",
            "<html> has no lang attribute, which helps search engines and screen readers.",
            "low",
            "confirmed",
            '<html lang="…">',
            "No lang attribute",
            { lang: null },
          ),
        );
      if (!f.viewport)
        findings.push(
          pageFinding(
            f,
            "viewport-meta-missing",
            "Mobile viewport is not configured",
            'Without <meta name="viewport">, mobile browsers render a zoomed-out desktop page; search engines rank such pages lower on mobile.',
            "medium",
            "confirmed",
            '<meta name="viewport" content="width=device-width, initial-scale=1">',
            "No viewport meta tag",
            { viewport: null },
          ),
        );
      if (f.imagesWithoutAlt.length)
        findings.push(
          pageFinding(
            f,
            "img-alt-attribute-missing",
            "Images without an alt attribute",
            `${f.imagesWithoutAlt.length} image(s) have no alt attribute, so search engines cannot understand them.`,
            "low",
            "confirmed",
            'alt text on every content image (alt="" for decorative ones)',
            `${f.imagesWithoutAlt.length} image(s) without alt`,
            { images: sample(f.imagesWithoutAlt, 5) },
          ),
        );
      for (const j of f.jsonLd.filter((x) => !x.ok))
        findings.push(
          pageFinding(
            f,
            "structured-data-invalid",
            "Structured data (JSON-LD) cannot be parsed",
            `A JSON-LD block is not valid JSON (${j.error}), so search engines ignore it.`,
            "medium",
            "confirmed",
            'Valid JSON in <script type="application/ld+json">',
            truncate(j.error ?? "parse error", 200),
            { error: j.error, snippet: j.snippet },
            { fingerprintKey: j.snippet.slice(0, 60) },
          ),
        );
    }

    // Duplicate titles and descriptions across pages.
    for (const [field, ruleId, label, severity] of [
      ["title", "title-duplicate", "title", "medium"],
      ["description", "meta-description-duplicate", "meta description", "low"],
    ] as const) {
      const groups = new Map<string, PageFacts[]>();
      for (const f of facts) {
        const v = f[field];
        if (v) groups.set(v, [...(groups.get(v) ?? []), f]);
      }
      for (const [value, group] of groups) {
        if (group.length < 2) continue;
        findings.push({
          ruleId,
          title: `Duplicate ${label} on ${group.length} pages`,
          message: `${group.length} crawled pages share the same ${label}, so search engines cannot tell them apart. (Compared across the crawled pages only.)`,
          subcategory: "duplicates",
          pageId: null,
          pageUrl: group[0]!.url,
          severity,
          verdict: "confirmed",
          confidence: 0.95,
          expected: `A unique ${label} per page`,
          actual: `“${truncate(value, 120)}” on ${group.length} pages`,
          fingerprintKey: value,
          evidence: [{ kind: "document", data: { value, pages: group.map((g) => g.url) } }],
        });
      }
    }

    // Site-wide: rules that are usually all-or-nothing across a site.
    const aggregate = (
      ruleId: string,
      title: string,
      failing: PageFacts[],
      severity: Severity,
      expected: string,
      actual: string,
      message: string,
    ) => {
      if (!failing.length) return;
      const s = sample(
        failing.map((f) => f.url),
        10,
      );
      findings.push({
        ruleId,
        title,
        message: `${message} (${failing.length} of ${facts.length} pages)`,
        subcategory: "site",
        pageId: failing.length === 1 ? failing[0]!.p.id : null,
        pageUrl: failing.length === 1 ? failing[0]!.url : ctx.siteUrl,
        severity,
        verdict: "confirmed",
        confidence: 0.9,
        expected,
        actual,
        evidence: [{ kind: "document", data: { pages: s.items, omitted: s.omitted } }],
      });
    };
    aggregate(
      "canonical-missing",
      "Pages do not declare a canonical URL",
      facts.filter((f) => f.canonical.length === 0),
      "low",
      '<link rel="canonical" href="…">',
      "No rel=canonical",
      "Without a canonical URL, duplicate URLs (tracking parameters, trailing slashes) compete in search results.",
    );
    const ogFailing = facts.filter((f) => Object.values(f.og).some((v) => !v));
    // Name the tags that are absent: often only og:image is missing, not Open Graph as a whole.
    const ogMissing = Object.keys(facts[0]?.og ?? {}).filter((tag) =>
      ogFailing.some((f) => !f.og[tag]),
    );
    const ogAll = ogMissing.length === Object.keys(facts[0]?.og ?? {}).length;
    aggregate(
      "open-graph-missing",
      ogAll ? "Open Graph tags are missing" : `Open Graph tag missing: ${ogMissing.join(", ")}`,
      ogFailing,
      "low",
      "og:title, og:description and og:image",
      `Missing: ${ogMissing.join(", ")}`,
      `Missing ${ogMissing.join(", ")}, so links shared on social networks and chat apps ${ogMissing.includes("og:image") ? "show no preview image" : "do not have a complete preview"}.`,
    );
    aggregate(
      "structured-data-absent",
      "No structured data (JSON-LD)",
      facts.filter((f) => f.jsonLd.length === 0),
      "info",
      "Relevant schema.org markup (Organization, Product, Article, …)",
      "No JSON-LD found",
      "Structured data enables rich results in search engines.",
    );
    const badUrls = facts.filter((f) => {
      const u = new URL(f.url);
      return (
        /[A-Z]/.test(u.pathname) ||
        u.pathname.includes("_") ||
        f.url.length > 115 ||
        [...u.searchParams.keys()].length > 3
      );
    });
    aggregate(
      "url-structure",
      "URLs are hard to read or share",
      badUrls,
      "low",
      "Short, lowercase, hyphen-separated URLs",
      badUrls
        .slice(0, 3)
        .map((f) => f.url)
        .join(", "),
      "URLs with uppercase letters, underscores, many parameters or over 115 characters are harder to use and to rank.",
    );

    // robots.txt and sitemap.
    checks.evaluated += 2;
    if (ctx.robots?.status === "missing")
      findings.push({
        ruleId: "robots-txt-missing",
        title: "robots.txt is missing",
        message:
          "The site has no robots.txt. Everything may be crawled, and no sitemap is advertised.",
        subcategory: "crawling",
        pageId: null,
        pageUrl: ctx.robots.url,
        severity: "info",
        verdict: "confirmed",
        confidence: 1,
        expected: "A robots.txt referencing the sitemap",
        actual: `HTTP ${ctx.robots.httpStatus}`,
        evidence: [
          { kind: "network", data: { url: ctx.robots.url, status: ctx.robots.httpStatus } },
        ],
      });
    else if (ctx.robots?.status === "error")
      checks.inconclusive.push({
        check: "robots.txt",
        reason: `robots.txt could not be fetched (HTTP ${ctx.robots.httpStatus ?? "no response"})`,
        pageUrl: ctx.robots.url,
      });
    else if (!ctx.robots)
      checks.inconclusive.push({
        check: "robots.txt",
        reason: "robots.txt was not loaded because the project ignores robots.txt",
        pageUrl: null,
      });

    const declared = ctx.robots?.sitemaps ?? [];
    const candidates = declared.length
      ? declared
      : [new URL("/sitemap.xml", ctx.siteUrl).toString()];
    let foundSitemap = false;
    for (const raw of candidates.slice(0, 3)) {
      const sitemapUrl = new URL(raw, ctx.siteUrl).toString();
      const r = await guardedFetch(sitemapUrl, {
        ...ctx.fetch,
        signal: ctx.signal,
        maxBodyBytes: 10_000_000,
      });
      if (r.error) {
        checks.inconclusive.push({
          check: "Sitemap",
          reason: `${sitemapUrl} could not be fetched (${r.error.code})`,
          pageUrl: sitemapUrl,
        });
        continue;
      }
      if ((r.status ?? 0) >= 400) {
        if (declared.length)
          findings.push({
            ruleId: "sitemap-not-found",
            title: "Sitemap declared in robots.txt does not exist",
            message: `robots.txt points to ${sitemapUrl}, which answers HTTP ${r.status}.`,
            subcategory: "crawling",
            pageId: null,
            pageUrl: sitemapUrl,
            severity: "medium",
            verdict: "confirmed",
            confidence: 0.95,
            expected: "HTTP 200 with a valid XML sitemap",
            actual: `HTTP ${r.status}`,
            fingerprintKey: sitemapUrl,
            evidence: [
              {
                kind: "network",
                data: { url: sitemapUrl, status: r.status, declaredIn: ctx.robots?.url },
              },
            ],
          });
        continue;
      }
      foundSitemap = true;
      const body = r.body ?? "";
      const valid = XMLValidator.validate(body);
      if (valid !== true) {
        findings.push({
          ruleId: "sitemap-invalid",
          title: "Sitemap is not valid XML",
          message: `${sitemapUrl} cannot be parsed: ${valid.err.msg} (line ${valid.err.line}).`,
          subcategory: "crawling",
          pageId: null,
          pageUrl: sitemapUrl,
          severity: "medium",
          verdict: "confirmed",
          confidence: 0.95,
          expected: "Well-formed XML sitemap",
          actual: valid.err.msg,
          fingerprintKey: sitemapUrl,
          evidence: [
            {
              kind: "document",
              data: { url: sitemapUrl, error: valid.err, snippet: truncate(body, 300) },
            },
          ],
        });
        continue;
      }
      const parsed = new XMLParser().parse(body) as {
        urlset?: { url?: unknown };
        sitemapindex?: unknown;
      };
      const urls = parsed.urlset?.url;
      const count = Array.isArray(urls) ? urls.length : urls ? 1 : 0;
      if (!parsed.urlset && !parsed.sitemapindex)
        findings.push({
          ruleId: "sitemap-invalid",
          title: "Sitemap has no <urlset> or <sitemapindex>",
          message: `${sitemapUrl} is XML but not a sitemap.`,
          subcategory: "crawling",
          pageId: null,
          pageUrl: sitemapUrl,
          severity: "medium",
          verdict: "confirmed",
          confidence: 0.9,
          expected: "<urlset> or <sitemapindex> root element",
          actual: "Other XML",
          fingerprintKey: sitemapUrl,
          evidence: [{ kind: "document", data: { url: sitemapUrl, snippet: truncate(body, 300) } }],
        });
      else
        checks.notes = [
          ...(checks.notes ?? []),
          `Sitemap ${sitemapUrl}: ${parsed.sitemapindex ? "sitemap index" : `${count} URL(s)`}`,
        ];
    }
    if (!foundSitemap && !declared.length)
      findings.push({
        ruleId: "sitemap-missing",
        title: "No XML sitemap found",
        message:
          "No sitemap is declared in robots.txt and /sitemap.xml does not exist, so search engines must discover pages by crawling only.",
        subcategory: "crawling",
        pageId: null,
        pageUrl: candidates[0]!,
        severity: "low",
        verdict: "confirmed",
        confidence: 0.9,
        expected: "An XML sitemap referenced from robots.txt",
        actual: "None found",
        evidence: [{ kind: "network", data: { checked: candidates } }],
      });

    return {
      status: facts.length ? "completed" : "inconclusive",
      statusReason: facts.length
        ? `${facts.length} page${facts.length === 1 ? "" : "s"} analyzed (metadata, headings, indexability, canonical, structured data, duplicates) plus robots.txt and sitemap; ${findings.length} finding${findings.length === 1 ? "" : "s"}`
        : "No page HTML available to analyze",
      findings,
      checks,
      toolName: "QA Copilot SEO checks",
      toolVersion: "1.0.0",
    };
  },
};
