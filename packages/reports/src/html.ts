import {
  categoryLabel,
  clip,
  GROUNDING_LABELS,
  SEVERITY_LABELS,
  STATUS_LABELS,
  STEP_STATUS_LABELS,
  VERDICT_LABELS,
} from "./build";
import { formatDuration } from "./markdown";
import type { ReportData, ReportFinding, ReportIssue } from "./types";

/**
 * Self-contained HTML document for the PDF report (rendered by Chromium with JavaScript disabled
 * and all network requests blocked). Every value is HTML-escaped: scanned website content can
 * never become markup. No external fonts, images or scripts.
 */

export function esc(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const multiline = (v: string | null) => esc(v).replace(/\r?\n/g, "<br>");
const pct = (n: number) => `${Math.round(n * 100)}%`;
const MAX_URLS = 25;
const MAX_INCONCLUSIVE = 20;
const MAX_SELECTOR = 160;

const CSS = `
@page { size: A4; margin: 16mm 14mm 18mm; }
* { box-sizing: border-box; }
body { font: 10pt/1.45 system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1f2937; margin: 0; }
h1 { font-size: 19pt; margin: 0 0 4pt; color: #111827; }
h2 { font-size: 13pt; margin: 18pt 0 6pt; padding-bottom: 3pt; border-bottom: 1.5pt solid #e5e7eb; color: #111827; break-after: avoid; }
h3 { font-size: 11pt; margin: 0; color: #111827; }
p { margin: 0 0 6pt; }
.meta { color: #4b5563; font-size: 9pt; }
.note { color: #4b5563; font-size: 9pt; margin-top: 6pt; }
code, .mono { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 8.5pt; overflow-wrap: anywhere; }
table { width: 100%; border-collapse: collapse; margin: 4pt 0 8pt; font-size: 9pt; }
th, td { text-align: left; vertical-align: top; padding: 4pt 6pt; border-bottom: 0.75pt solid #e5e7eb; overflow-wrap: anywhere; }
th { background: #f3f4f6; font-weight: 600; color: #374151; }
tr { break-inside: avoid; }
.tiles { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6pt; margin: 8pt 0; }
.tile { border: 0.75pt solid #e5e7eb; border-radius: 4pt; padding: 6pt 8pt; }
.tile b { display: block; font-size: 15pt; color: #111827; }
.tile span { font-size: 8pt; color: #4b5563; text-transform: uppercase; letter-spacing: .03em; }
.pill { display: inline-block; border-radius: 3pt; padding: 0 4pt; font-size: 8pt; font-weight: 600; white-space: nowrap; }
.sev-critical { background: #b91c1c; color: #fff; }
.sev-high { background: #fee2e2; color: #991b1b; }
.sev-medium { background: #fef3c7; color: #92400e; }
.sev-low { background: #dbeafe; color: #1e40af; }
.sev-info { background: #f3f4f6; color: #374151; }
.st { background: #f3f4f6; color: #374151; }
.nowrap { white-space: nowrap; overflow-wrap: normal; }
.failed { color: #b91c1c; font-weight: 600; }
.inconclusive { color: #92400e; font-weight: 600; }
.issue { border: 0.75pt solid #d1d5db; border-radius: 4pt; padding: 8pt 10pt; margin: 0 0 8pt; }
.issue-head { break-after: avoid; }
.issue-id { font-family: ui-monospace, Consolas, monospace; color: #4b5563; font-size: 8.5pt; }
.badges { margin: 3pt 0 6pt; display: flex; flex-wrap: wrap; gap: 4pt; }
.callout { border-left: 2.5pt solid #d97706; background: #fffbeb; padding: 4pt 8pt; margin: 4pt 0 6pt; font-size: 9pt; }
dl { display: grid; grid-template-columns: 26mm 1fr; gap: 2pt 8pt; margin: 4pt 0 6pt; font-size: 9pt; }
dt { color: #4b5563; }
dd { margin: 0; overflow-wrap: anywhere; }
ul { margin: 2pt 0 6pt; padding-left: 14pt; }
li { margin: 1pt 0; }
.label { font-size: 8pt; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: #4b5563; margin: 6pt 0 2pt; }
.findings li { font-size: 8.5pt; }
`;

function pill(text: string, cls: string) {
  return `<span class="pill ${cls}">${esc(text)}</span>`;
}

function counts(map: Record<string, number>, labels: Record<string, string>) {
  const parts = Object.entries(map)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${esc(labels[k] ?? k)}: ${n}`);
  return parts.length ? parts.join(" · ") : "none";
}

/**
 * One source finding. Expected/actual values already shown on the issue are not repeated, and
 * very long values are clipped (the JSON report has them in full).
 */
function finding(f: ReportFinding, parent?: Pick<ReportIssue, "expected" | "actual">) {
  const bits = [
    `<span class="mono">${esc(f.id)}</span> ${esc(f.title)}`,
    esc(VERDICT_LABELS[f.verdict] ?? f.verdict),
    f.pageUrl ? `page <code>${esc(f.pageUrl)}</code>` : "site-wide",
    f.selector ? `element <code>${esc(clip(f.selector, MAX_SELECTOR))}</code>` : "",
    f.viewport ? `viewport ${esc(f.viewport)}` : "",
    f.expected && f.expected !== parent?.expected ? `expected: ${esc(clip(f.expected))}` : "",
    f.actual && f.actual !== parent?.actual ? `actual: ${esc(clip(f.actual))}` : "",
  ].filter(Boolean);
  return `<li>${bits.join(" · ")}</li>`;
}

function issue(i: ReportIssue) {
  const unverified = i.verdict === "inconclusive" || i.verdict === "unable_to_verify";
  const urls = i.affectedUrls.length
    ? `<ul>${i.affectedUrls
        .slice(0, MAX_URLS)
        .map((u) => `<li><code>${esc(u)}</code></li>`)
        .join("")}${
        i.affectedUrls.length > MAX_URLS
          ? `<li>and ${i.affectedUrls.length - MAX_URLS} more (see the JSON report)</li>`
          : ""
      }</ul>`
    : "Site-wide";
  const rows = [
    ["Category", `${esc(i.categoryLabel)}${i.ruleId ? ` · <code>${esc(i.ruleId)}</code>` : ""}`],
    ["Affected pages", urls],
    i.affectedElement ? ["Element", `<code>${esc(i.affectedElement)}</code>`] : null,
    i.expected ? ["Expected", esc(i.expected)] : null,
    i.actual ? ["Actual", esc(i.actual)] : null,
    ["Severity", esc(i.severityRationale ?? SEVERITY_LABELS[i.severity] ?? i.severity)],
    ["Confidence", pct(i.confidence)],
    ["Text", esc(GROUNDING_LABELS[i.grounding] ?? i.grounding)],
  ].filter((r): r is string[] => Boolean(r));
  return `<section class="issue">
  <div class="issue-head">
    <div class="issue-id">${esc(i.id)}</div>
    <h3>${esc(i.title)}</h3>
    <div class="badges">${pill(SEVERITY_LABELS[i.severity] ?? i.severity, `sev-${esc(i.severity)}`)}${pill(
      STATUS_LABELS[i.status] ?? i.status,
      "st",
    )}${pill(VERDICT_LABELS[i.verdict] ?? i.verdict, "st")}</div>
  </div>
  ${
    unverified
      ? `<div class="callout">Unable to verify from available evidence. Review manually before acting.</div>`
      : i.verdict === "potential"
        ? `<div class="callout">Needs review: the evidence suggests a problem but does not confirm it.</div>`
        : ""
  }
  <p>${multiline(i.description)}</p>
  <dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
  ${i.recommendation ? `<div class="label">How to fix</div><p>${multiline(i.recommendation)}</p>` : ""}
  <div class="label">Source findings (${i.findings.length})</div>
  <ul class="findings">${i.findings.map((f) => finding(f, i)).join("")}</ul>
</section>`;
}

export function renderHtml(d: ReportData): string {
  const s = d.scan;
  const iss = d.summary.issues;
  const stepRows = d.steps
    .map((x) => {
      const cls =
        x.status === "failed" ? "failed" : x.status === "inconclusive" ? "inconclusive" : "";
      const details = [
        x.error ? `Error: ${esc(x.error)}` : esc(x.statusReason),
        x.comparison
          ? `matched ${x.comparison.matched}, mismatched ${x.comparison.confirmedMismatch}, needs review ${x.comparison.potentialMismatch}, unable to verify ${x.comparison.unableToVerify}`
          : "",
        x.tool ? `<span class="meta">${esc(x.tool)}</span>` : "",
      ]
        .filter(Boolean)
        .join("<br>");
      return `<tr><td>${esc(x.label)}</td><td class="nowrap ${cls}">${esc(STEP_STATUS_LABELS[x.status] ?? x.status)}</td><td class="nowrap">${x.findingCount}</td><td class="nowrap">${esc(formatDuration(x.durationMs))}</td><td>${details}</td></tr>`;
    })
    .join("");
  const inconclusive = d.steps.filter((x) => x.inconclusiveTotal > 0);
  const failedSteps = d.steps.filter((x) => x.status === "failed").map((x) => x.label);
  const inconclusiveSteps = d.steps.filter((x) => x.status === "inconclusive").map((x) => x.label);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>QA report: ${esc(d.project.name)} · Scan #${s.number}</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <h1>QA report: ${esc(d.project.name)}</h1>
  <p class="meta">Scan #${s.number} of <code>${esc(s.websiteUrl)}</code> · ${esc(s.statusLabel)} · generated ${esc(d.generatedAt)} by ${esc(d.generator.name)} ${esc(d.generator.version)}</p>
  <p class="note">Every issue is built from scanner findings stored with evidence. Statuses are tracking statuses at the time the report was generated.</p>
</header>

<h2>Summary</h2>
<div class="tiles">
  <div class="tile"><b>${iss.total}</b><span>Issues</span></div>
  <div class="tile"><b>${iss.outstanding}</b><span>Outstanding</span></div>
  <div class="tile"><b>${(iss.bySeverity.critical ?? 0) + (iss.bySeverity.high ?? 0)}</b><span>Critical + high</span></div>
  <div class="tile"><b>${d.summary.findings.total}</b><span>Findings</span></div>
  <div class="tile"><b>${s.pagesCrawled}</b><span>Pages crawled</span></div>
</div>
<table>
  <tr><th style="width:32mm">By severity</th><td>${counts(iss.bySeverity, SEVERITY_LABELS)}</td></tr>
  <tr><th>By status</th><td>${counts(iss.byStatus, STATUS_LABELS)}</td></tr>
  <tr><th>By verdict</th><td>${counts(iss.byVerdict, VERDICT_LABELS)}</td></tr>
  <tr><th>By category</th><td>${counts(iss.byCategory, Object.fromEntries(Object.keys(iss.byCategory).map((k) => [k, categoryLabel(k)])))}</td></tr>
  <tr><th>Failed steps</th><td>${failedSteps.length ? `<span class="failed">${esc(failedSteps.join(", "))}</span>` : "none"}</td></tr>
  <tr><th>Inconclusive steps</th><td>${inconclusiveSteps.length ? `<span class="inconclusive">${esc(inconclusiveSteps.join(", "))}</span>` : "none"}</td></tr>
  <tr><th>AI</th><td>${
    d.summary.ai.used
      ? `${d.summary.ai.requests} request(s) (${d.summary.ai.failedRequests} failed), ${d.summary.ai.issuesWithAiText} issue(s) with evidence-checked AI text · ${esc(d.summary.ai.models.join(", "))}`
      : "Not used: issue text is the scanners' own wording and the rule catalog's fix guidance"
  }</td></tr>
</table>
${s.error ? `<div class="callout">Scan error: ${esc(s.error)}</div>` : ""}

<h2>Scan</h2>
<table>
  <tr><th style="width:32mm">Started</th><td>${esc(s.startedAt ?? "—")}</td></tr>
  <tr><th>Finished</th><td>${esc(s.finishedAt ?? "—")}</td></tr>
  <tr><th>Duration</th><td>${esc(formatDuration(s.durationMs))}</td></tr>
  <tr><th>Viewports</th><td>${s.viewports.map((v) => `${esc(v.name)} ${v.width}×${v.height}`).join(", ")}</td></tr>
  <tr><th>Limits</th><td>max ${s.maxPages ?? "—"} pages, depth ${s.maxDepth ?? "—"}; robots.txt ${s.respectRobots === null ? "—" : s.respectRobots ? "respected" : "ignored"}</td></tr>
  <tr><th>Site credentials</th><td>${s.siteCredentials ? esc(s.siteCredentials) : "none"}</td></tr>
  <tr><th>Design reference</th><td>${s.designReferenceVersion !== null ? `version ${s.designReferenceVersion}` : "none"}</td></tr>
  <tr><th>Content documents</th><td>${s.contentDocuments.length ? esc(s.contentDocuments.join(", ")) : "none"}</td></tr>
  <tr><th>Technology</th><td>${s.technology ? esc(s.technology) : "could not determine"}</td></tr>
</table>

<h2>Scanners and pipeline steps</h2>
<table>
  <tr><th style="width:30mm">Step</th><th class="nowrap">Result</th><th class="nowrap">Findings</th><th class="nowrap">Duration</th><th>Details</th></tr>
  ${stepRows}
</table>

${
  inconclusive.length
    ? `<h2>Inconclusive checks</h2>
<p class="note">Checks the scanners could not verify. They are not reported as defects and not counted as passed.</p>
${inconclusive
  .map(
    (x) =>
      `<div class="label">${esc(x.label)} (${x.inconclusiveTotal})</div><ul>${x.inconclusiveChecks
        .slice(0, MAX_INCONCLUSIVE)
        .map(
          (c) =>
            `<li>${esc(c.check)}: ${esc(c.reason)}${c.pageUrl ? ` (<code>${esc(c.pageUrl)}</code>)` : ""}</li>`,
        )
        .join("")}${
        x.inconclusiveTotal > MAX_INCONCLUSIVE
          ? `<li>and ${x.inconclusiveTotal - MAX_INCONCLUSIVE} more (see the JSON report)</li>`
          : ""
      }</ul>`,
  )
  .join("")}`
    : ""
}

<h2>Issues (${d.issues.length})</h2>
${
  d.issues.length
    ? d.issues.map(issue).join("\n")
    : `<p>${
        d.unassignedFindings.length
          ? "This scan has no issues (it ran before findings were grouped into issues); its findings are listed below."
          : "No issues: the scanners reported no findings in this scan."
      }</p>`
}
${
  d.unassignedFindings.length
    ? `<h2>Findings not grouped into issues (${d.unassignedFindings.length})</h2><ul class="findings">${d.unassignedFindings.map((f) => finding(f)).join("")}</ul>`
    : ""
}
<p class="note">Evidence details (HTML snippets, headers, measurements, screenshots) are stored with each finding and included in the JSON report and the QA Copilot app.</p>
</body>
</html>
`;
}
