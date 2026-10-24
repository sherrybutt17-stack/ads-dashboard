import { z } from "zod";
import { AD_PLATFORMS } from "@/lib/platforms";
import { FORMULA_LIMITS } from "@/lib/metrics/formula";
import { CUSTOM_LIMITS, type CustomMetric } from "./registry";

/**
 * The shapes an agency metric travels in: the settings form's body (strict —
 * refused if anything is off) and the copy frozen into a share link (read back
 * leniently, metric by metric).
 *
 * Shape only. Whether a metric makes sense — a name that clashes, a formula
 * that does not parse, a stat a platform does not report — is
 * `validateCustomMetric`'s job, which explains itself in words.
 */

const Token = z.discriminatedUnion("t", [
  z.object({ t: z.literal("stat"), id: z.string().min(1).max(64) }).strict(),
  z.object({ t: z.literal("num"), v: z.number().finite() }).strict(),
  z.object({ t: z.literal("op"), v: z.enum(["+", "-", "*", "/"]) }).strict(),
  z.object({ t: z.literal("(") }).strict(),
  z.object({ t: z.literal(")") }).strict(),
]);

const draftShape = {
  kind: z.enum(["rename", "formula"]),
  platform: z.enum([...AD_PLATFORMS, "any"]),
  baseMetric: z.string().min(1).max(64).nullable(),
  expression: z.array(Token).max(FORMULA_LIMITS.tokens).nullable(),
  // Twice the limit here, so a long name gets validation's sentence, not "invalid input".
  label: z.string().max(CUSTOM_LIMITS.label * 2),
  description: z.string().max(CUSTOM_LIMITS.description * 2).nullable(),
  format: z.enum(["currency", "count", "percent", "decimal", "multiple"]).nullable(),
  polarity: z.enum(["higher-better", "lower-better", "neutral"]).nullable(),
};

/** What the settings form sends to create or change a metric. */
export const CustomMetricDraftSchema = z.object(draftShape).strict();

/** Archiving or restoring a metric, without touching its definition. */
export const CustomMetricArchiveSchema = z.object({ archived: z.boolean() }).strict();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const FrozenMetricSchema = z.object({
  ...draftShape,
  id: z.string().regex(UUID),
  label: z.string().min(1).max(CUSTOM_LIMITS.label),
  description: z.string().max(CUSTOM_LIMITS.description).nullable(),
  baseMetric: draftShape.baseMetric,
  archived: z.boolean(),
});

/**
 * The metrics a share link froze, metric by metric: one that no longer reads
 * is left out — its widgets then say the metric is unavailable — rather than
 * taking the link down.
 */
export function readFrozenMetrics(raw: unknown): CustomMetric[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((m) => {
    const parsed = FrozenMetricSchema.safeParse(m);
    return parsed.success ? [parsed.data as CustomMetric] : [];
  });
}
