import {
  canonicalText,
  containsPhrase,
  normalizeText,
  textSimilarity,
  words,
  type Severity,
} from "@qa/core";
import { diffWords } from "diff";
import type {
  CheckSummary,
  ComparisonItem,
  ComparisonVerdict,
  ContentBlockRecord,
  EvidenceDraft,
  FindingDraft,
  PageRecord,
  Scanner,
  ScannerContext,
} from "./types";
import { analyzablePages, displayUrl, screenshotEvidence } from "./util";

/** Similarity at or above which a block counts as the same text with changed wording. */
export const CHANGED_WORDING_AT = 0.85;
/** Similarity at or above which the text is considered a rewrite (needs review), not missing. */
export const REWRITE_AT = 0.6;
/** Page-mapping confidence at or above which mismatches are confirmed. */
const CONFIRM_AT = 0.9;

interface TextData {
  title?: string;
  blocks: Array<{ tag: string; text: string; selector: string }>;
  links: Array<{ kind: "link" | "button"; text: string; href: string | null; selector: string }>;
}

interface WebBlock {
  tag: string;
  text: string;
  canon: string;
  key: string;
  selector: string;
}
interface PageText {
  page: PageRecord;
  url: string;
  path: string;
  title: string;
  headings: string[];
  blocks: WebBlock[];
  links: Array<{ kind: string; text: string; key: string; href: string | null; selector: string }>;
  fullKey: string;
  fullCanon: string;
  capture: PageRecord["captures"][number];
}

/** Comparison form: normalized, without trailing sentence punctuation. */
const keyOf = (s: string) => normalizeText(s).replace(/[\s.!?:;,]+$/, "");
const canonKey = (s: string) => canonicalText(s).replace(/[\s.!?:;,]+$/, "");

function pathOf(url: string): string {
  try {
    const p = new URL(url).pathname.replace(/\/+$/, "");
    return p || "/";
  } catch {
    return url;
  }
}

function normalizeHref(href: string, base: string): string | null {
  try {
    const u = new URL(href, base);
    if (!/^https?:$/.test(u.protocol)) return u.href;
    return `${u.origin}${u.pathname.replace(/\/+$/, "") || "/"}${u.search}`;
  } catch {
    return null;
  }
}

interface Mapping {
  page: PageText | null;
  method: string;
  confidence: number;
  reason?: string;
}

/** Finds the website page a document section describes. */
export function mapSection(
  hint: string | null,
  targetPath: string | null,
  firstHeading: string | null,
  pages: PageText[],
  siteUrl: string,
): Mapping {
  const byPath = (raw: string, method: string): Mapping => {
    const path = pathOf(new URL(raw, siteUrl).href);
    const page = pages.find((p) => p.path === path) ?? null;
    return page
      ? { page, method, confidence: 1 }
      : {
          page: null,
          method,
          confidence: 0,
          reason: `The mapped page ${path} was not crawled or captured in this scan (check the crawl limits)`,
        };
  };
  if (hint && /^(\/|https?:\/\/)/i.test(hint))
    return byPath(hint, `page marker “${hint}” in the document`);
  if (!hint && targetPath)
    return byPath(targetPath, `mapping to ${targetPath} set on the References page`);
  // The best page must be clearly better than the next one; an exact match beats near matches.
  const clear = (best: { s: number } | undefined, second: { s: number } | undefined, min: number) =>
    Boolean(
      best &&
      best.s >= min &&
      (!second || second.s < best.s - 0.1 || (best.s >= 0.99 && second.s < 0.99)),
    );
  const rank = (needle: string, candidates: (p: PageText) => string[]) =>
    pages
      .map((p) => ({
        p,
        s: Math.max(0, ...candidates(p).map((c) => textSimilarity(needle, normalizeText(c)))),
      }))
      .sort((a, b) => b.s - a.s);
  if (hint) {
    const needle = normalizeText(hint);
    const ranked = rank(needle, (p) => [
      p.path.split("/").filter(Boolean).pop()?.replace(/[-_]+/g, " ") ?? "home",
      p.title,
      ...p.headings.slice(0, 1),
    ]);
    const [best, second] = ranked;
    if (clear(best, second, 0.8))
      return { page: best!.p, method: `page name “${hint}” in the document`, confidence: 0.8 };
    return {
      page: null,
      method: `page name “${hint}”`,
      confidence: 0,
      reason: `No crawled page clearly matches the page name “${hint}”`,
    };
  }
  if (firstHeading) {
    const ranked = rank(normalizeText(firstHeading), (p) => [...p.headings.slice(0, 2), p.title]);
    const [best, second] = ranked;
    if (clear(best, second, 0.85))
      return {
        page: best!.p,
        method: `heading “${firstHeading}” matches the page heading`,
        confidence: 0.75,
      };
  }
  return {
    page: null,
    method: "none",
    confidence: 0,
    reason: "No page could be identified for this content (add a “Page:” marker or a page mapping)",
  };
}

/** Word diff from the website text to the approved text. */
function wordDiff(website: string, reference: string) {
  return diffWords(website, reference).map((part) => ({
    op: part.added ? "missing_on_website" : part.removed ? "not_in_reference" : "same",
    text: part.value,
  }));
}

function locationText(doc: string, b: ContentBlockRecord): string {
  const loc = (b.location ?? {}) as { page?: number; line?: number; headingPath?: string[] };
  return [
    doc,
    loc.page ? `page ${loc.page}` : null,
    loc.line ? `line ${loc.line}` : null,
    loc.headingPath?.length ? loc.headingPath.join(" › ") : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

const truncate = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n)}…` : s);

export const contentScanner: Scanner = {
  key: "content",
  idPrefix: "CNT",
  version: "1.0.0",
  async run(ctx: ScannerContext) {
    const ref = ctx.references.content;
    const checks: CheckSummary = { evaluated: 0, inconclusive: [], notes: [] };
    const findings: FindingDraft[] = [];
    const items: ComparisonItem[] = [];
    const done = (status: "completed" | "inconclusive", statusReason: string) => {
      const count = (v: ComparisonVerdict) => items.filter((i) => i.verdict === v).length;
      checks.comparison = {
        matched: count("match"),
        confirmedMismatch: count("confirmed_mismatch"),
        potentialMismatch: count("potential_mismatch"),
        unableToVerify: count("unable_to_verify"),
        items: items.slice(0, 500),
      };
      return {
        status,
        statusReason,
        findings,
        checks,
        toolName: "Content comparison (text similarity + word diff)",
        toolVersion: "1.0.0",
      };
    };
    if (!ref || !ref.documents.length) {
      if (ref?.missing.length)
        checks.inconclusive.push({
          check: "Content documents",
          reason: `${ref.missing.length} document(s) were deleted after the scan was queued`,
          pageUrl: null,
        });
      return done("inconclusive", "No content documents were available for comparison");
    }
    for (const name of ref.missing)
      checks.inconclusive.push({
        check: `Document ${name}`,
        reason: "Deleted after the scan was queued; not compared",
        pageUrl: null,
      });
    // Partially read documents: what could not be read was not compared (never "missing").
    for (const doc of ref.documents)
      if (doc.coverageNote)
        checks.inconclusive.push({
          check: `Document ${doc.filename}`,
          reason: `Only partly read: ${doc.coverageNote} That content was not compared.`,
          pageUrl: null,
        });

    // Website text per page, from the widest viewport that has text.
    const widest = Math.max(...ctx.viewports.map((v) => v.width));
    const pages: PageText[] = [];
    for (const p of analyzablePages(ctx.pages)) {
      const captures = [...p.captures]
        .filter((c) => !c.error)
        .sort((a, b) => Math.abs(widest - a.width) - Math.abs(widest - b.width));
      for (const c of captures) {
        const t = (await c.loadTextContent()) as TextData | null;
        if (!t?.blocks) continue;
        const blocks = t.blocks.map((b) => ({ ...b, canon: canonKey(b.text), key: keyOf(b.text) }));
        pages.push({
          page: p,
          url: displayUrl(p),
          path: pathOf(displayUrl(p)),
          title: t.title ?? p.title ?? "",
          headings: blocks.filter((b) => /^h[1-3]$/.test(b.tag)).map((b) => b.text),
          blocks,
          links: t.links.map((l) => ({ ...l, key: keyOf(l.text) })),
          fullKey: blocks.map((b) => b.key).join(" \n "),
          fullCanon: blocks.map((b) => b.canon).join(" \n "),
          capture: c,
        });
        break;
      }
    }
    if (!pages.length) {
      checks.inconclusive.push({
        check: "Website text",
        reason: "No page capture contains extracted text",
        pageUrl: null,
      });
      return done("inconclusive", "No website text was captured, so no content could be compared");
    }

    for (const doc of ref.documents) {
      // Sections: consecutive blocks with the same page hint.
      const sections: Array<{ hint: string | null; blocks: ContentBlockRecord[] }> = [];
      for (const b of doc.blocks) {
        const last = sections[sections.length - 1];
        if (last && last.hint === b.pageHint) last.blocks.push(b);
        else sections.push({ hint: b.pageHint, blocks: [b] });
      }
      for (const section of sections) {
        const firstHeading =
          section.blocks.find((b) => b.type === "heading")?.text ?? section.blocks[0]?.text ?? null;
        const mapping = mapSection(section.hint, doc.targetPath, firstHeading, pages, ctx.siteUrl);
        const sectionLabel = `${doc.filename}${section.hint ? ` (${section.hint})` : ""}`;
        if (!mapping.page) {
          let unresolved = 0;
          for (const b of section.blocks) {
            checks.evaluated += 1;
            const key = keyOf(b.text);
            const foundOn = pages.find(
              (p) => p.blocks.some((w) => w.key === key) || containsPhrase(p.fullKey, key),
            );
            const base = {
              key: `${doc.id}:${b.order}`,
              label: truncate(b.text),
              expected: b.text,
              reference: locationText(doc.filename, b),
            };
            if (foundOn)
              items.push({
                ...base,
                verdict: "match",
                actual: b.text,
                pageUrl: foundOn.url,
                detail: "Found on a page (section not mapped to a page)",
              });
            else {
              unresolved += 1;
              items.push({
                ...base,
                verdict: "unable_to_verify",
                actual: null,
                detail: mapping.reason ?? "No page mapped",
              });
            }
          }
          if (unresolved)
            checks.inconclusive.push({
              check: `Content section ${sectionLabel}`,
              reason: `${mapping.reason}; ${unresolved} block(s) unable to verify`,
              pageUrl: null,
            });
          continue;
        }
        const pt = mapping.page;
        const c = mapping.confidence;
        const mappingInfo = { page: pt.path, method: mapping.method, confidence: c };

        for (const b of section.blocks) {
          checks.evaluated += 1;
          const reference = locationText(doc.filename, b);
          const base = {
            key: `${doc.id}:${b.order}`,
            label: truncate(b.text),
            expected: b.text,
            reference,
            pageUrl: pt.url,
          };
          const docEvidence: EvidenceDraft = {
            kind: "document",
            data: {
              document: doc.filename,
              // Source block (retrieval of the surrounding approved section for explanations).
              documentId: doc.id,
              blockOrder: b.order,
              location: reference,
              blockType: b.type,
              referenceText: b.text,
              ...(b.href ? { referenceHref: b.href } : {}),
              pageMapping: mappingInfo,
            },
          };
          const emit = (f: {
            ruleId: string;
            title: string;
            message: string;
            verdict: "confirmed" | "potential";
            severity: Severity;
            actual: string | null;
            selector?: string | null;
            extra?: EvidenceDraft[];
            itemDetail: string;
          }) => {
            items.push({
              ...base,
              verdict: f.verdict === "confirmed" ? "confirmed_mismatch" : "potential_mismatch",
              actual: f.actual,
              detail: f.itemDetail,
            });
            findings.push({
              ruleId: f.ruleId,
              title: f.title,
              message: `${f.message} Page mapped by ${mapping.method} (confidence ${c}).`,
              subcategory: b.type,
              pageId: pt.page.id,
              pageUrl: pt.url,
              selector: f.selector ?? null,
              viewport: pt.capture.viewport,
              severity: f.verdict === "confirmed" ? f.severity : "low",
              verdict: f.verdict,
              confidence: c,
              expected: b.href ? `${b.text} → ${b.href}` : b.text,
              actual: f.actual,
              fingerprintKey: `${doc.filename}|${f.ruleId}|${b.normalizedText.slice(0, 300)}`,
              evidence: [docEvidence, ...(f.extra ?? []), ...screenshotEvidence(pt.capture)],
            });
          };
          const strength = (v: number): "confirmed" | "potential" =>
            v >= CONFIRM_AT ? "confirmed" : "potential";

          if (b.type === "cta" || b.type === "link") {
            const what = b.type === "cta" ? "Call to action" : "Link";
            const key = keyOf(b.text);
            const exact = pt.links.filter((l) => l.key === key);
            if (exact.length) {
              if (!b.href) {
                items.push({
                  ...base,
                  verdict: "match",
                  actual: exact[0]!.text,
                  detail: "Text matches (no target in the document)",
                });
                continue;
              }
              const want = normalizeHref(b.href, ctx.siteUrl);
              const hit = exact.find((l) => l.href && normalizeHref(l.href, ctx.siteUrl) === want);
              if (hit) {
                items.push({
                  ...base,
                  verdict: "match",
                  actual: `${hit.text} → ${hit.href}`,
                  detail: "Text and target match",
                });
                continue;
              }
              const l = exact[0]!;
              emit({
                ruleId: "content-link-target-mismatch",
                title: `${what} “${truncate(b.text, 60)}” links to the wrong page`,
                message: `The approved content links “${b.text}” to ${b.href}; on ${pt.path} it ${l.href ? `links to ${l.href}` : "is a button without a link target"}.`,
                verdict: strength(c),
                severity: b.type === "cta" ? "high" : "medium",
                actual: `${l.text} → ${l.href ?? "(no link)"}`,
                selector: l.selector,
                extra: [
                  {
                    kind: "link_check",
                    data: {
                      expectedHref: b.href,
                      expectedResolved: want,
                      actualHref: l.href,
                      element: l.selector,
                    },
                  },
                ],
                itemDetail: `Target differs: ${l.href ?? "none"}`,
              });
              continue;
            }
            const near = pt.links
              .map((l) => ({ l, s: textSimilarity(key, l.key) }))
              .sort((x, y) => y.s - x.s)[0];
            if (near && near.s >= CHANGED_WORDING_AT) {
              emit({
                ruleId: "content-changed-wording",
                title: `${what} text differs: “${truncate(near.l.text, 60)}”`,
                message: `The approved ${what.toLowerCase()} “${b.text}” appears on ${pt.path} as “${near.l.text}” (similarity ${near.s.toFixed(2)}).`,
                verdict: strength(c),
                severity: "medium",
                actual: near.l.text,
                selector: near.l.selector,
                extra: [
                  {
                    kind: "text_diff",
                    data: {
                      reference: b.text,
                      website: near.l.text,
                      similarity: Math.round(near.s * 100) / 100,
                      element: near.l.selector,
                      diff: wordDiff(near.l.text, b.text),
                    },
                  },
                ],
                itemDetail: `Changed wording (similarity ${near.s.toFixed(2)})`,
              });
              continue;
            }
            if (containsPhrase(pt.fullKey, key)) {
              emit({
                ruleId: "content-cta-not-link",
                title: `${what} “${truncate(b.text, 60)}” is text, not a link or button`,
                message: `“${b.text}” appears on ${pt.path}, but not as a link or button${b.href ? ` to ${b.href}` : ""}.`,
                verdict: "potential",
                severity: "medium",
                actual: b.text,
                itemDetail: "Text present but not clickable",
              });
              continue;
            }
            emit({
              ruleId: "content-missing",
              title: `${what} missing: “${truncate(b.text, 60)}”`,
              message: `The approved ${what.toLowerCase()} “${b.text}”${b.href ? ` (→ ${b.href})` : ""} was not found on ${pt.path}.`,
              verdict: strength(c),
              severity: b.type === "cta" ? "high" : "medium",
              actual: null,
              itemDetail: "Not found on the mapped page",
            });
            continue;
          }

          const key = keyOf(b.text);
          if (!key) continue;
          const exactBlock = pt.blocks.find((w) => w.key === key);
          if (exactBlock || containsPhrase(pt.fullKey, key)) {
            const canon = canonKey(b.text);
            if (exactBlock?.canon === canon || containsPhrase(pt.fullCanon, canon)) {
              items.push({ ...base, verdict: "match", actual: b.text, detail: "Exact match" });
              continue;
            }
            const i = pt.fullKey.indexOf(key);
            const webText =
              exactBlock?.text ??
              (pt.fullKey.length === pt.fullCanon.length && i >= 0
                ? pt.fullCanon.slice(i, i + key.length)
                : b.text);
            emit({
              ruleId: "content-capitalization",
              title: `Capitalization differs: “${truncate(webText, 60)}”`,
              message: `The approved text “${b.text}” appears on ${pt.path} with different capitalization: “${webText}”.`,
              verdict: "potential",
              severity: "low",
              actual: webText,
              selector: exactBlock?.selector ?? null,
              extra: [
                {
                  kind: "text_diff",
                  data: {
                    reference: b.text,
                    website: webText,
                    similarity: 1,
                    element: exactBlock?.selector ?? null,
                    diff: wordDiff(webText, b.text),
                  },
                },
              ],
              itemDetail: "Same words, different capitalization",
            });
            continue;
          }
          // Closest website text: single blocks and pairs of adjacent blocks (split paragraphs).
          const candidates = [
            ...pt.blocks.map((w) => ({ text: w.text, key: w.key, selector: w.selector })),
            ...pt.blocks.slice(1).map((w, i) => ({
              text: `${pt.blocks[i]!.text} ${w.text}`,
              key: `${pt.blocks[i]!.key} ${w.key}`,
              selector: pt.blocks[i]!.selector,
            })),
          ];
          const best = candidates
            .map((cand) => ({ cand, s: textSimilarity(key, cand.key) }))
            .sort((x, y) => y.s - x.s)[0];
          const heading = b.type === "heading";
          if (best && best.s >= REWRITE_AT && words(key).length > 0) {
            const changed = best.s >= CHANGED_WORDING_AT;
            emit({
              ruleId: changed ? "content-changed-wording" : "content-different-wording",
              title: changed
                ? `Wording differs from approved content: “${truncate(best.cand.text, 60)}”`
                : `Text differs substantially from approved content: “${truncate(best.cand.text, 60)}”`,
              message: changed
                ? `The approved text “${truncate(b.text, 200)}” appears on ${pt.path} with changed wording (similarity ${best.s.toFixed(2)}).`
                : `The closest text on ${pt.path} to the approved “${truncate(b.text, 200)}” is only partly the same (similarity ${best.s.toFixed(2)}); it may have been rewritten.`,
              verdict: changed ? strength(c) : "potential",
              severity: heading ? "medium" : "low",
              actual: best.cand.text,
              selector: best.cand.selector,
              extra: [
                {
                  kind: "text_diff",
                  data: {
                    reference: b.text,
                    website: best.cand.text,
                    similarity: Math.round(best.s * 100) / 100,
                    element: best.cand.selector,
                    diff: wordDiff(best.cand.text, b.text),
                  },
                },
              ],
              itemDetail: `${changed ? "Changed wording" : "Rewritten"} (similarity ${best.s.toFixed(2)})`,
            });
            continue;
          }
          emit({
            ruleId: "content-missing",
            title: `${heading ? "Heading" : "Content"} missing: “${truncate(b.text, 60)}”`,
            message: `The approved ${b.type.replace("_", " ")} “${truncate(b.text, 200)}” was not found on ${pt.path}${best ? ` (closest text similarity ${best.s.toFixed(2)})` : ""}.`,
            verdict: strength(c),
            severity: "medium",
            actual: null,
            itemDetail: `Not found on the mapped page${best ? ` (best similarity ${best.s.toFixed(2)})` : ""}`,
          });
        }
      }
    }
    checks.notes!.push(
      "Matching ignores case for “present” checks, typographic quote/dash variants, whitespace and trailing punctuation; case-only differences are reported for review.",
      `Wording counts as changed at ≥ ${CHANGED_WORDING_AT} similarity and as rewritten at ≥ ${REWRITE_AT}; below that the text is reported missing. Mismatches are confirmed only on pages mapped with confidence ≥ ${CONFIRM_AT} (explicit mapping).`,
    );
    const r = done("completed", "");
    const cmp = r.checks.comparison!;
    r.statusReason = `${ref.documents.length} document(s), ${checks.evaluated} block(s): ${cmp.matched} matched, ${cmp.confirmedMismatch} mismatched, ${cmp.potentialMismatch} need review, ${cmp.unableToVerify} unable to verify`;
    return r;
  },
};
