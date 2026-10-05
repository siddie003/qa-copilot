import {
  categoryLabel,
  clip,
  GROUNDING_LABELS,
  SEVERITY_LABELS,
  STATUS_LABELS,
  STEP_STATUS_LABELS,
  VERDICT_LABELS,
} from "./build";
import type { ReportData, ReportFinding, ReportIssue, ReportStep } from "./types";

/**
 * Markdown report. Text that came from scanned websites (titles, messages, selectors, URLs,
 * quotes) is untrusted: it is escaped so it renders as literal text and cannot inject links,
 * images, HTML or headings into the report.
 */

const MD_SPECIAL = /[\\`*_{}[\]()<>#+!|~]/g;

/** Escapes inline text (single line). */
export function mdText(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/[\r\n]+/g, " ")
    .replace(/&/g, "&amp;")
    .replace(MD_SPECIAL, (c) => (c === "<" ? "&lt;" : c === ">" ? "&gt;" : `\\${c}`));
}

/** Escapes multi-line text, keeping line breaks; lines cannot start lists or headings. */
export function mdBlock(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .split(/\r?\n/)
    .map((line) => mdText(line).replace(/^(\s*)([-=]|\d+\.)/, "$1\\$2"))
    .join("  \n");
}

/** Inline code span that can contain any characters (backticks included). */
export function mdCode(value: string | null | undefined): string {
  if (!value) return "";
  const text = value.replace(/[\r\n]+/g, " ");
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") || text.startsWith(" ") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

export function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

const MAX_URLS = 25;
const MAX_INCONCLUSIVE = 20;

function table(head: string[], rows: string[][]): string {
  return [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");
}

function stepState(s: ReportStep): string {
  const label = STEP_STATUS_LABELS[s.status] ?? s.status;
  return s.status === "failed" ? `**${label}**` : label;
}

/**
 * One source finding. Expected/actual values already shown on the issue are not repeated, and
 * very long values are clipped (the JSON report has them in full).
 */
function findingLine(f: ReportFinding, parent?: Pick<ReportIssue, "expected" | "actual">): string {
  const parts = [
    `${mdCode(f.id)} ${mdText(f.title)}`,
    VERDICT_LABELS[f.verdict] ?? f.verdict,
    f.pageUrl ? `page ${mdCode(f.pageUrl)}` : "site-wide",
    f.selector ? `element ${mdCode(clip(f.selector, 160))}` : null,
    f.viewport ? `viewport ${mdText(f.viewport)}` : null,
  ].filter(Boolean);
  const values = [
    f.expected && f.expected !== parent?.expected ? `expected: ${mdText(clip(f.expected))}` : null,
    f.actual && f.actual !== parent?.actual ? `actual: ${mdText(clip(f.actual))}` : null,
  ].filter(Boolean);
  return `- ${parts.join(" · ")}${values.length ? `  \n  ${values.join(" · ")}` : ""}`;
}

function issueSection(i: ReportIssue): string {
  const out: string[] = [];
  out.push(`### ${mdText(i.id)}: ${mdText(i.title)}`);
  out.push("");
  const facts: string[][] = [
    ["Severity", SEVERITY_LABELS[i.severity] ?? i.severity],
    ["Status", STATUS_LABELS[i.status] ?? i.status],
    ["Verdict", VERDICT_LABELS[i.verdict] ?? i.verdict],
    ["Category", mdText(i.categoryLabel) + (i.ruleId ? ` · ${mdCode(i.ruleId)}` : "")],
    ["Confidence", pct(i.confidence)],
    ["Text", GROUNDING_LABELS[i.grounding] ?? i.grounding],
  ];
  out.push(table(["Field", "Value"], facts));
  out.push("");
  if (i.verdict === "inconclusive" || i.verdict === "unable_to_verify")
    out.push("> Unable to verify from available evidence. Review manually before acting.\n");
  else if (i.verdict === "potential")
    out.push("> Needs review: the evidence suggests a problem but does not confirm it.\n");
  out.push(mdBlock(i.description));
  out.push("");
  out.push("**Affected pages:**");
  if (!i.affectedUrls.length) out.push("Site-wide");
  for (const u of i.affectedUrls.slice(0, MAX_URLS)) out.push(`- ${mdCode(u)}`);
  if (i.affectedUrls.length > MAX_URLS)
    out.push(`- and ${i.affectedUrls.length - MAX_URLS} more (see the JSON report)`);
  out.push("");
  if (i.affectedElement) out.push(`**Element:** ${mdCode(i.affectedElement)}  `);
  if (i.expected) out.push(`**Expected:** ${mdText(i.expected)}  `);
  if (i.actual) out.push(`**Actual:** ${mdText(i.actual)}  `);
  if (i.severityRationale) out.push(`**Severity rationale:** ${mdText(i.severityRationale)}  `);
  if (i.affectedElement || i.expected || i.actual || i.severityRationale) out.push("");
  if (i.recommendation) {
    out.push("**How to fix:**", "", mdBlock(i.recommendation), "");
  }
  out.push(`**Source findings (${i.findings.length}):**`, "");
  for (const f of i.findings) out.push(findingLine(f, i));
  out.push("");
  return out.join("\n");
}

function countList(map: Record<string, number>, labels: Record<string, string>): string {
  const parts = Object.entries(map)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${labels[k] ?? mdText(k)}: ${n}`);
  return parts.length ? parts.join(" · ") : "none";
}

export function renderMarkdown(d: ReportData): string {
  const s = d.scan;
  const out: string[] = [];
  out.push(`# QA report: ${mdText(d.project.name)} · Scan #${s.number}`);
  out.push("");
  out.push(
    `Website ${mdCode(s.websiteUrl)} · scan ${s.statusLabel.toLowerCase()} · generated ${d.generatedAt} by ${mdText(d.generator.name)} ${mdText(d.generator.version)}`,
  );
  out.push("");
  out.push(
    "Every issue in this report is built from scanner findings stored with evidence. Statuses are the tracking statuses at the time the report was generated.",
  );
  out.push("");

  out.push("## Summary", "");
  const iss = d.summary.issues;
  out.push(
    table(
      ["Measure", "Value"],
      [
        ["Issues", `${iss.total} (${iss.outstanding} outstanding)`],
        ["By severity", countList(iss.bySeverity, SEVERITY_LABELS)],
        ["By status", countList(iss.byStatus, STATUS_LABELS)],
        ["By verdict", countList(iss.byVerdict, VERDICT_LABELS)],
        [
          "By category",
          countList(
            iss.byCategory,
            Object.fromEntries(Object.keys(iss.byCategory).map((k) => [k, categoryLabel(k)])),
          ),
        ],
        ["Scanner findings", String(d.summary.findings.total)],
        ["Pages crawled", String(s.pagesCrawled)],
        [
          "Failed steps",
          d.summary.steps.failed.length
            ? d.steps
                .filter((x) => x.status === "failed")
                .map((x) => x.label)
                .join(", ")
            : "none",
        ],
        [
          "Inconclusive steps",
          d.summary.steps.inconclusive.length
            ? d.steps
                .filter((x) => x.status === "inconclusive")
                .map((x) => x.label)
                .join(", ")
            : "none",
        ],
        [
          "AI",
          d.summary.ai.used
            ? `${d.summary.ai.requests} request(s) (${d.summary.ai.failedRequests} failed), ${d.summary.ai.issuesWithAiText} issue(s) with evidence-checked AI text; ${d.summary.ai.models.map(mdText).join(", ")}`
            : "Not used: issue text is the scanners' own wording and the rule catalog's fix guidance",
        ],
      ],
    ),
  );
  out.push("");
  if (s.error) out.push(`> Scan error: ${mdText(s.error)}`, "");

  out.push("## Scan", "");
  out.push(
    table(
      ["Setting", "Value"],
      [
        ["Started", s.startedAt ?? "—"],
        ["Finished", s.finishedAt ?? "—"],
        ["Duration", formatDuration(s.durationMs)],
        [
          "Viewports",
          s.viewports.map((v) => `${mdText(v.name)} ${v.width}×${v.height}`).join(", "),
        ],
        ["Limits", `max ${s.maxPages ?? "—"} pages, depth ${s.maxDepth ?? "—"}`],
        ["robots.txt", s.respectRobots === null ? "—" : s.respectRobots ? "respected" : "ignored"],
        ["Site credentials", s.siteCredentials ? mdText(s.siteCredentials) : "none"],
        [
          "Design reference",
          s.designReferenceVersion !== null ? `version ${s.designReferenceVersion}` : "none",
        ],
        [
          "Content documents",
          s.contentDocuments.length ? s.contentDocuments.map(mdText).join(", ") : "none",
        ],
        ["Technology", s.technology ? mdText(s.technology) : "could not determine"],
      ],
    ),
  );
  out.push("");

  out.push("## Scanners and pipeline steps", "");
  out.push(
    table(
      ["Step", "Result", "Findings", "Duration", "Details"],
      d.steps.map((x) => [
        mdText(x.label),
        stepState(x),
        String(x.findingCount),
        formatDuration(x.durationMs),
        mdText(
          [
            x.error ? `Error: ${x.error}` : x.statusReason,
            x.comparison
              ? `matched ${x.comparison.matched}, mismatched ${x.comparison.confirmedMismatch}, needs review ${x.comparison.potentialMismatch}, unable to verify ${x.comparison.unableToVerify}`
              : null,
            x.tool,
          ]
            .filter(Boolean)
            .join(" · "),
        ),
      ]),
    ),
  );
  out.push("");

  const withInconclusive = d.steps.filter((x) => x.inconclusiveTotal > 0);
  if (withInconclusive.length) {
    out.push("## Inconclusive checks", "");
    out.push(
      "Checks the scanners could not verify. They are not reported as defects and not counted as passed.",
      "",
    );
    for (const x of withInconclusive) {
      out.push(`### ${mdText(x.label)} (${x.inconclusiveTotal})`, "");
      for (const c of x.inconclusiveChecks.slice(0, MAX_INCONCLUSIVE))
        out.push(
          `- ${mdText(c.check)}: ${mdText(c.reason)}${c.pageUrl ? ` (${mdCode(c.pageUrl)})` : ""}`,
        );
      if (x.inconclusiveTotal > MAX_INCONCLUSIVE)
        out.push(`- and ${x.inconclusiveTotal - MAX_INCONCLUSIVE} more (see the JSON report)`);
      out.push("");
    }
  }

  out.push(`## Issues (${d.issues.length})`, "");
  if (!d.issues.length)
    out.push(
      d.unassignedFindings.length
        ? "This scan has no issues (it ran before findings were grouped into issues); its findings are listed below."
        : "No issues: the scanners reported no findings in this scan.",
      "",
    );
  for (const i of d.issues) out.push(issueSection(i));

  if (d.unassignedFindings.length) {
    out.push(`## Findings not grouped into issues (${d.unassignedFindings.length})`, "");
    for (const f of d.unassignedFindings) out.push(findingLine(f));
    out.push("");
  }

  out.push("---", "");
  out.push(
    "Evidence details (HTML snippets, headers, measurements, screenshots) are stored with each finding and included in the JSON report and the QA Copilot app.",
  );
  return out.join("\n") + "\n";
}
