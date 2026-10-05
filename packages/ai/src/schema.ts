import { SEVERITIES } from "@qa/core";
import { z } from "zod";

/** Fields of a finding an AI claim may cite. */
export const CLAIM_FIELDS = [
  "title",
  "message",
  "expected",
  "actual",
  "selector",
  "pageUrl",
  "evidence",
] as const;
export type ClaimField = (typeof CLAIM_FIELDS)[number];

/**
 * What the AI returns for one group. The schema checks structure only; content limits (lengths,
 * allowed ids, values) are enforced per issue by grounding, so one bad issue never discards a
 * whole batch.
 */
export const aiIssueSchema = z.object({
  groupId: z.string(),
  sourceFindingIds: z.array(z.string()),
  title: z.string(),
  description: z.string(),
  severity: z.enum(SEVERITIES),
  severityRationale: z.string(),
  affectedElement: z.string().nullable(),
  expected: z.string().nullable(),
  actual: z.string().nullable(),
  recommendation: z.string(),
  claims: z.array(
    z.object({
      text: z.string(),
      findingId: z.string(),
      evidenceField: z.enum(CLAIM_FIELDS),
    }),
  ),
});
export type AiIssue = z.infer<typeof aiIssueSchema>;

export const aiBatchSchema = z.object({ issues: z.array(aiIssueSchema) });
export type AiBatch = z.infer<typeof aiBatchSchema>;

const UNSUPPORTED_KEYWORDS = new Set([
  "$schema",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "uniqueItems",
]);

/**
 * JSON Schema accepted by structured-output APIs: no `$schema`, no length/number/array
 * constraints, and nullable types written as `anyOf` (the widest-supported form).
 */
export function toStructuredOutputSchema(schema: z.ZodType): Record<string, unknown> {
  const clean = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(clean);
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (UNSUPPORTED_KEYWORDS.has(k)) continue;
      out[k] = clean(v);
    }
    const type = out.type;
    if (Array.isArray(type) && type.length > 1) {
      delete out.type;
      const rest = { ...out };
      for (const k of Object.keys(out)) delete out[k];
      out.anyOf = type.map((t) => (t === "null" ? { type: "null" } : { ...rest, type: t }));
    }
    return out;
  };
  return clean(z.toJSONSchema(schema)) as Record<string, unknown>;
}

export const AI_BATCH_JSON_SCHEMA = toStructuredOutputSchema(aiBatchSchema);
export const AI_BATCH_SCHEMA_NAME = "qa_issue_interpretation";
