import { probRateBelow } from "./stats";

/**
 * Keep / kill — the deterministic engine.
 *
 * 🔴 **The verdict is computed here and nowhere else.** A language model is
 * used, later and separately, to write the explanation; its output schema has
 * no verdict field and no numeric field, and every figure in its prose is
 * checked back against what this file produced. That division is the whole
 * design: a recommendation to switch off a campaign is a decision with money
 * attached, and it should come from arithmetic somebody can re-derive.
 *
 * **Recommend only.** Nothing here pauses anything or moves a budget. The
 * output is a sentence and a confidence.
 *
 * ---
 *
 * WHY BAYESIAN AND NOT "CPL IS ABOVE TARGET"
 *
 * The naive rule — kill anything whose cost per lead exceeds the account
 * average — is wrong at this product's volumes in the most expensive possible
 * direction. A campaign with 3 leads on $90 has a cost per lead of $30 against
 * an account average of $22, so the naive rule kills it. Run the numbers and
 * the probability it is genuinely worse is about 0.66 — barely better than a
 * coin toss, on a sample of three. Agencies switch off working campaigns this
 * way every week.
 *
 * So the question asked is not "is this campaign's measured cost higher?" but
 * "how confident can we be that its TRUE cost is higher?", which is a different
 * question with a different answer whenever the sample is small — that is,
 * nearly always.
 *
 * The model: conversions arrive as a Poisson process at some unknown rate λ per
 * dollar spent, and the conjugate prior for λ is a Gamma. Observing `k`
 * conversions on `s` dollars gives the posterior Gamma(α₀ + k, β₀ + s). The
 * comparison against the benchmark has an exact closed form (see
 * `probRateBelow`), so there is no simulation, no sampling, no seed — the same
 * inputs give the same verdict forever, which is what lets an operator argue
 * with it.
 *
 * ---
 *
 * THREE THINGS THAT WOULD MAKE THIS ENGINE WRONG, HANDLED
 *
 * **1 · Judging on leads alone.** A campaign producing cheap leads that never
 * book an appointment scores as `scale` and gets more budget — the exact
 * failure the plan flagged. So the engine judges on the DEEPEST funnel stage
 * the account has enough volume to support, and says which one it used.
 *
 * **2 · The benchmark including the candidate.** A campaign carrying most of
 * the account's spend, compared against an average it dominates, is compared
 * against itself and can never look bad. Every benchmark here is leave-one-out.
 *
 * **3 · Killing during Meta's learning phase.** An ad set that has not exited
 * learning is not yet delivering at its own steady-state performance, and
 * switching it off is precisely the wrong call. A kill verdict on anything
 * still learning is downgraded to "too early".
 */

/** Stages the engine can judge on, deepest first. */
export const JUDGING_STAGES = [
  "closed_won",
  "showed",
  "appointment_booked",
  "new_lead",
] as const;
export type JudgingStage = (typeof JUDGING_STAGES)[number];

export const STAGE_NOUN: Record<JudgingStage, string> = {
  closed_won: "closed deal",
  showed: "show",
  appointment_booked: "appointment",
  new_lead: "lead",
};

/* ------------------------------------------------------------------ *
 * Tuning — every threshold with the reason it is that number
 * ------------------------------------------------------------------ */

/**
 * Prior strength, in conversions. Jeffreys' prior for a Poisson rate.
 *
 * Deliberately almost nothing: the prior exists to keep a zero-conversion
 * campaign's posterior proper, not to express an opinion. A heavier prior would
 * pull every small campaign toward the account average and make the engine
 * agree with itself.
 */
const PRIOR_SHAPE = 0.5;

/** Confident enough to recommend switching money off. */
const KILL_P = 0.9;
/** Worth watching, not worth acting on. */
const WATCH_P = 0.75;
/** Confident enough to recommend more budget. */
const SCALE_P = 0.1;

/**
 * How many conversions the account must have at a stage before that stage can
 * be used as the yardstick.
 *
 * Below this the benchmark itself is noise, and comparing against noise
 * produces confident nonsense in both directions.
 */
const MIN_STAGE_TOTAL = 10;

/**
 * How much a candidate must have spent, as a multiple of the benchmark's cost
 * per conversion, before a kill is available.
 *
 * 🔴 This is what stops "$30 spent, zero leads, kill it" on an account whose
 * leads cost $25 — barely more than one lead's worth of budget, where zero
 * conversions is an ordinary outcome. Expressed as a multiple rather than an
 * absolute so it scales with the account: three expected conversions' worth of
 * spend with nothing to show is evidence; $30 is not.
 */
const KILL_SPEND_MULTIPLE = 3;

/** Absolute floor, for an account whose conversions are nearly free. */
const KILL_MIN_SPEND = 50;

/** A scale recommendation also needs real money behind it. */
const SCALE_MIN_SPEND = 100;

/* ------------------------------------------------------------------ *
 * Shapes
 * ------------------------------------------------------------------ */

export type Verdict = "scale" | "keep" | "watch" | "kill" | "too_early" | "no_benchmark";

export const VERDICT_LABEL: Record<Verdict, string> = {
  scale: "Scale",
  keep: "Keep",
  watch: "Watch",
  kill: "Consider stopping",
  too_early: "Too early",
  no_benchmark: "Nothing to compare",
};

export interface Candidate {
  id: string;
  name: string;
  spend: number;
  /** Conversions per stage. Missing stages count as zero. */
  conversions: Partial<Record<JudgingStage, number>>;
  /** Any ad inside this candidate still in Meta's learning phase. */
  inLearning?: boolean;
}

export interface Assessment {
  id: string;
  name: string;
  spend: number;
  conversions: number;
  /** Spend ÷ conversions, or null when there are none. */
  costPer: number | null;
  /** The same figure for everything EXCEPT this candidate. */
  benchmarkCostPer: number | null;
  /**
   * P(this candidate's true conversion rate is worse than the rest of the
   * account's). Not a p-value: a direct posterior probability.
   */
  pWorse: number;
  verdict: Verdict;
  /** One deterministic sentence. The model may rephrase it, never contradict it. */
  reason: string;
}

export interface KeepKillReport {
  /** The funnel stage every verdict was computed against. */
  stage: JudgingStage | null;
  /** Why that stage, in words — it changes what the verdicts mean. */
  stageReason: string;
  assessments: Assessment[];
  /** How many candidates were judged, for the reader to weigh the list against. */
  judged: number;
}

/* ------------------------------------------------------------------ *
 * The engine
 * ------------------------------------------------------------------ */

export function assessCandidates(candidates: readonly Candidate[]): KeepKillReport {
  const active = candidates.filter((c) => c.spend > 0 || totalOf(c) > 0);
  if (active.length === 0) {
    return { stage: null, stageReason: "No campaigns ran in this period.", assessments: [], judged: 0 };
  }

  const { stage, stageReason } = pickStage(active);
  if (!stage) {
    return { stage: null, stageReason, assessments: [], judged: 0 };
  }

  const totalSpend = sum(active.map((c) => c.spend));
  const totalConv = sum(active.map((c) => c.conversions[stage] ?? 0));

  const assessments = active.map((c) => assess(c, stage, totalSpend, totalConv));

  /*
   * Sorted by what deserves attention, not by confidence alone: a kill on
   * $2,000 outranks a kill on $60, because the reader has a finite amount of
   * attention and the money is the reason to spend it.
   */
  const rank: Record<Verdict, number> = {
    kill: 0,
    scale: 1,
    watch: 2,
    too_early: 3,
    keep: 4,
    no_benchmark: 5,
  };
  assessments.sort((a, b) => rank[a.verdict] - rank[b.verdict] || b.spend - a.spend);

  return { stage, stageReason, assessments, judged: active.length };
}

/**
 * The deepest stage the account can actually support.
 *
 * 🔴 §6.6's fix. Judging on leads alone rewards a campaign that produces cheap
 * leads who never book — and rewarding it means moving budget toward it. Going
 * as deep as the data allows makes the verdict track the thing the client is
 * actually buying.
 *
 * The stage is returned with the verdicts because it changes what they mean:
 * "worse" measured on closed deals and "worse" measured on raw leads are
 * different claims, and a reader who assumes the first when we computed the
 * second has been misled by omission.
 */
function pickStage(candidates: readonly Candidate[]): {
  stage: JudgingStage | null;
  stageReason: string;
} {
  for (const stage of JUDGING_STAGES) {
    const total = sum(candidates.map((c) => c.conversions[stage] ?? 0));
    if (total >= MIN_STAGE_TOTAL) {
      const noun = STAGE_NOUN[stage];
      return {
        stage,
        stageReason:
          stage === "new_lead"
            ? `Judged on cost per lead — there are not yet ${MIN_STAGE_TOTAL} appointments in this period to judge on something deeper. A campaign can look good here and still produce people who never book.`
            : `Judged on cost per ${noun} (${total} in this period), not on cost per lead. Cheap leads that never reach this stage do not score well here, which is the point.`,
      };
    }
  }
  return {
    stage: null,
    stageReason: `Fewer than ${MIN_STAGE_TOTAL} leads across the whole account in this period — too little to tell any campaign apart from any other.`,
  };
}

function assess(
  c: Candidate,
  stage: JudgingStage,
  totalSpend: number,
  totalConv: number,
): Assessment {
  const k = c.conversions[stage] ?? 0;
  const spend = c.spend;

  // 🔴 Leave-one-out. A campaign compared against an average it dominates is
  // compared against itself, and can never come out badly.
  const benchSpend = totalSpend - spend;
  const benchConv = totalConv - k;

  const costPer = k > 0 ? spend / k : null;
  const benchmarkCostPer = benchConv > 0 ? benchSpend / benchConv : null;

  const base = { id: c.id, name: c.name, spend, conversions: k, costPer, benchmarkCostPer };
  const noun = STAGE_NOUN[stage];

  if (benchSpend <= 0 || benchConv <= 0) {
    return {
      ...base,
      pWorse: 0.5,
      verdict: "no_benchmark",
      reason:
        candidateIsEverything(spend, totalSpend)
          ? `This is effectively the whole account this period, so there is nothing to compare it against.`
          : `The rest of the account produced no ${noun}s in this period, so there is no benchmark to judge this against.`,
    };
  }

  const pWorse = probRateBelow(
    k + PRIOR_SHAPE,
    spend,
    benchConv + PRIOR_SHAPE,
    benchSpend,
  );

  /*
   * How much has to have been spent before a NEGATIVE verdict is available:
   * three expected conversions' worth of budget at the benchmark's own cost, so
   * it scales with the account rather than with a number somebody liked.
   */
  const evidenceFloor = Math.max(KILL_MIN_SPEND, KILL_SPEND_MULTIPLE * benchmarkCostPer!);

  // ── Confidently better ───────────────────────────────────────────
  /*
   * 🔴 Checked BEFORE the evidence floor, and the ordering is the fix for a
   * real defect the tests caught.
   *
   * The floor is derived from the BENCHMARK's cost per conversion, which is
   * exactly what makes it scale correctly for a kill — and exactly what makes
   * it nonsense for a scale. With one dreadful campaign in the account at
   * $1,200 an appointment, the floor becomes $3,600, and the genuinely
   * excellent campaign next to it — 20 appointments at $60 — was suppressed to
   * "keep" for not having spent enough. It had twenty conversions of its own
   * evidence; the neighbour's incompetence is not a reason to disbelieve them.
   *
   * The floor answers "have we spent enough for ZERO to be meaningful?", which
   * is a question about the losing side only. The winning side is gated by
   * SCALE_MIN_SPEND instead: enough money that more budget is a real decision.
   */
  if (pWorse <= SCALE_P && spend >= SCALE_MIN_SPEND) {
    return {
      ...base,
      pWorse,
      verdict: "scale",
      reason: `${money(costPer!)} per ${noun} against ${money(benchmarkCostPer!)} for the rest of the account, and ${pct(1 - pWorse)} confident that is real. Worth more budget.`,
    };
  }

  /*
   * 🔴 The evidence gate on everything negative.
   *
   * It first guarded only `kill`, which left a hole: a campaign with $30 spent
   * and no leads landed on `watch` instead, because its pWorse sat just under
   * the kill threshold and never reached the floor. That is not a milder
   * version of the same finding — it is the same absence of evidence wearing a
   * quieter label, and a watch list full of $30 campaigns is a watch list
   * nobody reads.
   */
  if (pWorse >= WATCH_P && spend < evidenceFloor) {
    return {
      ...base,
      pWorse,
      verdict: "too_early",
      // Naming the figure that would settle it turns a shrug into a plan.
      reason: `Behind the rest of the account, but only ${money(spend)} has gone through it — less than ${KILL_SPEND_MULTIPLE} ${noun}s' worth of budget at the account's ${money(benchmarkCostPer!)}. Give it ${money(evidenceFloor - spend)} more before deciding.`,
    };
  }

  // ── Confidently worse ────────────────────────────────────────────
  if (pWorse >= KILL_P) {
    if (c.inLearning) {
      /*
       * 🔴 §1d. An ad set still in Meta's learning phase is not delivering at
       * its own steady-state performance yet, so its current numbers are not
       * the numbers it would settle at. Killing here is the one call that is
       * confidently wrong.
       */
      return {
        ...base,
        pWorse,
        verdict: "too_early",
        reason: `Behind the rest of the account, but it is still in Meta's learning phase — its delivery has not settled, so these figures are not what it would do once it has. Judge it again after it exits learning.`,
      };
    }
    return {
      ...base,
      pWorse,
      verdict: "kill",
      reason:
        k === 0
          ? `${money(spend)} spent and not one ${noun}, against ${money(benchmarkCostPer!)} per ${noun} everywhere else. ${pct(pWorse)} confident it is genuinely worse.`
          : `${money(costPer!)} per ${noun} against ${money(benchmarkCostPer!)} for the rest of the account. ${pct(pWorse)} confident that gap is real and not the sample.`,
    };
  }

  if (pWorse >= WATCH_P) {
    return {
      ...base,
      pWorse,
      verdict: "watch",
      reason: `Running behind the rest of the account${costPer ? ` at ${money(costPer)} per ${noun} against ${money(benchmarkCostPer!)}` : ""}, but only ${pct(pWorse)} confident — not enough to act on. Worth another look next week.`,
    };
  }

  // ── Indistinguishable ────────────────────────────────────────────
  return {
    ...base,
    pWorse,
    verdict: "keep",
    reason: costPer
      ? `${money(costPer)} per ${noun} against ${money(benchmarkCostPer!)} elsewhere — on ${k} ${noun}${k === 1 ? "" : "s"} that difference is well within normal variation. Nothing to act on.`
      : `Not enough ${noun}s yet to tell this apart from the rest of the account.`,
  };
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const totalOf = (c: Candidate) => sum(Object.values(c.conversions) as number[]);
const candidateIsEverything = (spend: number, total: number) =>
  total > 0 && spend / total > 0.95;

/**
 * Money and percentages, formatted for a sentence rather than a table.
 *
 * Currency-agnostic on purpose: these strings are rendered next to figures the
 * dashboard has already labelled with a currency, and a second symbol from a
 * pure module that does not know the client's currency would be a guess.
 */
function money(v: number): string {
  return v >= 100 ? `$${Math.round(v).toLocaleString("en-US")}` : `$${v.toFixed(2)}`;
}

function pct(p: number): string {
  return `${Math.round(p * 100)}%`;
}
