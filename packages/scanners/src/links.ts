import {
  extractLinks,
  guardedFetch,
  isSameSite,
  normalizeUrl,
  type FetchResult,
} from "@qa/crawler";
import * as cheerio from "cheerio";
import type { Severity } from "@qa/core";
import type {
  CheckSummary,
  FindingDraft,
  PageRecord,
  Scanner,
  ScannerContext,
  Verdict,
} from "./types";
import { analyzablePages, displayUrl, pool, sample, truncate } from "./util";

const MAX_TARGETS = 300;
const CONCURRENCY = 6;

export type LinkClass =
  | { kind: "ok" }
  | { kind: "redirect"; hops: number }
  | { kind: "broken"; reason: string }
  | { kind: "temporary"; reason: string }
  | { kind: "inconclusive"; reason: string };

/**
 * Classifies a link check. Only definitive answers count as "broken": 404/410, other
 * persistent errors, a host that does not exist. Timeouts and 502/503/504 after retries are
 * "temporarily unavailable"; 401/403/429 and blocked targets are "inconclusive".
 */
export function classifyLink(r: FetchResult): LinkClass {
  if (r.error) {
    if (r.error.code === "PRIVATE_ADDRESS")
      return {
        kind: "inconclusive",
        reason: "Not checked: target resolves to a private/internal address",
      };
    if (r.error.code === "DNS_FAILURE")
      return r.error.dnsCode === "ENOTFOUND"
        ? { kind: "broken", reason: "Host name does not exist (DNS: ENOTFOUND)" }
        : {
            kind: "temporary",
            reason: `DNS lookup failed temporarily (${r.error.dnsCode ?? "error"})`,
          };
    if (r.error.code === "TOO_MANY_REDIRECTS")
      return { kind: "broken", reason: "Redirect loop or more than 10 redirects" };
    if (r.error.code === "UNSUPPORTED_SCHEME")
      return { kind: "inconclusive", reason: r.error.message };
    return {
      kind: "temporary",
      reason: `No response after ${r.attempts} attempt(s): ${r.error.code}`,
    };
  }
  const s = r.status!;
  if (s === 401 || s === 403 || s === 407 || s === 429)
    return {
      kind: "inconclusive",
      reason: `HTTP ${s}: requires authentication or blocks automated checks`,
    };
  if (s === 502 || s === 503 || s === 504)
    return { kind: "temporary", reason: `HTTP ${s} after ${r.attempts} attempt(s)` };
  if (s >= 400) return { kind: "broken", reason: `HTTP ${s}` };
  if (r.redirectChain.length > 1) return { kind: "redirect", hops: r.redirectChain.length };
  return { kind: "ok" };
}

interface Target {
  url: string;
  internal: boolean;
  sources: Array<{ pageId: string; pageUrl: string; text: string; html: string }>;
}

export const linksScanner: Scanner = {
  key: "links",
  idPrefix: "LNK",
  version: "1.0.0",
  async run(ctx: ScannerContext) {
    const checks: CheckSummary = { evaluated: 0, inconclusive: [] };
    const findings: FindingDraft[] = [];
    const pages = analyzablePages(ctx.pages);
    const crawled = new Map<string, PageRecord>();
    for (const p of ctx.pages) crawled.set(normalizeUrl(p.url) ?? p.url, p);

    // Collect every distinct link target with the pages that reference it.
    const targets = new Map<string, Target>();
    for (const p of pages) {
      const html = await p.loadRawHtml();
      if (!html) continue;
      const $ = cheerio.load(html);
      for (const l of extractLinks(html, displayUrl(p))) {
        const key = normalizeUrl(l.url);
        if (!key) continue;
        const t = targets.get(key) ?? {
          url: key,
          internal: isSameSite(key, ctx.siteUrl),
          sources: [],
        };
        if (t.sources.length < 5 && !t.sources.some((s) => s.pageId === p.id)) {
          let snippet = l.raw;
          try {
            const el = $(`a[href="${l.raw.replace(/["\\]/g, "\\$&")}"]`).first();
            if (el.length) snippet = $.html(el) ?? l.raw;
          } catch {
            // Unusual characters in the href: keep the raw attribute as evidence.
          }
          t.sources.push({
            pageId: p.id,
            pageUrl: displayUrl(p),
            text: l.text,
            html: truncate(snippet, 300),
          });
        }
        targets.set(key, t);
      }
    }

    // Check each target once. Crawled pages reuse the crawl result (no second request).
    const all = [...targets.values()].sort((a, b) => Number(b.internal) - Number(a.internal));
    const toCheck = all.slice(0, MAX_TARGETS);
    if (all.length > MAX_TARGETS)
      checks.inconclusive.push({
        check: "Link checks",
        reason: `${all.length - MAX_TARGETS} additional unique links were not checked (limit ${MAX_TARGETS})`,
        pageUrl: null,
      });

    const results = new Map<string, { r: FetchResult; reused: boolean }>();
    await pool(
      toCheck,
      CONCURRENCY,
      async (t) => {
        const known = crawled.get(t.url);
        if (known && known.crawlError === null && known.httpStatus !== null) {
          results.set(t.url, {
            reused: true,
            r: {
              requestedUrl: t.url,
              finalUrl: known.finalUrl ?? t.url,
              status: known.httpStatus,
              headers: {},
              contentType: known.contentType,
              redirectChain: known.redirectChain ?? [],
              body: null,
              bodyTruncated: false,
              durationMs: 0,
              attempts: 1,
              error: null,
            },
          });
          return;
        }
        if (known?.crawlError?.startsWith("Not crawled: disallowed by robots.txt")) {
          checks.inconclusive.push({
            check: `Link ${t.url}`,
            reason: "Not checked: disallowed by robots.txt",
            pageUrl: t.sources[0]?.pageUrl ?? null,
          });
          return;
        }
        // HEAD first; fall back to GET when HEAD is not supported or refused.
        let r = await guardedFetch(t.url, { ...ctx.fetch, signal: ctx.signal, method: "HEAD" });
        if (r.status !== null && [403, 404, 405, 501].includes(r.status))
          r = await guardedFetch(t.url, {
            ...ctx.fetch,
            signal: ctx.signal,
            method: "GET",
            maxBodyBytes: 100_000,
          });
        results.set(t.url, { r, reused: false });
      },
      ctx.signal,
    );

    for (const t of toCheck) {
      const res = results.get(t.url);
      if (!res) continue;
      checks.evaluated += 1;
      const c = classifyLink(res.r);
      const sourceData = t.sources.map((s) => ({
        page: s.pageUrl,
        linkText: s.text,
        html: s.html,
      }));
      const evidence = [
        {
          kind: "link_check" as const,
          data: {
            target: t.url,
            status: res.r.status,
            finalUrl: res.r.finalUrl,
            redirectChain: res.r.redirectChain,
            attempts: res.r.attempts,
            error: res.r.error?.message ?? null,
            checkedDuringCrawl: res.reused,
            linkedFrom: sourceData,
          },
        },
      ];
      const first = t.sources[0];
      const base = {
        pageId: first?.pageId ?? null,
        pageUrl: first?.pageUrl ?? null,
        selector: first ? truncate(first.html, 300) : null,
        fingerprintKey: t.url,
        evidence,
      };
      const where = `${t.internal ? "Internal" : "External"} link ${t.url} (linked from ${t.sources.length} page${t.sources.length === 1 ? "" : "s"})`;
      if (c.kind === "broken") {
        const severity: Severity = t.internal ? "high" : "medium";
        findings.push({
          ...base,
          ruleId: t.internal ? "broken-internal-link" : "broken-external-link",
          title: `Broken ${t.internal ? "internal" : "external"} link`,
          message: `${where} is broken: ${c.reason}.`,
          subcategory: "links",
          severity,
          verdict: "confirmed",
          confidence: 0.95,
          expected: "Link target responds with HTTP 2xx",
          actual: c.reason,
        });
      } else if (c.kind === "temporary") {
        findings.push({
          ...base,
          ruleId: "link-temporarily-unavailable",
          title: "Link target temporarily unavailable",
          message: `${where} did not respond successfully: ${c.reason}. This may be temporary; re-check before treating it as broken.`,
          subcategory: "links",
          severity: "low",
          verdict: "potential",
          confidence: 0.5,
          expected: "Link target responds with HTTP 2xx",
          actual: c.reason,
        });
      } else if (c.kind === "inconclusive") {
        checks.inconclusive.push({
          check: `Link ${t.url}`,
          reason: c.reason,
          pageUrl: first?.pageUrl ?? null,
        });
      } else if (c.kind === "redirect") {
        findings.push({
          ...base,
          ruleId: "redirect-chain",
          title: "Link goes through a redirect chain",
          message: `${where} passes through ${c.hops} redirects before reaching ${res.r.finalUrl}. Link directly to the final URL.`,
          subcategory: "redirects",
          severity: "low",
          verdict: "confirmed",
          confidence: 0.95,
          expected: "Direct link to the final URL",
          actual:
            res.r.redirectChain.map((h) => `${h.status} ${h.url}`).join(" → ") +
            ` → ${res.r.finalUrl}`,
        });
      } else if (t.internal && res.r.redirectChain.length === 1) {
        findings.push({
          ...base,
          ruleId: "internal-link-redirects",
          title: "Internal link points to a redirecting URL",
          message: `${where} redirects (${res.r.redirectChain[0]!.status}) to ${res.r.finalUrl}. Update the link to avoid the extra request.`,
          subcategory: "redirects",
          severity: "info",
          verdict: "confirmed",
          confidence: 0.95,
          expected: "Link directly to the final URL",
          actual: `${res.r.redirectChain[0]!.status} → ${res.r.finalUrl}`,
        });
      }
    }

    // Failed page resources (images, scripts, stylesheets, fonts) and mixed content, from capture.
    const failed = new Map<
      string,
      { type: string; reason: string; pageId: string; pageUrl: string; viewports: Set<string> }
    >();
    const mixed = new Map<
      string,
      { type: string; pageId: string; pageUrl: string; active: boolean }
    >();
    const blocked = new Set<string>();
    for (const p of pages) {
      for (const c of p.captures) {
        for (const req of c.requests) {
          if (
            req.resourceType === "document" &&
            normalizeUrl(req.url) === normalizeUrl(displayUrl(p))
          )
            continue;
          if (req.failureText && /BLOCKED_BY_CLIENT/i.test(req.failureText)) {
            blocked.add(req.url);
            continue;
          }
          if (req.isMixedContent && !mixed.has(req.url))
            mixed.set(req.url, {
              type: req.resourceType,
              pageId: p.id,
              pageUrl: displayUrl(p),
              active: ["script", "stylesheet", "xhr", "fetch", "document"].includes(
                req.resourceType,
              ),
            });
          const bad = req.failureText
            ? `Request failed: ${req.failureText}`
            : req.status !== null && req.status >= 400
              ? `HTTP ${req.status}`
              : null;
          if (
            !bad ||
            !["image", "script", "stylesheet", "font", "media"].includes(req.resourceType)
          )
            continue;
          const key = `${req.url}|${p.id}`;
          const entry = failed.get(key) ?? {
            type: req.resourceType,
            reason: bad,
            pageId: p.id,
            pageUrl: displayUrl(p),
            viewports: new Set<string>(),
          };
          entry.viewports.add(c.viewport);
          failed.set(key, entry);
        }
      }
    }
    for (const [key, f] of failed) {
      const url = key.slice(0, key.lastIndexOf("|"));
      const critical = f.type === "script" || f.type === "stylesheet";
      findings.push({
        ruleId: "failed-resource",
        title: `${f.type[0]!.toUpperCase()}${f.type.slice(1)} failed to load`,
        message: `${url} could not be loaded on ${f.pageUrl} (${f.reason}).${critical ? " Missing scripts or stylesheets can break functionality or layout." : ""}`,
        subcategory: "resources",
        pageId: f.pageId,
        pageUrl: f.pageUrl,
        viewport: f.viewports.size === 1 ? [...f.viewports][0]! : null,
        severity: critical ? "high" : "medium",
        verdict: "confirmed",
        confidence: 0.9,
        expected: "Resource loads with HTTP 2xx",
        actual: f.reason,
        fingerprintKey: url,
        evidence: [
          {
            kind: "network",
            data: { url, resourceType: f.type, result: f.reason, viewports: [...f.viewports] },
          },
        ],
      });
    }
    for (const [url, m] of mixed) {
      const verdict: Verdict = "confirmed";
      findings.push({
        ruleId: m.active ? "mixed-content-active" : "mixed-content-passive",
        title: `${m.active ? "Active" : "Passive"} mixed content`,
        message: `The HTTPS page requests ${url} over plain HTTP.${m.active ? " Browsers block insecure scripts and styles, which can break the page." : " The resource can be altered in transit."}`,
        subcategory: "mixed-content",
        pageId: m.pageId,
        pageUrl: m.pageUrl,
        severity: m.active ? "high" : "medium",
        verdict,
        confidence: 0.95,
        expected: "All resources loaded over HTTPS",
        actual: `${m.type} over http://`,
        fingerprintKey: url,
        evidence: [{ kind: "network", data: { url, resourceType: m.type, page: m.pageUrl } }],
      });
    }
    if (blocked.size) {
      const s = sample([...blocked], 10);
      checks.inconclusive.push({
        check: "Resources on internal addresses",
        reason: `${blocked.size} resource request(s) were blocked by the network policy and not checked: ${s.items.join(", ")}${s.omitted ? ` (+${s.omitted})` : ""}`,
        pageUrl: null,
      });
    }

    const broken = findings.filter((f) => f.ruleId.startsWith("broken")).length;
    return {
      status: pages.length ? "completed" : "inconclusive",
      statusReason: pages.length
        ? `${checks.evaluated} unique link${checks.evaluated === 1 ? "" : "s"} checked across ${pages.length} page${pages.length === 1 ? "" : "s"}; ${broken} broken; ${findings.filter((f) => f.ruleId === "link-temporarily-unavailable").length} temporarily unavailable; ${failed.size} failed resource(s); ${mixed.size} mixed-content request(s)`
        : "No HTML pages to analyze",
      findings,
      checks,
      toolName: "QA Copilot link checker",
      toolVersion: "1.0.0",
    };
  },
};
