import { CONFIDENCE_EXPLANATION, SEVERITY_MEANINGS, VERDICT_MEANINGS } from "@qa/core/explain";
import {
  buildIssueGuide,
  type AiExplanation,
  type CodeExample,
  type GuideEvidence,
  type IssueGuide,
} from "@qa/core/fix-guide";
import type { Severity } from "@qa/core/domain";
import { CopyButton } from "@/components/issues/copy-button";
import { SeverityBadge } from "@/components/ui/badges";
import { Card } from "@/components/ui/stat";

/** The stored occurrence fields the explanation is built from (all from the scan records). */
export interface ExplainedOccurrence {
  category: string;
  ruleId: string | null;
  severity: string;
  severityRationale: string | null;
  affectedUrls: string[];
  affectedElement: string | null;
  expected: string | null;
  actual: string | null;
  recommendation: string | null;
  confidence: number;
  verdict: string;
  groundingStatus: string;
  /** Grounded AI explanation stored with the issue (null without AI text). */
  explanation?: AiExplanation | null;
  findings: Array<{
    displayId: string;
    viewport: string | null;
    selector: string | null;
    pageUrl: string | null;
    expected: string | null;
    actual: string | null;
    evidence: GuideEvidence[];
  }>;
}

const MAX_PAGES = 5;

/** What the issue's workflow status means for the fix (never claims a fix was verified). */
export const FIX_STATUS_NOTES: Record<string, string> = {
  resolved:
    "A person marked this issue resolved. That is not yet a confirmation: a later scan that checks the same pages again either finds it (the issue is reopened automatically) or does not (the scan comparison on the History tab lists it as Resolved).",
  reopened:
    "A scan found this issue again after it had been marked resolved, so the earlier fix did not take effect or was not published.",
  in_progress:
    "Someone is working on this issue. The fix is not verified until a later scan re-checks it.",
  ignored:
    "Marked as ignored: kept in the record, but not counted as open work. Scans still report it if they find it.",
};

const AI_TEXT = new Set(["passed", "partial"]);

const AI_LABEL = "Written by AI from this issue's evidence and checked automatically";
const RULE_LABEL = "Built-in guidance for this rule, filled in with this issue's scan data";

/** Renders `code` spans and http(s) links inside guide text (all text is escaped by React). */
export function RichText({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`|https?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:)])/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("`") && p.endsWith("`") && p.length > 2 ? (
          <code
            key={i}
            className="break-all rounded bg-surface-muted px-1 py-0.5 font-mono text-[0.8125rem]"
          >
            {p.slice(1, -1)}
          </code>
        ) : /^https?:\/\//.test(p) ? (
          <a
            key={i}
            href={p}
            target="_blank"
            rel="noopener noreferrer"
            className="break-all text-primary underline"
          >
            {p}
          </a>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 py-3 first:pt-0 last:pb-0 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-4">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <div className="min-w-0 space-y-1.5 text-sm leading-relaxed">{children}</div>
    </div>
  );
}

function SourceNote({ ai }: { ai: boolean }) {
  return <p className="text-xs text-muted">{ai ? AI_LABEL : RULE_LABEL}.</p>;
}

export function CodeBlock({
  code,
  label,
  copy,
}: {
  code: string;
  label: string;
  /** Show a copy button (suggested code only). */
  copy?: boolean;
}) {
  return (
    <figure className="min-w-0">
      <figcaption className="mb-1 flex items-center justify-between gap-2 text-xs font-medium text-muted">
        <span>{label}</span>
        {copy && <CopyButton text={code} label={`Copy: ${label}`} />}
      </figcaption>
      <pre
        tabIndex={0}
        aria-label={label}
        className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-surface-muted p-3 font-mono text-xs leading-relaxed"
      >
        <code>{code}</code>
      </pre>
    </figure>
  );
}

const BEFORE_LABELS: Record<string, string> = {
  observed: "Before — copied from the scan evidence",
  illustrative: "Before — illustrative (minimal form of the observed problem)",
};

function Example({ example: x, level = 3 }: { example: CodeExample; level?: 3 | 4 }) {
  const Heading = level === 3 ? "h3" : "h4";
  return (
    <div className="space-y-3 rounded-md border border-border p-3 sm:p-4">
      <Heading className="text-sm font-semibold">{x.title}</Heading>
      <div className="grid gap-3 lg:grid-cols-2">
        {x.before !== null && x.beforeOrigin && (
          <CodeBlock code={x.before} label={BEFORE_LABELS[x.beforeOrigin]!} />
        )}
        <div className={x.before === null ? "lg:col-span-2" : undefined}>
          <CodeBlock code={x.after} label="After — suggested change (adapt to your code)" copy />
        </div>
      </div>
      <p className="text-sm leading-relaxed">
        <RichText text={x.explanation} />
      </p>
    </div>
  );
}

function PageList({ urls }: { urls: string[] }) {
  return (
    <ul className="space-y-0.5">
      {urls.slice(0, MAX_PAGES).map((u) => (
        <li key={u} className="break-all text-muted">
          {u}
        </li>
      ))}
      {urls.length > MAX_PAGES && (
        <li className="text-xs text-subtle">
          and {urls.length - MAX_PAGES} more (listed under Technical details and evidence)
        </li>
      )}
    </ul>
  );
}

/** The guide for an occurrence (exported for tests and other views of the same issue). */
export function guideFor(o: ExplainedOccurrence): IssueGuide {
  return buildIssueGuide({
    category: o.category,
    ruleId: o.ruleId,
    verdict: o.verdict,
    affectedUrls: o.affectedUrls,
    affectedElement: o.affectedElement,
    recommendation: o.recommendation,
    findings: o.findings,
    // AI text is used only when grounding accepted at least part of it.
    explanation: AI_TEXT.has(o.groundingStatus) ? (o.explanation ?? null) : null,
  });
}

/**
 * Plain-language explanation of one issue occurrence: summary, where it was found, how to fix it,
 * example code, and how to verify the fix. The wording comes from the fixed rule guides in
 * `@qa/core/fix-guide` (or grounded AI text); every page, element, value and code snippet is read
 * from the stored occurrence and its findings' evidence.
 */
export function PlainExplanation({
  occurrence: o,
  status,
  scanLabel,
}: {
  occurrence: ExplainedOccurrence;
  status: string;
  /** "Scan #3 · 11 Oct 2026, 10:05", shown with the summary. */
  scanLabel?: string;
}) {
  const g = guideFor(o);
  const ai = new Set(g.aiParts);
  const verdict = VERDICT_MEANINGS[o.verdict];
  const viewports = [...new Set(o.findings.map((f) => f.viewport).filter(Boolean))] as string[];
  const fixNote = FIX_STATUS_NOTES[status];
  const aiRecommendation = AI_TEXT.has(o.groundingStatus) && !ai.has("steps") && o.recommendation;
  const summaryAi = ai.has("problem") || ai.has("whyItMatters") || ai.has("nextAction");

  return (
    <>
      <Card
        title="In plain language"
        anchor="summary"
        action={scanLabel ? <span className="text-xs text-muted">{scanLabel}</span> : undefined}
      >
        {o.verdict !== "confirmed" && (
          <p
            role="note"
            className="mb-3 rounded-md border border-warning/40 bg-warning-bg px-3 py-2 text-sm"
          >
            <span className="font-semibold">{verdict?.label ?? "Needs review"}:</span>{" "}
            {verdict?.meaning}
          </p>
        )}
        <div className="divide-y divide-border">
          <Block title="What is the problem?">
            <p className="text-base">
              <RichText text={g.problem} />
            </p>
          </Block>
          <Block title="Why does it matter?">
            <p>
              <RichText text={g.whyItMatters} />
            </p>
          </Block>
          <Block title="What should I do next?">
            <p className="font-medium">
              <RichText text={g.nextAction} />
            </p>
          </Block>
          <Block title="How serious">
            <p className="flex flex-wrap items-center gap-2">
              <SeverityBadge severity={o.severity} />
              <span>{SEVERITY_MEANINGS[o.severity as Severity] ?? ""}</span>
            </p>
            {o.severityRationale && <p className="text-muted">{o.severityRationale}</p>}
          </Block>
        </div>
        <div className="mt-3 border-t border-border pt-3">
          <SourceNote ai={summaryAi} />
          {!g.specific && (
            <p className="text-xs text-muted">
              General explanation for this kind of check; the technical details name the exact rule.
            </p>
          )}
        </div>
      </Card>

      <Card title="Where it was found">
        <div className="divide-y divide-border">
          <Block title="Pages">
            {o.affectedUrls.length === 0 ? (
              <p>The whole site (not tied to one page).</p>
            ) : (
              <>
                <p>
                  {o.affectedUrls.length === 1 ? "1 page" : `${o.affectedUrls.length} pages`}
                  {viewports.length > 0 && ` · screen sizes: ${viewports.join(", ")}`}
                </p>
                <PageList urls={o.affectedUrls} />
              </>
            )}
          </Block>
          {o.affectedElement && (
            <Block title="Element">
              <code className="break-all font-mono text-xs">{o.affectedElement}</code>
            </Block>
          )}
          {g.snippet && (
            <Block title="Recorded HTML">
              <CodeBlock
                code={g.snippet.html}
                label={`As recorded by the scanner (finding ${g.snippet.findingId})`}
              />
            </Block>
          )}
          {g.facts.length > 0 && (
            <Block title="What the scan recorded">
              <dl className="grid gap-x-3 gap-y-1.5 sm:grid-cols-[minmax(8rem,12rem)_minmax(0,1fr)]">
                {g.facts.map((f, i) => (
                  <div key={i} className="contents">
                    <dt className="text-muted">{f.label}</dt>
                    <dd className={f.code ? "break-all font-mono text-xs" : "break-words"}>
                      {f.value}
                    </dd>
                  </div>
                ))}
              </dl>
            </Block>
          )}
          <Block title="Evidence">
            <p>
              {o.findings.length === 1
                ? "1 scanner finding is the evidence for this issue."
                : `${o.findings.length} scanner findings are the evidence for this issue.`}{" "}
              <a href="#evidence" className="text-primary underline">
                See the evidence
              </a>
            </p>
          </Block>
        </div>
      </Card>

      <Card title="How to fix it" anchor="fix">
        <ol className="list-decimal space-y-2 pl-5 text-sm leading-relaxed marker:font-semibold marker:text-muted">
          {g.steps.map((s, i) => (
            <li key={i} className="pl-1">
              <RichText text={s} />
            </li>
          ))}
        </ol>
        <div className="mt-2">
          <SourceNote ai={ai.has("steps")} />
        </div>
        {aiRecommendation && (
          <div className="mt-4 rounded-md border border-border bg-surface-muted/50 p-3 text-sm">
            <h3 className="mb-1 font-semibold">AI suggestion for this issue</h3>
            <p className="whitespace-pre-line break-words">{o.recommendation}</p>
            <p className="mt-1 text-xs text-muted">{AI_LABEL}.</p>
          </div>
        )}
        {g.caveats.length > 0 && (
          <div className="mt-4">
            <h3 className="mb-1 text-sm font-semibold">Before you change it</h3>
            <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed">
              {g.caveats.map((c, i) => (
                <li key={i}>
                  <RichText text={c} />
                </li>
              ))}
            </ul>
          </div>
        )}
        {g.gaps.length > 0 && (
          <div className="mt-4 rounded-md border border-info/30 bg-info-bg px-3 py-2">
            <h3 className="mb-1 text-sm font-semibold">What the scan could not tell</h3>
            <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed">
              {g.gaps.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          </div>
        )}
        <p className="mt-4 text-xs text-muted">
          A suggested fix is not verified until a later scan confirms the problem is gone.
        </p>
      </Card>

      {g.examples.length > 0 && (
        <Card title="Example fix" anchor="example">
          <p className="mb-3 text-sm text-muted">
            Suggested code, not taken from your source files. Text in [square brackets] is a
            placeholder for something only you can decide.
          </p>
          <div className="space-y-4">
            {g.examples.map((x, i) => (
              <Example key={i} example={x} />
            ))}
          </div>
        </Card>
      )}

      <Card title="How to verify the fix" anchor="verify">
        <ol className="list-decimal space-y-2 pl-5 text-sm leading-relaxed marker:font-semibold marker:text-muted">
          {g.verify.map((s, i) => (
            <li key={i} className="pl-1">
              <RichText text={s} />
            </li>
          ))}
        </ol>
        {fixNote && <p className="mt-3 rounded-md bg-surface-muted px-3 py-2 text-sm">{fixNote}</p>}
      </Card>
    </>
  );
}

/**
 * Compact summary for issue lists (no evidence loaded): the three questions and a link to the
 * full guide on the issue page.
 */
export function PlainSummary({
  issue: o,
  href,
}: {
  issue: Omit<ExplainedOccurrence, "findings" | "confidence" | "severity" | "severityRationale">;
  href: string;
}) {
  const g = buildIssueGuide({
    ...o,
    findings: [],
    explanation: AI_TEXT.has(o.groundingStatus) ? (o.explanation ?? null) : null,
  });
  return (
    <div className="rounded-md border border-border bg-surface-muted/40 p-3">
      <dl className="grid gap-x-4 gap-y-1.5 sm:grid-cols-[11rem_minmax(0,1fr)]">
        <dt className="font-semibold">What is the problem?</dt>
        <dd>
          <RichText text={g.problem} />
        </dd>
        <dt className="font-semibold">Why does it matter?</dt>
        <dd>
          <RichText text={g.whyItMatters} />
        </dd>
        <dt className="font-semibold">What should I do next?</dt>
        <dd>
          <RichText text={g.nextAction} />
        </dd>
      </dl>
      <a href={href} className="mt-2 inline-block text-sm font-medium text-primary underline">
        Step-by-step fix, example code and how to verify it
      </a>
    </div>
  );
}

/** One raw scanner finding as the guide reads it (scan findings page). */
export interface ExplainedFinding {
  displayId: string;
  scanner: string;
  ruleId: string;
  verdict: string;
  viewport: string | null;
  selector: string | null;
  pageUrl: string | null;
  expected: string | null;
  actual: string | null;
  evidence: GuideEvidence[];
}

function SubHeading({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-1.5 text-sm font-semibold text-foreground">{children}</h3>;
}

/**
 * The fix guide for a single raw finding (scan findings page): the same built-in guidance as the
 * issue page, filled in with this finding's own evidence. Raw findings never carry AI text.
 */
export function FindingGuide({
  finding: f,
  issueHref,
  issueLabel,
}: {
  finding: ExplainedFinding;
  /** Link to the tracked issue this finding belongs to (status, history, other findings). */
  issueHref?: string;
  issueLabel?: string;
}) {
  const g = buildIssueGuide({
    category: f.scanner,
    ruleId: f.ruleId,
    verdict: f.verdict,
    affectedUrls: f.pageUrl ? [f.pageUrl] : [],
    affectedElement: f.selector,
    recommendation: null,
    findings: [f],
    explanation: null,
  });
  const verdict = VERDICT_MEANINGS[f.verdict];
  return (
    <div className="space-y-5">
      {f.verdict !== "confirmed" && (
        <p role="note" className="rounded-md border border-warning/40 bg-warning-bg px-3 py-2">
          <span className="font-semibold">{verdict?.label ?? "Needs review"}:</span>{" "}
          {verdict?.meaning}
        </p>
      )}
      <dl className="grid gap-x-4 gap-y-3 rounded-md border border-border bg-surface-muted/40 p-3 sm:grid-cols-[11rem_minmax(0,1fr)]">
        <dt className="font-semibold">What is the problem?</dt>
        <dd className="leading-relaxed">
          <RichText text={g.problem} />
        </dd>
        <dt className="font-semibold">Why does it matter?</dt>
        <dd className="leading-relaxed">
          <RichText text={g.whyItMatters} />
        </dd>
        <dt className="font-semibold">What should I do next?</dt>
        <dd className="font-medium leading-relaxed">
          <RichText text={g.nextAction} />
        </dd>
      </dl>

      {(g.snippet || g.facts.length > 0) && (
        <div>
          <SubHeading>Where it was found</SubHeading>
          <p className="mb-2 break-all text-muted">
            {f.pageUrl ?? "Site-wide"}
            {f.viewport ? ` · ${f.viewport} screen size` : ""}
          </p>
          {g.snippet && <CodeBlock code={g.snippet.html} label="HTML recorded by the scanner" />}
          {g.facts.length > 0 && (
            <dl className="mt-2 grid gap-x-3 gap-y-1 sm:grid-cols-[minmax(8rem,12rem)_minmax(0,1fr)]">
              {g.facts.map((x, i) => (
                <div key={i} className="contents">
                  <dt className="text-muted">{x.label}</dt>
                  <dd className={x.code ? "break-all font-mono text-xs" : "break-words"}>
                    {x.value}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}

      <div>
        <SubHeading>How to fix it</SubHeading>
        <ol className="list-decimal space-y-1.5 pl-5 leading-relaxed marker:font-semibold marker:text-muted">
          {g.steps.map((s, i) => (
            <li key={i} className="pl-1">
              <RichText text={s} />
            </li>
          ))}
        </ol>
        {g.caveats.length > 0 && (
          <>
            <h4 className="mb-1 mt-3 font-semibold">Before you change it</h4>
            <ul className="list-disc space-y-1 pl-5 leading-relaxed">
              {g.caveats.map((c, i) => (
                <li key={i}>
                  <RichText text={c} />
                </li>
              ))}
            </ul>
          </>
        )}
        {g.gaps.length > 0 && (
          <div className="mt-3 rounded-md border border-info/30 bg-info-bg px-3 py-2">
            <h4 className="mb-1 font-semibold">What the scan could not tell</h4>
            <ul className="list-disc space-y-1 pl-5 leading-relaxed">
              {g.gaps.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {g.examples.length > 0 && (
        <div>
          <SubHeading>Example fix</SubHeading>
          <p className="mb-2 text-muted">
            Suggested code, not taken from your source files. Text in [square brackets] is a
            placeholder for something only you can decide.
          </p>
          <div className="space-y-3">
            {g.examples.map((x, i) => (
              <Example key={i} example={x} level={4} />
            ))}
          </div>
        </div>
      )}

      <div>
        <SubHeading>How to verify the fix</SubHeading>
        <ol className="list-decimal space-y-1.5 pl-5 leading-relaxed marker:font-semibold marker:text-muted">
          {g.verify.map((s, i) => (
            <li key={i} className="pl-1">
              <RichText text={s} />
            </li>
          ))}
        </ol>
      </div>

      <p className="text-xs text-muted">
        {RULE_LABEL}. A suggested fix is not verified until a later scan confirms the problem is
        gone.
        {issueHref && (
          <>
            {" "}
            <a href={issueHref} className="font-medium text-primary underline">
              Open {issueLabel ?? "the issue"} for its status, history and related findings
            </a>
          </>
        )}
      </p>
    </div>
  );
}

/** How reliable the finding is (technical section): verdict and the scanner's confidence. */
export function Reliability({ verdict: v, confidence }: { verdict: string; confidence: number }) {
  const verdict = VERDICT_MEANINGS[v];
  return (
    <div className="space-y-1 text-sm">
      <p>
        <span className="font-medium">{verdict?.label ?? v}.</span> {verdict?.meaning ?? ""}
      </p>
      <p>
        Confidence {Math.round(confidence * 100)}%.{" "}
        <span className="text-muted">{CONFIDENCE_EXPLANATION}</span>
      </p>
    </div>
  );
}
