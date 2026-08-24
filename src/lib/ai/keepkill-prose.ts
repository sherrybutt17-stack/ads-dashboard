import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import {
  STAGE_NOUN,
  VERDICT_LABEL,
  type KeepKillReport,
} from "@/lib/metrics/keepkill";
import { verifyFigures, describeIssues, type VerifyResult } from "./verify";
import type { AllowedFigure } from "./brief";
import { SummaryUnavailable, summariesConfigured } from "./summary";

/**
 * The written half of keep/kill — and only the written half.
 *
 * 🔴 **The output schema has no verdict field.** Not "the model is instructed
 * not to change the verdict": there is nowhere for it to put one. It receives
 * verdicts already decided by `assessCandidates` and writes the paragraph that
 * ties them together; if it disagrees, it has no channel through which to say
 * so, and the panel above it is unaffected either way.
 *
 * And no numeric field, for the same reason. Every figure that may appear in
 * the prose comes from the engine, and `verifyFigures` checks the finished text
 * against exactly that list — the same mechanism §6.2 uses, pointed at a
 * different set of numbers.
 *
 * The value this adds over the per-row reasons the engine already writes is
 * synthesis: "two campaigns are worth stopping, they are the same offer, and
 * the money is better spent on the one that books" is a sentence no template
 * produces and no single row contains.
 */

export interface KeepKillProse {
  text: string;
  verification: VerifyResult;
  warning: string | null;
  model: string;
}

const MODEL = "claude-opus-5";

/** Prose only. No verdict, no score, no figure — by construction. */
const ProseSchema = z.object({
  text: z
    .string()
    .describe(
      "Two to four sentences tying the recommendations together. No heading, no list, no sign-off.",
    ),
});

const SYSTEM = `You write one short paragraph for a performance-marketing agency, summarising decisions that have ALREADY BEEN MADE by a statistical engine.

WHAT YOU ARE AND ARE NOT DOING:

- You are NOT deciding anything. The verdict on each campaign is given to you and is final. Never contradict one, never hedge one, never suggest a different one, and never say a campaign "may need review" when its verdict is Keep.
- You are NOT calculating. Every number you may use is in the brief. Writing any other figure is a defect and is checked automatically.
- You ARE tying the rows together into the thing a person would say out loud: what to do first, what these recommendations have in common, and what the reader should NOT read into them.

RULES:

1. If the engine says a campaign is indistinguishable from the others, say so plainly. "No clear difference" is a finding, not a failure to find one, and it is usually the honest state of a small account.
2. Confidence is a probability that a campaign is genuinely worse, not a p-value and not a guarantee. Never round it up into certainty.
3. Name the funnel stage the verdicts were computed against if you refer to cost at all — cost per lead and cost per appointment are different claims.
4. No hype, no exclamation marks, no "crushing it". Plain and calm.
5. Two to four sentences. This sits under a table the reader has already read.`;

/**
 * Everything the model is allowed to say, and every number it may use.
 *
 * Built from the assessments themselves, so the allow-list and the brief cannot
 * drift: they are two renderings of one object.
 */
function renderBrief(report: KeepKillReport, currency: string): {
  prompt: string;
  allowed: AllowedFigure[];
} {
  const allowed: AllowedFigure[] = [];
  const push = (v: number | null, kind: AllowedFigure["kind"], label: string) => {
    if (v != null && Number.isFinite(v)) allowed.push({ value: v, kind, label });
  };

  const noun = report.stage ? STAGE_NOUN[report.stage] : "conversion";
  const lines = [
    `Judging stage: cost per ${noun}.`,
    `Why: ${report.stageReason}`,
    `Campaigns judged: ${report.judged}`,
    "",
    "VERDICTS — already decided, not yours to change:",
  ];
  push(report.judged, "count", "campaigns judged");

  for (const a of report.assessments) {
    push(a.spend, "money", `${a.name} spend`);
    push(a.costPer, "money", `${a.name} cost per ${noun}`);
    push(a.benchmarkCostPer, "money", `${a.name} benchmark cost per ${noun}`);
    push(a.conversions, "count", `${a.name} ${noun}s`);
    // Confidence is quoted as a percentage in prose, so admit it as one.
    push(Math.round(a.pWorse * 100), "percent", `${a.name} confidence it is worse`);
    push(Math.round((1 - a.pWorse) * 100), "percent", `${a.name} confidence it is better`);

    lines.push(
      `  - ${a.name}: ${VERDICT_LABEL[a.verdict]}. ${currency} ${a.spend.toFixed(2)} spent, ` +
        `${a.conversions} ${noun}${a.conversions === 1 ? "" : "s"}, ` +
        `${a.costPer == null ? "no cost per " + noun : currency + " " + a.costPer.toFixed(2) + " each"}, ` +
        `rest of account ${a.benchmarkCostPer == null ? "n/a" : currency + " " + a.benchmarkCostPer.toFixed(2)}. ` +
        `Confidence it is genuinely worse: ${Math.round(a.pWorse * 100)}%. ` +
        `Engine's own note: ${a.reason}`,
    );
  }

  return { prompt: lines.join("\n"), allowed };
}

export async function writeKeepKillProse(
  report: KeepKillReport,
  currency: string,
): Promise<KeepKillProse> {
  if (!summariesConfigured()) {
    throw new SummaryUnavailable(
      "ANTHROPIC_API_KEY is not set, so the written summary of these recommendations is unavailable. The recommendations themselves are unaffected — they are computed, not written.",
    );
  }
  if (report.assessments.length === 0) {
    throw new SummaryUnavailable("There are no recommendations to write about.");
  }

  const { prompt, allowed } = renderBrief(report, currency);
  const client = new Anthropic();

  try {
    const response = await client.messages.parse({
      model: MODEL,
      max_tokens: 2000,
      system: SYSTEM,
      thinking: { type: "adaptive" },
      output_config: { format: zodOutputFormat(ProseSchema) },
      messages: [{ role: "user", content: prompt }],
    });

    const parsed = response.parsed_output;
    if (!parsed) {
      throw new SummaryUnavailable("The model did not return usable text.");
    }

    const verification = verifyFigures(parsed.text, allowed);
    return {
      text: parsed.text.trim(),
      verification,
      warning: describeIssues(verification),
      model: MODEL,
    };
  } catch (err) {
    if (err instanceof SummaryUnavailable) throw err;
    if (err instanceof Anthropic.APIError) {
      throw new SummaryUnavailable(`The Anthropic API returned ${err.status}: ${err.message}`);
    }
    throw new SummaryUnavailable(
      err instanceof Error ? err.message : "Could not reach the Anthropic API.",
    );
  }
}
