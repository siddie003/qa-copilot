import {
  buildIssueDrafts,
  GROUNDING_VERSION,
  interpretGroups,
  prepareGroups,
  PROMPT_VERSION,
  type AIProvider,
  type BatchResult,
  type PreparedGroup,
} from "@qa/ai";
import { NO_AI_PROVIDER_REASON, type AppConfig, type DesignSpec, type Logger } from "@qa/core";
import { scanIssuesRepo, type Database } from "@qa/db";

/** Data the AI step hands to the grounding step (kept in memory for the scan). */
export interface IssueStepState {
  prepared?: PreparedGroup[];
  batches?: BatchResult[];
  /** ai_run id per batch index. */
  runIds: Map<number, string>;
}

export interface IssueStepEnv {
  db: Database;
  log: Logger;
  config: AppConfig;
  scanId: string;
  provider: AIProvider;
  /** Scan cancellation. */
  signal: AbortSignal;
  /** The scan's frozen design reference (design issues may cite its values). */
  designSpec: DesignSpec | null;
  state: IssueStepState;
}

export interface IssueStepOutcome {
  status: "completed" | "failed" | "skipped";
  statusReason?: string;
  error?: string;
  toolName?: string;
  toolVersion?: string;
  checks?: Record<string, unknown>;
}

/** Share of the step timeout the AI may use, so slow requests never stop the grounding step. */
const AI_BUDGET_SHARE = 0.85;

async function prepared(env: IssueStepEnv): Promise<PreparedGroup[]> {
  env.state.prepared ??= prepareGroups(await scanIssuesRepo.loadScanFindings(env.db, env.scanId));
  return env.state.prepared;
}

const k = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/**
 * AI interpretation: sends the scan's issue groups to the configured provider in batches and
 * records one ai_run per request. Never changes findings; failures only mean the affected issues
 * keep the scanners' wording.
 */
export async function aiStep(env: IssueStepEnv): Promise<IssueStepOutcome> {
  const groups = await prepared(env);
  const { provider } = env;
  if (provider.id === "none") return { status: "skipped", statusReason: NO_AI_PROVIDER_REASON };
  if (!groups.length)
    return { status: "skipped", statusReason: "No findings: nothing to interpret" };

  const budget = AbortSignal.timeout(
    Math.floor(env.config.SCAN_SCANNER_TIMEOUT_MS * AI_BUDGET_SHARE),
  );
  const batches = await interpretGroups({
    provider,
    prepared: groups,
    concurrency: env.config.AI_CONCURRENCY,
    signal: AbortSignal.any([env.signal, budget]),
    onBatch: async (r) => {
      env.log.info(
        {
          batch: r.index,
          category: r.category,
          groups: r.groupIds.length,
          status: r.status,
          errorCode: r.error?.code,
          inputTokens: r.usage.inputTokens,
          outputTokens: r.usage.outputTokens,
          latencyMs: r.latencyMs,
        },
        "ai batch finished",
      );
      if (r.status === "skipped") return;
      env.state.runIds.set(
        r.index,
        await scanIssuesRepo.insertAiRun(env.db, env.scanId, {
          provider: provider.id,
          model: r.model ?? provider.model,
          status: r.status,
          inputTokens: r.usage.inputTokens,
          outputTokens: r.usage.outputTokens,
          latencyMs: r.latencyMs,
          error: r.error ? `${r.error.code}: ${r.error.message}` : null,
          detail: {
            batch: r.index,
            category: r.category,
            groupIds: r.groupIds,
            returnedIssues: r.issues.length,
            stopReason: r.stopReason,
            fallbackUsed: r.fallbackUsed,
            requestedModel: provider.model,
            cacheReadTokens: r.usage.cacheReadTokens,
            inputChars: r.inputChars,
            promptVersion: PROMPT_VERSION,
          },
        }),
      );
    },
  });
  env.state.batches = batches;

  const done = batches.filter((b) => b.status === "completed");
  const failed = batches.filter((b) => b.status === "failed");
  const skipped = batches.filter((b) => b.status === "skipped");
  const sum = (key: "inputTokens" | "outputTokens") =>
    batches.reduce((s, b) => s + (b.usage[key] ?? 0), 0);
  const interpreted = done.reduce((s, b) => s + b.groupIds.length, 0);
  const sent = batches.reduce((s, b) => s + b.groupIds.length, 0);
  const reasons = [...new Set([...failed, ...skipped].map((b) => b.error?.message ?? "error"))];
  const checks = {
    provider: provider.id,
    model: provider.model,
    promptVersion: PROMPT_VERSION,
    issueGroups: groups.length,
    sentToAi: sent,
    interpreted,
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
    batches: batches.map((b) => ({
      batch: b.index,
      category: b.category,
      groups: b.groupIds.length,
      status: b.status,
      error: b.error,
      model: b.model,
      latencyMs: b.latencyMs,
      inputTokens: b.usage.inputTokens,
      outputTokens: b.usage.outputTokens,
      fallbackUsed: b.fallbackUsed,
    })),
  };
  const tool = { toolName: provider.label, toolVersion: provider.model };
  if (!done.length)
    return {
      status: "failed",
      error: `AI analysis failed for all ${batches.length} request${batches.length === 1 ? "" : "s"}: ${reasons.join("; ")}. All ${groups.length} issues use the scanners' wording.`,
      checks,
      ...tool,
    };
  const notSentToAi = groups.length - sent;
  return {
    status: "completed",
    statusReason: [
      `${done.length} of ${batches.length} request${batches.length === 1 ? "" : "s"} answered; ${interpreted} of ${groups.length} issues interpreted`,
      failed.length || skipped.length
        ? `${failed.length + skipped.length} request(s) without an answer (${reasons.join("; ")}): their issues use the scanners' wording`
        : null,
      notSentToAi > 0
        ? `${notSentToAi} issues beyond the AI limit use the scanners' wording`
        : null,
      `${k(checks.inputTokens)} input / ${k(checks.outputTokens)} output tokens`,
      done.some((b) => b.fallbackUsed) ? "a refusal fallback model answered some requests" : null,
    ]
      .filter(Boolean)
      .join("; "),
    checks,
    ...tool,
  };
}

/**
 * Grounding + issue creation: validates AI text against the evidence, falls back to the scanners'
 * wording wherever it is missing or unsupported, and stores one issue per group with its checks.
 * Runs whether or not AI was used.
 */
export async function groundingStep(env: IssueStepEnv): Promise<IssueStepOutcome> {
  const groups = await prepared(env);
  const { drafts, stats } = buildIssueDrafts({
    prepared: groups,
    batches: env.state.batches ?? [],
    designReference: env.designSpec ?? undefined,
  });
  const stored = await scanIssuesRepo.materializeScanIssues(
    env.db,
    env.scanId,
    drafts.map((d) => ({
      fingerprint: d.fingerprint,
      category: d.category,
      ruleId: d.ruleId,
      subcategory: d.subcategory,
      severity: d.severity,
      severityRationale: d.severityRationale,
      title: d.title,
      description: d.description,
      affectedUrls: d.affectedUrls,
      affectedElement: d.affectedElement,
      expected: d.expected,
      actual: d.actual,
      recommendation: d.recommendation,
      confidence: d.confidence,
      verdict: d.verdict,
      status: d.status,
      origin: d.origin,
      groundingStatus: d.groundingStatus,
      aiRunId: d.batchIndex === null ? null : (env.state.runIds.get(d.batchIndex) ?? null),
      findingIds: d.findingIds,
      checks: d.checks,
    })),
  );
  const tool = { toolName: "QA Copilot grounding validator", toolVersion: GROUNDING_VERSION };
  const checks = { ...stats, newTracks: stored.newTracks, updatedTracks: stored.updatedTracks };
  if (!stats.issues)
    return { status: "completed", statusReason: "No findings: no issues created", checks, ...tool };
  const tracked = `${stored.newTracks} new, ${stored.updatedTracks} seen in earlier scans`;
  const usedAi = (env.state.batches ?? []).length > 0;
  return {
    status: "completed",
    statusReason: usedAi
      ? `${stats.issues} issues from ${stats.findings} findings (${tracked}). AI text: ${stats.passed} verified, ${stats.partial} with unsupported parts replaced, ${stats.rejected} rejected; ${stats.deterministic} issues use the scanners' wording. ${stats.checksPassed} of ${stats.checksPassed + stats.checksFailed} grounding checks passed.`
      : `${stats.issues} issues from ${stats.findings} findings (${tracked}), in the scanners' wording with rule-catalog fix guidance (no AI text to validate).`,
    checks,
    ...tool,
  };
}
