import { guardedFetch } from "@qa/crawler";
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
import {
  analyzablePages,
  displayUrl,
  header,
  headerList,
  sameOrigin,
  sample,
  truncate,
} from "./util";

const HSTS_MIN_SECONDS = 15_552_000; // 180 days

interface PageRule {
  ruleId: string;
  title: string;
  severity: Severity;
  verdict: Verdict;
  subcategory: string;
  expected: string;
  /** Returns the observed problem for this page, or null when the page passes. */
  test(p: PageRecord, csp: Csp | null): { actual: string; data: Record<string, unknown> } | null;
  message(affected: number, total: number): string;
  appliesTo?(p: PageRecord): boolean;
}

type Csp = Map<string, string[]>;

export function parseCsp(value: string | null): Csp | null {
  if (!value) return null;
  const map: Csp = new Map();
  for (const part of value.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name && !map.has(name.toLowerCase())) map.set(name.toLowerCase(), sources);
  }
  return map;
}

const isHttps = (p: PageRecord) => displayUrl(p).startsWith("https:");

function cspFor(
  p: PageRecord,
  html: string | null,
): { csp: Csp | null; source: string | null; reportOnly: boolean } {
  const h = header(p, "content-security-policy");
  if (h) return { csp: parseCsp(h), source: "header", reportOnly: false };
  if (html) {
    const meta = cheerio.load(html)('meta[http-equiv="Content-Security-Policy" i]').attr("content");
    if (meta) return { csp: parseCsp(meta), source: "meta", reportOnly: false };
  }
  if (header(p, "content-security-policy-report-only"))
    return { csp: null, source: "report-only", reportOnly: true };
  return { csp: null, source: null, reportOnly: false };
}

const RULES: PageRule[] = [
  {
    ruleId: "hsts-missing",
    title: "Strict-Transport-Security header is missing",
    severity: "medium",
    verdict: "confirmed",
    subcategory: "transport",
    expected: `Strict-Transport-Security: max-age=${HSTS_MIN_SECONDS} (or more); includeSubDomains`,
    appliesTo: isHttps,
    test: (p) =>
      header(p, "strict-transport-security")
        ? null
        : { actual: "header not sent", data: { header: "strict-transport-security", value: null } },
    message: (n, t) =>
      `HTTPS responses do not send HSTS (${n} of ${t} HTTPS pages), so browsers may still try plain HTTP and allow downgrade attacks.`,
  },
  {
    ruleId: "hsts-weak",
    title: "HSTS max-age is shorter than 180 days",
    severity: "low",
    verdict: "confirmed",
    subcategory: "transport",
    expected: `max-age of at least ${HSTS_MIN_SECONDS} seconds`,
    appliesTo: isHttps,
    test: (p) => {
      const v = header(p, "strict-transport-security");
      if (!v) return null;
      const age = Number(/max-age\s*=\s*"?(\d+)/i.exec(v)?.[1] ?? "0");
      return age < HSTS_MIN_SECONDS
        ? { actual: v, data: { header: "strict-transport-security", value: v, maxAgeSeconds: age } }
        : null;
    },
    message: (n, t) => `The HSTS policy is too short-lived on ${n} of ${t} HTTPS pages.`,
  },
  {
    ruleId: "csp-missing",
    title: "Content-Security-Policy is not set",
    severity: "medium",
    verdict: "confirmed",
    subcategory: "headers",
    expected: "A Content-Security-Policy header restricting script sources",
    test: (p, csp) =>
      csp
        ? null
        : {
            actual: header(p, "content-security-policy-report-only")
              ? "only Content-Security-Policy-Report-Only (not enforced)"
              : "no policy",
            data: {
              header: "content-security-policy",
              value: null,
              reportOnly: header(p, "content-security-policy-report-only"),
            },
          },
    message: (n, t) =>
      `${n} of ${t} pages have no enforced Content-Security-Policy, which leaves cross-site scripting without a second line of defense.`,
  },
  {
    ruleId: "csp-unsafe-script",
    title: "Content-Security-Policy allows unsafe script sources",
    severity: "low",
    verdict: "confirmed",
    subcategory: "headers",
    expected: "script-src without 'unsafe-inline', 'unsafe-eval', wildcards or bare schemes",
    test: (_p, csp) => {
      if (!csp) return null;
      const directive = csp.has("script-src")
        ? "script-src"
        : csp.has("default-src")
          ? "default-src"
          : null;
      if (!directive)
        return { actual: "no script-src or default-src directive", data: { directive: null } };
      const src = csp.get(directive)!;
      const hasNonceOrHash = src.some((s) => /^'(nonce-|sha(256|384|512)-)/.test(s));
      const problems = [
        src.includes("'unsafe-inline'") && !hasNonceOrHash ? "'unsafe-inline'" : null,
        src.includes("'unsafe-eval'") ? "'unsafe-eval'" : null,
        src.some((s) => s === "*" || s === "http:" || s === "https:" || s === "data:")
          ? "wildcard or scheme source"
          : null,
      ].filter(Boolean);
      return problems.length
        ? { actual: `${directive} ${src.join(" ")}`, data: { directive, sources: src, problems } }
        : null;
    },
    message: (n, t) =>
      `The script policy on ${n} of ${t} pages permits sources that defeat much of CSP's protection.`,
  },
  {
    ruleId: "x-content-type-options-missing",
    title: "X-Content-Type-Options: nosniff is missing",
    severity: "low",
    verdict: "confirmed",
    subcategory: "headers",
    expected: "X-Content-Type-Options: nosniff",
    test: (p) =>
      /^nosniff$/i.test(header(p, "x-content-type-options") ?? "")
        ? null
        : {
            actual: header(p, "x-content-type-options") ?? "header not sent",
            data: { header: "x-content-type-options", value: header(p, "x-content-type-options") },
          },
    message: (n, t) => `${n} of ${t} pages allow browsers to MIME-sniff responses.`,
  },
  {
    ruleId: "frame-protection-missing",
    title: "Pages can be embedded by other sites (clickjacking)",
    severity: "medium",
    verdict: "confirmed",
    subcategory: "headers",
    expected: "X-Frame-Options: DENY/SAMEORIGIN or CSP frame-ancestors",
    test: (p, csp) => {
      const xfo = header(p, "x-frame-options");
      if (xfo && /^(deny|sameorigin)$/i.test(xfo.trim())) return null;
      if (csp?.has("frame-ancestors")) return null;
      return {
        actual: xfo ? `X-Frame-Options: ${xfo}` : "no X-Frame-Options and no frame-ancestors",
        data: { "x-frame-options": xfo, frameAncestors: null },
      };
    },
    message: (n, t) => `${n} of ${t} pages do not restrict framing.`,
  },
  {
    ruleId: "referrer-policy-unsafe",
    title: "Referrer-Policy leaks full URLs",
    severity: "low",
    verdict: "confirmed",
    subcategory: "headers",
    expected: "strict-origin-when-cross-origin, no-referrer or same-origin",
    test: (p) => {
      const v = header(p, "referrer-policy");
      return v && /(^|,)\s*(unsafe-url|no-referrer-when-downgrade)\s*$/i.test(v)
        ? { actual: v, data: { header: "referrer-policy", value: v } }
        : null;
    },
    message: (n, t) =>
      `${n} of ${t} pages send full URLs (including query strings) to other sites.`,
  },
  {
    ruleId: "referrer-policy-missing",
    title: "Referrer-Policy header is not set",
    severity: "info",
    verdict: "confirmed",
    subcategory: "headers",
    expected: "Referrer-Policy: strict-origin-when-cross-origin (explicit)",
    test: (p) =>
      header(p, "referrer-policy")
        ? null
        : {
            actual: "header not sent (browser default applies)",
            data: { header: "referrer-policy", value: null },
          },
    message: (n, t) => `${n} of ${t} pages rely on the browser's default referrer policy.`,
  },
  {
    ruleId: "permissions-policy-missing",
    title: "Permissions-Policy header is not set",
    severity: "info",
    verdict: "confirmed",
    subcategory: "headers",
    expected: "Permissions-Policy limiting powerful features (camera, microphone, geolocation, …)",
    test: (p) =>
      header(p, "permissions-policy")
        ? null
        : { actual: "header not sent", data: { header: "permissions-policy", value: null } },
    message: (n, t) => `${n} of ${t} pages do not restrict browser features for embedded content.`,
  },
  {
    ruleId: "server-version-disclosure",
    title: "Server software version is disclosed",
    severity: "low",
    verdict: "confirmed",
    subcategory: "information-disclosure",
    expected: "No version numbers in Server / X-Powered-By headers",
    test: (p) => {
      const server = header(p, "server");
      const powered = header(p, "x-powered-by");
      const aspnet = header(p, "x-aspnet-version");
      const leaks = [
        server && /\d/.test(server) ? `Server: ${server}` : null,
        powered ? `X-Powered-By: ${powered}` : null,
        aspnet ? `X-AspNet-Version: ${aspnet}` : null,
      ].filter(Boolean) as string[];
      return leaks.length ? { actual: leaks.join("; "), data: { headers: leaks } } : null;
    },
    message: (n, t) =>
      `${n} of ${t} responses reveal software versions, which helps attackers find known vulnerabilities.`,
  },
];

const SECRET_PATTERNS: Array<{ id: string; label: string; re: RegExp }> = [
  { id: "aws-access-key", label: "AWS access key ID", re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g },
  {
    id: "private-key",
    label: "Private key block",
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
  },
  { id: "google-api-key", label: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: "stripe-secret-key", label: "Stripe secret key", re: /\b(sk|rk)_live_[0-9A-Za-z]{20,}\b/g },
  { id: "github-token", label: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { id: "slack-token", label: "Slack token", re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g },
];

export const maskSecret = (s: string) =>
  `${s.slice(0, 4)}${"*".repeat(Math.max(4, s.length - 8))}${s.slice(-2)}`;

function parseCookie(raw: string) {
  const [pair, ...attrs] = raw.split(";").map((s) => s.trim());
  const name = pair?.split("=")[0] ?? "";
  const lower = attrs.map((a) => a.toLowerCase());
  return {
    name,
    secure: lower.includes("secure"),
    httpOnly: lower.includes("httponly"),
    sameSite: lower.find((a) => a.startsWith("samesite"))?.split("=")[1] ?? null,
    raw: [name + "=[redacted]", ...attrs].join("; "),
  };
}

export const securityScanner: Scanner = {
  key: "security",
  idPrefix: "SEC",
  version: "1.0.0",
  async run(ctx: ScannerContext) {
    const pages = analyzablePages(ctx.pages);
    const checks: CheckSummary = { evaluated: 0, inconclusive: [] };
    const findings: FindingDraft[] = [];
    if (!pages.length)
      return {
        status: "inconclusive",
        statusReason: "No HTML pages to analyze",
        findings,
        checks,
        toolName: "QA Copilot security checks",
        toolVersion: "1.0.0",
      };

    const htmlById = new Map<string, string | null>();
    for (const p of pages) htmlById.set(p.id, await p.loadRawHtml());

    // 1. Transport
    const site = new URL(ctx.siteUrl);
    if (site.protocol === "http:") {
      findings.push({
        ruleId: "https-not-used",
        title: "Site is not served over HTTPS",
        message:
          "The site was scanned over plain HTTP. Traffic, cookies and form data can be read or modified on the network.",
        subcategory: "transport",
        pageId: null,
        pageUrl: ctx.siteUrl,
        severity: "high",
        verdict: "confirmed",
        confidence: 1,
        expected: "All pages served over HTTPS",
        actual: `Scanned URL: ${ctx.siteUrl}`,
        evidence: [{ kind: "document", data: { scannedUrl: ctx.siteUrl, protocol: "http:" } }],
      });
    } else {
      const httpUrl = `http://${site.hostname}/`;
      const r = await guardedFetch(httpUrl, {
        ...ctx.fetch,
        signal: ctx.signal,
        retries: 0,
        method: "GET",
      });
      checks.evaluated += 1;
      if (r.status !== null && r.status < 400 && !r.finalUrl.startsWith("https:")) {
        findings.push({
          ruleId: "http-not-redirected",
          title: "HTTP requests are not redirected to HTTPS",
          message: `${httpUrl} answered HTTP ${r.status} over plain HTTP instead of redirecting to HTTPS.`,
          subcategory: "transport",
          pageId: null,
          pageUrl: httpUrl,
          severity: "medium",
          verdict: "confirmed",
          confidence: 0.95,
          expected: "301/308 redirect from http:// to https://",
          actual: `HTTP ${r.status} at ${r.finalUrl}`,
          evidence: [
            {
              kind: "network",
              data: {
                requested: httpUrl,
                finalUrl: r.finalUrl,
                status: r.status,
                redirectChain: r.redirectChain,
              },
            },
          ],
        });
      } else if (r.error) {
        checks.inconclusive.push({
          check: "HTTP to HTTPS redirect",
          reason: `${httpUrl} could not be reached (${r.error.code}); plain HTTP may simply be closed`,
          pageUrl: httpUrl,
        });
      }
    }

    // 2. Header rules, aggregated site-wide.
    const csps = new Map(pages.map((p) => [p.id, cspFor(p, htmlById.get(p.id) ?? null)]));
    for (const rule of RULES) {
      const applicable = pages.filter((p) => rule.appliesTo?.(p) ?? true);
      if (!applicable.length) continue;
      const failing: Array<{ p: PageRecord; actual: string; data: Record<string, unknown> }> = [];
      for (const p of applicable) {
        checks.evaluated += 1;
        const r = rule.test(p, csps.get(p.id)?.csp ?? null);
        if (r) failing.push({ p, ...r });
      }
      if (!failing.length) continue;
      const s = sample(failing, 10);
      const single = failing.length === 1 ? failing[0]!.p : null;
      findings.push({
        ruleId: rule.ruleId,
        title: rule.title,
        message: rule.message(failing.length, applicable.length),
        subcategory: rule.subcategory,
        pageId: single?.id ?? null,
        pageUrl: single ? displayUrl(single) : ctx.siteUrl,
        severity: rule.severity,
        verdict: rule.verdict,
        confidence: 0.95,
        expected: rule.expected,
        actual: failing[0]!.actual,
        evidence: [
          {
            kind: "header",
            data: {
              affectedPages: failing.length,
              pagesChecked: applicable.length,
              observations: s.items.map((f) => ({ url: displayUrl(f.p), ...f.data })),
              omitted: s.omitted,
            },
          },
        ],
      });
    }

    // 3. Cookies set without security attributes (deduplicated by cookie name).
    const cookieIssues = new Map<string, { problems: string[]; url: string; raw: string }>();
    for (const p of pages) {
      for (const raw of headerList(p, "set-cookie")) {
        const c = parseCookie(raw);
        if (!c.name || cookieIssues.has(c.name)) continue;
        const problems = [
          isHttps(p) && !c.secure ? "Secure" : null,
          !c.httpOnly ? "HttpOnly" : null,
          !c.sameSite ? "SameSite" : null,
        ].filter(Boolean) as string[];
        if (problems.length) cookieIssues.set(c.name, { problems, url: displayUrl(p), raw: c.raw });
      }
    }
    for (const [name, issue] of cookieIssues) {
      checks.evaluated += 1;
      const missingSecure = issue.problems.includes("Secure");
      findings.push({
        ruleId: "cookie-flags",
        title: `Cookie “${name}” is missing ${issue.problems.join(", ")}`,
        message:
          `The cookie is set without ${issue.problems.join(", ")}. ${issue.problems.includes("HttpOnly") ? "Without HttpOnly, scripts (including injected ones) can read it; keep it only if client-side code needs it. " : ""}${missingSecure ? "Without Secure it can be sent over plain HTTP. " : ""}${issue.problems.includes("SameSite") ? "Without SameSite, behavior depends on browser defaults." : ""}`.trim(),
        subcategory: "cookies",
        pageId: null,
        pageUrl: issue.url,
        selector: `Set-Cookie: ${name}`,
        severity: missingSecure ? "medium" : "low",
        verdict:
          issue.problems.length === 1 && issue.problems[0] === "HttpOnly"
            ? "potential"
            : "confirmed",
        confidence: 0.9,
        expected: "Secure; HttpOnly; SameSite=Lax (or Strict)",
        actual: issue.raw,
        fingerprintKey: name,
        evidence: [
          {
            kind: "header",
            data: {
              header: "set-cookie",
              value: issue.raw,
              url: issue.url,
              missing: issue.problems,
            },
          },
        ],
      });
    }

    // 4. HTML-level checks: insecure form targets, third-party resources without SRI, secrets.
    const sriMissing = new Map<string, { type: string; pageUrl: string; html: string }>();
    for (const p of pages) {
      const html = htmlById.get(p.id);
      if (!html) {
        checks.inconclusive.push({
          check: "HTML security checks",
          reason: "Served HTML not available",
          pageUrl: displayUrl(p),
        });
        continue;
      }
      const url = displayUrl(p);
      const $ = cheerio.load(html);
      checks.evaluated += 3;
      if (isHttps(p)) {
        $("form[action]").each((_, el) => {
          const action = $(el).attr("action") ?? "";
          let target: string;
          try {
            target = new URL(action, url).toString();
          } catch {
            return;
          }
          if (target.startsWith("http:"))
            findings.push({
              ruleId: "insecure-form-action",
              title: "Form submits over plain HTTP",
              message: `A form on an HTTPS page sends its data to ${target} without encryption.`,
              subcategory: "transport",
              pageId: p.id,
              pageUrl: url,
              selector: `form[action="${action}"]`,
              severity: "high",
              verdict: "confirmed",
              confidence: 0.95,
              expected: "Form action on https://",
              actual: target,
              evidence: [{ kind: "html_snippet", data: { html: truncate($.html(el) ?? "", 400) } }],
            });
        });
      }
      $('script[src], link[rel~="stylesheet"][href]').each((_, el) => {
        const attr = el.tagName === "script" ? "src" : "href";
        const raw = $(el).attr(attr) ?? "";
        let target: string;
        try {
          target = new URL(raw, url).toString();
        } catch {
          return;
        }
        if (!/^https?:/.test(target) || sameOrigin(target, url) || $(el).attr("integrity")) return;
        if (!sriMissing.has(target))
          sriMissing.set(target, {
            type: el.tagName,
            pageUrl: url,
            html: truncate($.html(el) ?? "", 300),
          });
      });
      for (const pattern of SECRET_PATTERNS) {
        const matches = [...new Set(html.match(pattern.re) ?? [])];
        for (const m of matches.slice(0, 3)) {
          const at = html.indexOf(m);
          findings.push({
            ruleId: `exposed-secret-${pattern.id}`,
            title: `Possible ${pattern.label} in page source`,
            message: `The served HTML contains a string that matches the format of a ${pattern.label}. If it is real, rotate it immediately and remove it from the page. It may also be a sample value.`,
            subcategory: "information-disclosure",
            pageId: p.id,
            pageUrl: url,
            severity: "high",
            verdict: "potential",
            confidence: 0.6,
            expected: "No credentials in public pages",
            actual: `${pattern.label} pattern: ${maskSecret(m)}`,
            fingerprintKey: maskSecret(m),
            evidence: [
              {
                kind: "html_snippet",
                data: {
                  // The match itself is masked; surrounding context helps locate it.
                  match: maskSecret(m),
                  context:
                    truncate(html.slice(Math.max(0, at - 60), at).replace(/\s+/g, " "), 80) +
                    "[MATCH]",
                  pattern: pattern.id,
                },
              },
            ],
          });
        }
      }
    }
    for (const [target, info] of sriMissing) {
      findings.push({
        ruleId: "sri-missing",
        title: `Third-party ${info.type === "script" ? "script" : "stylesheet"} loaded without Subresource Integrity`,
        message: `${target} is loaded from another origin without an integrity attribute, so a compromised or altered file would run unchecked.`,
        subcategory: "sri",
        pageId: null,
        pageUrl: info.pageUrl,
        selector: info.html,
        severity: "low",
        verdict: "confirmed",
        confidence: 0.9,
        expected: 'integrity="sha384-…" crossorigin="anonymous"',
        actual: "No integrity attribute",
        fingerprintKey: target,
        evidence: [
          {
            kind: "html_snippet",
            data: { resource: target, html: info.html, firstSeenOn: info.pageUrl },
          },
        ],
      });
    }

    return {
      status: "completed",
      statusReason: `${pages.length} page${pages.length === 1 ? "" : "s"} checked: transport, security headers, cookies, forms, SRI and exposed credentials (passive checks only); ${findings.length} finding${findings.length === 1 ? "" : "s"}`,
      findings,
      checks,
      toolName: "QA Copilot security checks",
      toolVersion: "1.0.0",
    };
  },
};
