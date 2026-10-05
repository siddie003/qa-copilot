import { createHash } from "node:crypto";
import { FINDING_SOURCES, SEVERITIES, type Severity } from "@qa/core";
import type { FindingVerdict, GroupFacts, IssueGroup, IssueVerdict, ScanFinding } from "./types";

/**
 * Deterministic pre-grouping. Findings of the same rule become one issue ("Meta description
 * missing on 4 pages"); design and content comparisons describe one reference value per finding,
 * so each of their findings is its own issue. Changing the rules changes issue identities, hence
 * the version in the fingerprint.
 */
export const GROUPING_VERSION = "issue-v1";

const PER_FINDING_CATEGORIES = new Set(["design", "content"]);

/** critical = 5 … info = 1 */
export const severityRank = (s: Severity) => SEVERITIES.length - SEVERITIES.indexOf(s);

const categoryOrder = (c: string) => {
  const i = (FINDING_SOURCES as readonly string[]).indexOf(c);
  return i === -1 ? FINDING_SOURCES.length : i;
};

const maxSeverity = (findings: ScanFinding[]): Severity =>
  findings.reduce<Severity>(
    (worst, f) => (severityRank(f.severity) > severityRank(worst) ? f.severity : worst),
    "info",
  );

export function groupFindings(findings: ScanFinding[]): IssueGroup[] {
  const groups = new Map<
    string,
    { key: string; identity: string; category: string; ruleId: string; findings: ScanFinding[] }
  >();
  for (const f of findings) {
    const perFinding = PER_FINDING_CATEGORIES.has(f.scanner);
    const identity = perFinding
      ? `${f.scanner}\n${f.ruleId}\n${f.fingerprint}`
      : `${f.scanner}\n${f.ruleId}`;
    const g = groups.get(identity) ?? {
      key: `${f.scanner}/${f.ruleId}${perFinding ? `/${f.fingerprint.slice(0, 12)}` : ""}`,
      identity,
      category: f.scanner,
      ruleId: f.ruleId,
      findings: [],
    };
    g.findings.push(f);
    groups.set(identity, g);
  }
  const sorted = [...groups.values()]
    .map((g) => ({
      ...g,
      findings: [...g.findings].sort(
        (a, b) =>
          severityRank(b.severity) - severityRank(a.severity) ||
          a.displayId.localeCompare(b.displayId, "en", { numeric: true }),
      ),
    }))
    .sort(
      (a, b) =>
        severityRank(maxSeverity(b.findings)) - severityRank(maxSeverity(a.findings)) ||
        categoryOrder(a.category) - categoryOrder(b.category) ||
        a.ruleId.localeCompare(b.ruleId) ||
        a.key.localeCompare(b.key),
    );
  return sorted.map((g, i) => ({
    id: `G${i + 1}`,
    fingerprint: createHash("sha256").update(`${GROUPING_VERSION}\n${g.identity}`).digest("hex"),
    key: g.key,
    category: g.category,
    ruleId: g.ruleId,
    findings: g.findings,
  }));
}

const isHttpUrl = (v: unknown): v is string => typeof v === "string" && /^https?:\/\//i.test(v);

/**
 * Pages a finding affects: its own page plus page URLs its evidence lists (site-wide findings
 * such as "header missing on 12 pages" keep them in the evidence). Link targets and resource
 * URLs are not pages and are not collected.
 */
export function affectedPages(findings: ScanFinding[], max = 100): string[] {
  const out = new Set<string>();
  const add = (v: unknown) => {
    if (isHttpUrl(v) && out.size < max) out.add(v);
  };
  const addList = (v: unknown) => {
    const list = Array.isArray(v)
      ? v
      : v && typeof v === "object" && Array.isArray((v as { items?: unknown }).items)
        ? (v as { items: unknown[] }).items
        : [];
    for (const x of list) add(x);
  };
  for (const f of findings) add(f.pageUrl);
  for (const f of findings)
    for (const e of f.evidence) {
      const d = e.data;
      for (const key of ["page", "firstSeenOn", "scannedUrl", "requested"]) add(d[key]);
      addList(d.pages);
      for (const key of ["observations", "linkedFrom"]) {
        const rows = d[key];
        if (!Array.isArray(rows)) continue;
        for (const row of rows)
          if (row && typeof row === "object") {
            const r = row as Record<string, unknown>;
            add(r.page);
            if (key === "observations") add(r.url);
          }
      }
    }
  return [...out];
}

export function groupFacts(g: IssueGroup): GroupFacts {
  const severity = maxSeverity(g.findings);
  const verdictCounts: Partial<Record<FindingVerdict, number>> = {};
  for (const f of g.findings) verdictCounts[f.verdict] = (verdictCounts[f.verdict] ?? 0) + 1;
  const hasConfirmed = (verdictCounts.confirmed ?? 0) > 0;
  const verdict: IssueVerdict = hasConfirmed
    ? "confirmed"
    : (verdictCounts.potential ?? 0) > 0
      ? "potential"
      : "inconclusive";
  const pages = affectedPages(g.findings);
  const viewports = new Set<string>();
  for (const f of g.findings) {
    if (f.viewport) viewports.add(f.viewport);
    for (const e of f.evidence) {
      const v = e.data.viewports;
      if (Array.isArray(v)) for (const x of v) if (typeof x === "string") viewports.add(x);
    }
  }
  const selectors = [...new Set(g.findings.map((f) => f.selector).filter((s): s is string => !!s))];
  const rank = severityRank(severity);
  return {
    findingCount: g.findings.length,
    pageCount: pages.length,
    elementCount: selectors.length,
    pages,
    viewports: [...viewports],
    selectors,
    severity,
    verdict,
    verdictCounts,
    hasConfirmed,
    confidence: Math.round(Math.max(...g.findings.map((f) => f.confidence)) * 100) / 100,
    allowedSeverities: SEVERITIES.filter((s) => {
      const r = severityRank(s);
      return Math.abs(r - rank) <= 1 && (hasConfirmed || r <= rank);
    }),
  };
}
