import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { renderBrief, type ReportBrief } from "./brief";
import { verifyFigures, describeIssues, type VerifyResult } from "./verify";
import { FRAMING_LABEL, type Framing } from "./framings";

/**
 * The written weekly summary.
 *
 * The model's ONLY job here is prose. Every number it may use has already been
 * computed by the metrics engine and handed to it in the brief; its output
 * schema contains no numeric field, no verdict, no score. That division is the
 * same one the keep/kill engine uses, and it is what makes a generated summary
 * safe to put in front of a client: the arithmetic is ours, the sentences are
 * the model's, and `verifyFigures` checks afterwards that the sentences only
 * contain our arithmetic.
 *
 * ---
 *
 * NEVER AUTO-PUBLISHES, AND NOT AS A MATTER OF POLICY.
 *
 * This module returns a draft. It has no access to the store and cannot mark
 * anything published — that is a separate, human action recorded in the audit
 * log. A weekly summary is a document an agency puts its name to; the model
 * writes a first draft of it, the same way a junior would, and somebody reads
 * it before it goes out.
 */

// Re-exported so server-side callers have one import, while the client-side
// selector takes them from `framings.ts` and never pulls the SDK into the
// browser bundle.
export { FRAMINGS, FRAMING_LABEL, FRAMING_HINT, type Framing } from "./framings";

/**
 * What each framing asks for.
 *
 * Each carries its own honesty instruction, because each has its own failure
 * mode: a "wins" section invents wins when there are none, an "issues" section
 * manufactures alarm, a "recommendations" section proposes changes the data
 * cannot justify.
 */
const FRAMING_BRIEF: Record<Framing, string> = {
  summary:
    "Write a neutral account of what happened in this period. Lead with the figures that would change a decision. Do not editorialise, and do not close with an upbeat sentence that the numbers do not support.",
  wins:
    "Write up what genuinely went well. If little did, say so plainly and briefly — a manufactured win is worse than an honest quiet week, because it costs the reader's trust in every other section. Never present a metric as a win when its own volume is too small to support the claim.",
  issues:
    "Write up what needs attention, in order of how much money it involves. Distinguish a problem in the advertising from a problem in the data or the follow-up — they lead to completely different actions. Do not pad the list; if there is one issue, report one issue.",
  recommendations:
    "Propose what to do next. Every recommendation must trace to a specific figure in the brief and must say which. Where the data cannot support a recommendation — too little volume, missing attribution — say what would need to be true to know, rather than guessing. Never recommend pausing or scaling something on a sample of a handful of conversions.",
};

const SYSTEM = `You write short performance-marketing updates for an agency's clients. Your reader runs a small service business — a med spa, a clinic, a studio. They are intelligent and busy and they are not marketers.

RULES, in order of importance:

1. USE ONLY THE NUMBERS IN THE BRIEF. Never calculate a new figure, never estimate one, never round to a "nicer" number, and never state a figure the brief does not contain. If you want to say something the brief cannot support, say the thing the brief supports instead. Every number you write is checked against the source data afterwards and a figure that does not match is treated as a defect.

2. OBEY THE CONSTRAINTS SECTION ABSOLUTELY. It states what this data cannot support. A missing number is not a zero: if deal values were never entered, revenue is UNKNOWN, not nil, and writing "the campaigns generated no revenue" is a false statement about the client's business.

3. NO HYPE. No "incredible", "amazing", "crushing it", no exclamation marks. Plain, specific, calm. An agency that oversells a quiet week is not trusted in a good one.

4. SMALL NUMBERS DESERVE SMALL CLAIMS. Three leads becoming five is not a 67% improvement, it is two leads. Do not build a narrative on a handful of conversions.

5. BE SHORT. Three to five sentences, or three to five bullets. This is read on a phone between appointments.

6. Write in British-neutral plain English. Address the client as "you". Refer to the agency as "we".`;

/** No numeric field, no verdict field. Prose only, by construction. */
const DraftSchema = z.object({
  headline: z
    .string()
    .describe("One line, under 90 characters, stating the period's single most important fact."),
  body: z
    .string()
    .describe(
      "Three to five sentences, or three to five short markdown bullets. No heading, no sign-off.",
    ),
});

export interface SummaryDraft {
  framing: Framing;
  headline: string;
  body: string;
  /** Figures in the text that trace to nothing the engine produced. */
  verification: VerifyResult;
  /** Operator-facing warning, or null when everything checked out. */
  warning: string | null;
  model: string;
  /** True when the first attempt was rejected and a correction was requested. */
  retried: boolean;
}

export class SummaryUnavailable extends Error {}

const MODEL = "claude-opus-5";

export function summariesConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export async function generateSummary(
  brief: ReportBrief,
  framing: Framing,
): Promise<SummaryDraft> {
  if (!summariesConfigured()) {
    throw new SummaryUnavailable(
      "ANTHROPIC_API_KEY is not set, so written summaries cannot be generated. Every figure on the dashboard is unaffected.",
    );
  }

  const client = new Anthropic();
  const prompt = `${renderBrief(brief)}

---

TASK — ${FRAMING_LABEL[framing].toUpperCase()}

${FRAMING_BRIEF[framing]}`;

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];

  let draft = await ask(client, messages);
  let verification = verifyFigures(`${draft.headline}\n${draft.body}`, brief.allowed);
  let retried = false;

  /*
   * One correction round, naming the offending figures.
   *
   * Not a loop: if the model cannot write the paragraph without inventing a
   * number twice, more attempts will not fix it, and the operator is better
   * served by seeing the flagged draft than by waiting through four calls. The
   * flag is the product here — silently regenerating until something passes
   * would hide the fact that the model was reaching for figures it did not
   * have.
   */
  if (!verification.ok) {
    retried = true;
    messages.push(
      { role: "assistant", content: JSON.stringify(draft) },
      {
        role: "user",
        content: `These figures do not appear in the brief and must not appear in the text: ${verification.issues
          .map((i) => i.token)
          .join(", ")}. Rewrite using only figures from the brief. If a sentence needs a number you do not have, drop the sentence.`,
      },
    );
    const second = await ask(client, messages);
    const secondCheck = verifyFigures(`${second.headline}\n${second.body}`, brief.allowed);
    // Keep whichever attempt is cleaner — a retry that gets worse is not an
    // improvement, and there is no reason to prefer it merely for being later.
    if (secondCheck.issues.length <= verification.issues.length) {
      draft = second;
      verification = secondCheck;
    }
  }

  return {
    framing,
    headline: draft.headline.trim(),
    body: draft.body.trim(),
    verification,
    warning: describeIssues(verification),
    model: MODEL,
    retried,
  };
}

async function ask(
  client: Anthropic,
  messages: Anthropic.MessageParam[],
): Promise<{ headline: string; body: string }> {
  try {
    const response = await client.messages.parse({
      model: MODEL,
      max_tokens: 4000,
      system: SYSTEM,
      thinking: { type: "adaptive" },
      output_config: { format: zodOutputFormat(DraftSchema) },
      messages,
    });

    const parsed = response.parsed_output;
    if (!parsed) {
      throw new SummaryUnavailable(
        "The model did not return a usable draft. Try again, or write the summary by hand.",
      );
    }
    return parsed;
  } catch (err) {
    if (err instanceof SummaryUnavailable) throw err;
    /*
     * Every failure here is named rather than surfaced as a 500. A summary that
     * cannot be generated must not read like a broken dashboard — the numbers
     * are fine, only the writing is unavailable.
     */
    if (err instanceof Anthropic.AuthenticationError) {
      throw new SummaryUnavailable("The Anthropic API key was rejected. Check ANTHROPIC_API_KEY.");
    }
    if (err instanceof Anthropic.RateLimitError) {
      throw new SummaryUnavailable("Rate limited by the Anthropic API. Try again in a minute.");
    }
    if (err instanceof Anthropic.APIError) {
      throw new SummaryUnavailable(`The Anthropic API returned ${err.status}: ${err.message}`);
    }
    throw new SummaryUnavailable(
      err instanceof Error ? err.message : "Could not reach the Anthropic API.",
    );
  }
}
