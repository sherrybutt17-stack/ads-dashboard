import { probRateBelow } from "./stats";
import { median } from "./anomaly";
import type { CreativeType } from "@/db/schema";

/**
 * Creative fatigue — "this ad used to work and has stopped".
 *
 * Every other engine on this dashboard compares one thing against another
 * thing: campaigns against the rest of the account, this period against the
 * last. Fatigue is the one question that compares a creative **against its own
 * past**, and that difference is what makes it worth having. A creative that
 * has always been mediocre is a keep/kill problem. A creative that was the best
 * thing in the account six weeks ago and is now the worst is a *different*
 * problem with a different fix — make another one — and no ranking table can
 * show it, because on any single week's leaderboard it just looks average.
 *
 * ---
 *
 * FOUR SIGNALS, AND THE ORDER THEY FIRE IN
 *
 * All four come from columns already synced at ad level. They are not
 * interchangeable, and treating them as a checklist of equals is how this
 * feature gets built wrong:
 *
 * | Signal | What it is | When it moves |
 * |---|---|---|
 * | **CTR** | link clicks ÷ impressions | first — the audience has seen it and stopped clicking |
 * | **Hook rate** | 3-second views ÷ impressions | first, for video — the thumb stopped stopping |
 * | **CPM** | spend ÷ impressions | second — the auction charges more to keep delivering a stale ad |
 * | **Cost per lead** | spend ÷ leads | last — the money consequence, by which point weeks are gone |
 *
 * 🔴 **A cost signal alone is never reported as fatigue.** CPM rising across a
 * whole account in November is the auction, not the advertising; cost per lead
 * rising on twelve leads is usually the twelve. Something is called fatigue
 * only when a *response* signal — CTR or hook rate — has moved, because that is
 * the only one of the four that describes the audience's reaction to the
 * creative rather than the market's reaction to the budget. Creatives whose
 * cost moved while engagement held are counted and reported as exactly that.
 *
 * ---
 *
 * THREE THINGS THAT WOULD MAKE THIS FIRE ON NOISE, HANDLED
 *
 * **1 · The Poisson floor is not enough — the real noise is bigger.** Clicks on
 * impressions look binomial, and at these volumes a naive binomial test calls a
 * 4% CTR move "99.9% significant" on 200,000 impressions. It is not: real
 * delivery varies by placement, hour and audience segment far more than
 * coin-flips do. So each signal's posterior is widened by an **overdispersion
 * factor estimated from the creative's own daily history** (quasi-Poisson), and
 * the estimate is robust — the median of the squared Pearson residuals rather
 * than their mean — so one freak day cannot silence the engine, and a genuinely
 * erratic creative is correctly hard to draw conclusions about. The factor is
 * floored at 1: this can only ever make the engine *less* confident than the
 * counting statistics, never more.
 *
 * **2 · Dispersion measured on the baseline only.** Estimating it across both
 * windows would fold the very shift being tested into the yardstick it is
 * measured against — the same self-masking that makes mean-and-standard-
 * deviation the wrong tool in `anomaly.ts`. The baseline window answers "how
 * much does an ordinary day for this creative move", which is the question.
 *
 * **3 · The whole account moving is not this creative fatiguing.** Every
 * comparison is adjusted by what the *rest* of the account did over the same
 * calendar dates, leave-one-out — a creative carrying most of the spend would
 * otherwise be compared against itself, and seasonality would be read as decay.
 * Only the excess over the market has to clear the effect-size floor.
 *
 * Pure and deterministic: same series in, same findings out. No I/O, no clock.
 */

/* ------------------------------------------------------------------ *
 * Tuning
 * ------------------------------------------------------------------ */

/**
 * The recent window, in days the creative actually delivered.
 *
 * Seven, so every weekday appears once: ad response is strongly weekday-shaped
 * for a service business, and a five-day window that happened to land on a
 * weekend would read as decay on every creative in the account at once.
 *
 * **Delivery days, not calendar days.** A creative paused for a fortnight and
 * switched back on has thirteen zero rows that are not evidence of anything; a
 * calendar window would make its recent performance mostly absence.
 */
export const RECENT_DAYS = 7;

/** Days of the creative's own history a judgement is made against. */
export const MIN_BASELINE_DAYS = 7;

/**
 * Calendar days of history the engine is fed.
 *
 * Eight weeks, not two — the fourteen *delivery* days the engine needs are not
 * fourteen calendar days for a creative that runs five days a week, or one
 * rotated in and out of a testing ad set. Long enough that a real baseline
 * survives the gaps, short enough that the query stays one indexed range scan
 * and that "its own past" still means something: a creative's audience eight
 * weeks ago is a different pool from today's.
 */
export const FATIGUE_DAYS = 56;

/** P(the recent rate is genuinely below the baseline rate) to report a signal. */
const CONFIDENCE = 0.9;

/** Jeffreys prior on a Poisson rate — the same choice keep/kill makes. */
const PRIOR_SHAPE = 0.5;

/**
 * Money in the recent window before a creative is worth judging.
 *
 * The recommendation this engine produces is "make another one", which costs
 * real time. Below this there is nothing at stake worth a shoot, however
 * certain the arithmetic is. Recent rather than lifetime, because the question
 * is what to do with the budget flowing *now*.
 *
 * In the ad account's currency, like every other threshold in this codebase.
 */
const MIN_RECENT_SPEND = 75;

/**
 * Gap between the baseline and recent windows past which saturation has likely
 * reset, and the comparison is worth caveating.
 *
 * A creative switched off for a fortnight comes back to an audience that has
 * had two weeks to forget it, so "its own past" is a weaker reference than
 * usual. Below this the gap is a scheduling detail and saying so is noise.
 */
export const RESET_GAP_DAYS = 7;

/** Findings rendered at once. Beyond a handful nobody acts on any of them. */
const MAX_FINDINGS = 5;

/**
 * Median of a χ²₁ distribution.
 *
 * The robust dispersion estimator divides the median squared Pearson residual
 * by this, because under a correctly-specified Poisson model each residual is
 * χ²₁ and its median — not its mean of 1 — is what a median estimator recovers.
 * Dividing by 1 instead would report every well-behaved creative as
 * *under*-dispersed by a factor of two, and the floor at 1 would hide the error
 * completely until someone raised the floor.
 */
const CHI2_1_MEDIAN = 0.4549364;

/* ------------------------------------------------------------------ *
 * Input
 * ------------------------------------------------------------------ */

/** One creative's totals for one day. All additive; ratios are never stored. */
export interface CreativeDay {
  dateKey: string;
  impressions: number;
  linkClicks: number;
  video3sViews: number;
  spend: number;
  leads: number;
  /** Deduplicated people, for this asset on this day. NEVER sum across days. */
  reach: number;
  /** Distinct ads carrying this asset that day — the guard on `reach`. */
  adCount: number;
}

export interface FatigueInput {
  creativeKey: string;
  name: string;
  type: CreativeType;
  /** At least one ad carrying this asset is live. */
  active: boolean;
  /** At least one ad set running it has not exited Meta's learning phase. */
  learning: boolean;
  thumbnailUrl: string | null;
  days: readonly CreativeDay[];
}

/* ------------------------------------------------------------------ *
 * Signals
 * ------------------------------------------------------------------ */

export type SignalId = "ctr" | "hook" | "cpm" | "cpl";

interface SignalSpec {
  id: SignalId;
  label: string;
  /** The count whose rate is tested. */
  numerator: (d: CreativeDay) => number;
  /** What that count is a rate *per*. */
  exposure: (d: CreativeDay) => number;
  /**
   * Exposure required in EACH window before the comparison is attempted.
   *
   * Not a second significance test — the posterior comparison already declines
   * to be confident on thin data. What this stops is the case that test is
   * least equipped for: at a few hundred impressions the *dispersion estimate*
   * the whole comparison is calibrated on is itself a guess, so an unlucky
   * quiet week can clear 90% on four clicks against forty. It also bounds the
   * market reference, which is otherwise free to be computed from one small
   * neighbour's noise.
   */
  minExposure: number;
  /** Smallest market-adjusted decline in the rate worth reporting. */
  minDecline: number;
  /** Rate → the number a marketer would recognise from Ads Manager. */
  present: (rate: number) => number;
  kind: "percent" | "money";
  /** True when the presented metric RISES as the underlying rate decays. */
  inverted: boolean;
  /** Response signals describe the audience; cost signals describe the auction. */
  response: boolean;
  videoOnly?: true;
}

/**
 * Every signal is expressed as a rate that **falls** when the creative is
 * tiring, so there is exactly one test in this file and one direction to reason
 * about. CPM rising is impressions-per-dollar falling; cost per lead rising is
 * leads-per-dollar falling. `present` turns the rate back into the figure a
 * marketer names, and `inverted` records that the presented number moves the
 * other way.
 */
const SIGNALS: readonly SignalSpec[] = [
  {
    id: "ctr",
    label: "Click-through rate",
    numerator: (d) => d.linkClicks,
    exposure: (d) => d.impressions,
    minExposure: 1000,
    minDecline: 0.2,
    present: (r) => r,
    kind: "percent",
    inverted: false,
    response: true,
  },
  {
    id: "hook",
    label: "Hook rate",
    numerator: (d) => d.video3sViews,
    exposure: (d) => d.impressions,
    minExposure: 2000,
    minDecline: 0.2,
    present: (r) => r,
    kind: "percent",
    inverted: false,
    response: true,
    videoOnly: true,
  },
  {
    id: "cpm",
    label: "CPM",
    numerator: (d) => d.impressions,
    exposure: (d) => d.spend,
    minExposure: 100,
    minDecline: 0.15,
    present: (r) => (r > 0 ? 1000 / r : 0),
    kind: "money",
    inverted: true,
    response: false,
  },
  {
    id: "cpl",
    label: "Cost per lead",
    numerator: (d) => d.leads,
    exposure: (d) => d.spend,
    minExposure: 150,
    /* Noisiest of the four by a distance — leads are single digits per week. */
    minDecline: 0.3,
    present: (r) => (r > 0 ? 1 / r : 0),
    kind: "money",
    inverted: true,
    response: false,
  },
];

/* ------------------------------------------------------------------ *
 * Output
 * ------------------------------------------------------------------ */

export interface SignalFinding {
  id: SignalId;
  label: string;
  /** The presented metric — CTR as a fraction, CPM and CPL in account currency. */
  baseline: number;
  recent: number;
  /** Relative change in the RATE. Always negative: these only fire on decay. */
  change: number;
  /** The same move for the rest of the account over the same dates, or null. */
  market: number | null;
  /** `change` with `market` removed. What actually has to clear the floor. */
  excess: number;
  /** P(the recent rate is genuinely below the baseline rate). */
  confidence: number;
  /** Quasi-Poisson factor the posteriors were widened by. 1 = pure counting. */
  dispersion: number;
  kind: "percent" | "money";
  inverted: boolean;
  response: boolean;
}

/**
 * Daily frequency, and an honest account of why it is only daily.
 *
 * 🔴 Meta reports `reach` per ad per day, and reach is **deduplicated people**.
 * The same asset running in four ad sets reaches four overlapping groups, and a
 * week's reach is not the sum of seven days' — so there is no arithmetic that
 * turns these rows into "this creative's 7-day frequency", which is the number
 * the ≥3 rule of thumb refers to. Summing anyway is what produces the
 * plausible, wrong frequency figures elsewhere in this category: it inflates
 * the denominator, understates frequency, and therefore *hides* saturation.
 *
 * What is available is each day's own figure, which is a valid ratio of two
 * numbers from one row — and only on days the asset ran as a single ad, since
 * otherwise even one day's reach is a sum of overlapping groups.
 */
export interface FrequencyContext {
  available: boolean;
  /** Median daily frequency, baseline window. */
  baseline: number | null;
  recent: number | null;
  /** Days that qualified — single ad, non-zero reach. */
  days: number;
  note: string;
}

export type Severity = "fatigued" | "watch";

export interface CreativeFatigue {
  creativeKey: string;
  name: string;
  thumbnailUrl: string | null;
  severity: Severity;
  signals: SignalFinding[];
  recentSpend: number;
  baselineDays: number;
  recentDays: number;
  baselineRange: [string, string];
  recentRange: [string, string];
  /** Calendar days between the last baseline day and the first recent one. */
  gapDays: number;
  learning: boolean;
  frequency: FrequencyContext;
}

export interface FatigueReport {
  findings: CreativeFatigue[];
  /** Creatives that had enough history and money to be tested. */
  judged: number;
  /** Findings that qualified but are not rendered, so the cap is never silent. */
  hidden: number;
  skipped: {
    /** Nothing is running them, so there is no decision to make. */
    inactive: number;
    /** Not enough delivery days yet to have a "before". */
    tooNew: number;
    /** Running, but with too little money in the last week to be worth a shoot. */
    tooSmall: number;
  };
  /**
   * Creatives whose cost rose while CTR and hook rate held.
   *
   * Deliberately NOT findings. Reported as a count so the number is visible
   * without being dressed as something the creative did.
   */
  costOnly: number;
}

export const EMPTY_FATIGUE_REPORT: FatigueReport = {
  findings: [],
  judged: 0,
  hidden: 0,
  skipped: { inactive: 0, tooNew: 0, tooSmall: 0 },
  costOnly: 0,
};

/* ------------------------------------------------------------------ *
 * Statistics
 * ------------------------------------------------------------------ */

/** A count and what it is a count *per*. One day's worth, or one window's. */
export interface Totals {
  k: number;
  n: number;
}

function totals(days: readonly CreativeDay[], spec: SignalSpec): Totals {
  let k = 0;
  let n = 0;
  for (const d of days) {
    k += spec.numerator(d);
    n += spec.exposure(d);
  }
  return { k, n };
}

/**
 * How much more than Poisson does this creative's own day-to-day move?
 *
 * The Pearson residual for a day is `(observed − expected) / √expected`, and
 * under a correct Poisson model its square is χ²₁. The conventional dispersion
 * estimate is the MEAN of those squares, which one aberrant day can multiply
 * tenfold — and since a large factor makes the engine mute, a single freak day
 * would switch fatigue detection off for that creative entirely. The median is
 * used instead, rescaled by the χ²₁ median, for the same reason `anomaly.ts`
 * uses MAD over standard deviation.
 *
 * Floored at 1. Real delivery is never *less* variable than counting noise, and
 * a factor below 1 would make the engine more confident than the data allows —
 * the one direction of error that costs somebody a working creative.
 */
export function robustDispersion(
  days: readonly Totals[],
  rate: number,
): number {
  if (!(rate > 0)) return 1;
  const squares: number[] = [];
  for (const { k, n } of days) {
    if (!(n > 0)) continue;
    const expected = n * rate;
    if (!(expected > 0)) continue;
    const resid = k - expected;
    squares.push((resid * resid) / expected);
  }
  // Below three days the median is itself noise; assume pure counting noise.
  if (squares.length < 3) return 1;
  return Math.max(1, median(squares) / CHI2_1_MEDIAN);
}

/**
 * P(recent rate < baseline rate), both sides uncertain.
 *
 * Counts and exposures are divided by the dispersion factor before forming the
 * posteriors. That is the standard quasi-Poisson device and it does exactly
 * what it should: the posterior mean `k/n` is unchanged, while its variance is
 * multiplied by φ. Widening only one side, or widening the interval after the
 * fact, would leave the two posteriors on different footings.
 */
function confidenceOfDecay(
  recent: Totals,
  baseline: Totals,
  dispersion: number,
): number {
  const phi = Math.max(1, dispersion);
  return probRateBelow(
    PRIOR_SHAPE + recent.k / phi,
    recent.n / phi,
    PRIOR_SHAPE + baseline.k / phi,
    baseline.n / phi,
  );
}

/* ------------------------------------------------------------------ *
 * Presentation helpers
 * ------------------------------------------------------------------ */

/**
 * The change as the reader sees it: CTR falling 30% is CTR falling 30%, but a
 * rate falling 30% is a CPM *rising* 43%, and quoting the first number next to
 * the second pair of dollar figures is how a report loses an argument.
 */
export function humanChange(f: SignalFinding): number {
  if (!(f.baseline > 0)) return 0;
  return (f.recent - f.baseline) / f.baseline;
}

/** The same conversion for the account-wide move, which has no pair of values. */
export function humanMarketChange(f: SignalFinding): number | null {
  if (f.market === null) return null;
  if (!f.inverted) return f.market;
  const factor = 1 + f.market;
  if (!(factor > 0)) return null;
  return 1 / factor - 1;
}

/* ------------------------------------------------------------------ *
 * The engine
 * ------------------------------------------------------------------ */

function byDate(a: CreativeDay, b: CreativeDay): number {
  return a.dateKey < b.dateKey ? -1 : a.dateKey > b.dateKey ? 1 : 0;
}

function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round(
    (Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000,
  );
}

/**
 * The rest of the account over the same calendar dates, this creative removed.
 *
 * Indexed by date rather than by creative so the leave-one-out subtraction is a
 * single pass: total for the span, minus this creative's own contribution to it.
 * Inactive creatives are included — the market is what the auction did, and a
 * creative switched off last week was still competing in the baseline.
 */
function marketIndex(
  creatives: readonly FatigueInput[],
): Map<string, CreativeDay[]> {
  const byDay = new Map<string, CreativeDay[]>();
  for (const c of creatives) {
    for (const d of c.days) {
      const list = byDay.get(d.dateKey);
      if (list) list.push(d);
      else byDay.set(d.dateKey, [d]);
    }
  }
  return byDay;
}

function spanTotals(
  index: Map<string, CreativeDay[]>,
  from: string,
  to: string,
  spec: SignalSpec,
): Totals {
  let k = 0;
  let n = 0;
  for (const [dateKey, days] of index) {
    if (dateKey < from || dateKey > to) continue;
    for (const d of days) {
      k += spec.numerator(d);
      n += spec.exposure(d);
    }
  }
  return { k, n };
}

/**
 * The market's relative move in the rate, or null when there is nothing to
 * compare against.
 *
 * Null is a real answer and is reported as one. A single-creative account has
 * no market; so does an account where every other asset is below the exposure
 * floor. Substituting zero there would silently claim "the rest of the account
 * was flat", which is a statement about data nobody has.
 */
function marketMove(
  index: Map<string, CreativeDay[]>,
  own: readonly CreativeDay[],
  baselineRange: [string, string],
  recentRange: [string, string],
  spec: SignalSpec,
): number | null {
  const subtract = (all: Totals, mine: Totals): Totals => ({
    k: all.k - mine.k,
    n: all.n - mine.n,
  });

  const inSpan = (from: string, to: string) =>
    own.filter((d) => d.dateKey >= from && d.dateKey <= to);

  const base = subtract(
    spanTotals(index, baselineRange[0], baselineRange[1], spec),
    totals(inSpan(baselineRange[0], baselineRange[1]), spec),
  );
  const now = subtract(
    spanTotals(index, recentRange[0], recentRange[1], spec),
    totals(inSpan(recentRange[0], recentRange[1]), spec),
  );

  if (base.n < spec.minExposure || now.n < spec.minExposure) return null;
  const baseRate = base.k / base.n;
  if (!(baseRate > 0)) return null;
  return (now.k / now.n - baseRate) / baseRate;
}

function frequencyContext(
  baseline: readonly CreativeDay[],
  recent: readonly CreativeDay[],
): FrequencyContext {
  const usable = (days: readonly CreativeDay[]) =>
    days
      .filter((d) => d.adCount === 1 && d.reach > 0 && d.impressions > 0)
      .map((d) => d.impressions / d.reach);

  const b = usable(baseline);
  const r = usable(recent);
  const note =
    "Daily frequency. Meta reports reach per ad per day and reach is deduplicated people, so a period figure for an asset cannot be summed out of daily rows — the familiar “keep it under 3” rule refers to a 7-day figure and does not apply here. Measured only on days this asset ran as a single ad.";

  if (b.length < 3 || r.length < 3) {
    return {
      available: false,
      baseline: null,
      recent: null,
      days: b.length + r.length,
      note,
    };
  }
  return {
    available: true,
    baseline: median(b),
    recent: median(r),
    days: b.length + r.length,
    note,
  };
}

/**
 * Assess every creative.
 *
 * Ordering is by money at risk — recent spend weighted by confidence — because
 * the list is read as a work queue and the first row should be the one where a
 * week of inaction costs the most.
 */
export function assessFatigue(creatives: readonly FatigueInput[]): FatigueReport {
  const index = marketIndex(creatives);
  const qualified: CreativeFatigue[] = [];
  const skipped = { inactive: 0, tooNew: 0, tooSmall: 0 };
  let judged = 0;
  let costOnly = 0;

  for (const c of creatives) {
    /*
     * A paused creative cannot fatigue in any actionable sense — the decision
     * has already been made. Counted, not silently dropped.
     */
    if (!c.active) {
      skipped.inactive++;
      continue;
    }

    const delivery = [...c.days].filter((d) => d.impressions > 0).sort(byDate);
    if (delivery.length < RECENT_DAYS + MIN_BASELINE_DAYS) {
      skipped.tooNew++;
      continue;
    }

    const recent = delivery.slice(-RECENT_DAYS);
    const baseline = delivery.slice(0, -RECENT_DAYS);
    const recentSpend = recent.reduce((a, d) => a + d.spend, 0);
    if (recentSpend < MIN_RECENT_SPEND) {
      skipped.tooSmall++;
      continue;
    }

    judged++;

    const baselineRange: [string, string] = [
      baseline[0].dateKey,
      baseline[baseline.length - 1].dateKey,
    ];
    const recentRange: [string, string] = [
      recent[0].dateKey,
      recent[recent.length - 1].dateKey,
    ];
    const gapDays = daysBetween(baselineRange[1], recentRange[0]) - 1;

    const signals: SignalFinding[] = [];
    for (const spec of SIGNALS) {
      if (spec.videoOnly && c.type !== "video") continue;

      const b = totals(baseline, spec);
      const r = totals(recent, spec);
      if (b.n < spec.minExposure || r.n < spec.minExposure) continue;

      const baseRate = b.k / b.n;
      const recentRate = r.k / r.n;
      // Nothing to divide by, and nothing to have declined from.
      if (!(baseRate > 0)) continue;

      /*
       * 🔴 BOTH the creative's own move and what is left of it after the market
       * has been removed must clear the floor, and the order of these two lines
       * is the whole point.
       *
       * With only the second, a booming account manufactures findings out of
       * nothing: a creative whose CTR slipped 5% while everyone else's rose 50%
       * has a market-adjusted excess of −55% and would be reported as fatigued,
       * on a real-world move of five percent. Nobody reshoots a video over
       * that, and the card would have to print "CTR fell 5%" under a fatigue
       * heading. Relative underperformance against the rest of the account is a
       * real thing and it is keep/kill's question, not this one.
       *
       * With only the first, seasonality reads as decay — see `marketMove`.
       *
       * The direction check is implied: a `change` of zero or better cannot be
       * more negative than a positive floor.
       */
      const change = (recentRate - baseRate) / baseRate;
      if (change > -spec.minDecline) continue;

      const market = marketMove(index, c.days, baselineRange, recentRange, spec);
      const excess = change - (market ?? 0);
      if (excess > -spec.minDecline) continue;

      /*
       * 🔴 Baseline days only. Including the recent window would let the shift
       * being tested inflate the yardstick it is measured against — the same
       * self-masking that rules out mean-and-standard-deviation in `anomaly.ts`.
       */
      const dispersion = robustDispersion(
        baseline.map((d) => ({ k: spec.numerator(d), n: spec.exposure(d) })),
        baseRate,
      );
      const confidence = confidenceOfDecay(r, b, dispersion);
      if (!(confidence >= CONFIDENCE)) continue;

      signals.push({
        id: spec.id,
        label: spec.label,
        baseline: spec.present(baseRate),
        recent: spec.present(recentRate),
        change,
        market,
        excess,
        confidence,
        dispersion,
        kind: spec.kind,
        inverted: spec.inverted,
        response: spec.response,
      });
    }

    if (signals.length === 0) continue;

    /*
     * 🔴 The classification rule, and the reason this engine is not a
     * threshold. A response signal says the audience stopped reacting to the
     * creative; a cost signal on its own says the auction got more expensive,
     * which every creative in the account experiences together and which no new
     * video will fix.
     */
    const hasResponse = signals.some((s) => s.response);
    if (!hasResponse) {
      costOnly++;
      continue;
    }
    const hasCost = signals.some((s) => !s.response);

    /*
     * Learning caps the severity rather than suppressing the finding. A CTR
     * collapse is still a CTR collapse; what learning undermines is the claim
     * that recent delivery represents the creative's steady state, and that is
     * a difference between "act now" and "watch this".
     */
    const severity: Severity = hasCost && !c.learning ? "fatigued" : "watch";

    // Strongest first within a card, so the headline claim leads.
    signals.sort((a, b2) => Math.abs(b2.excess) - Math.abs(a.excess));

    const frequency = frequencyContext(baseline, recent);

    qualified.push({
      creativeKey: c.creativeKey,
      name: c.name,
      thumbnailUrl: c.thumbnailUrl,
      severity,
      signals,
      recentSpend,
      baselineDays: baseline.length,
      recentDays: recent.length,
      baselineRange,
      recentRange,
      gapDays,
      learning: c.learning,
      frequency,
    });
  }

  qualified.sort((a, b) => risk(b) - risk(a));

  return {
    findings: qualified.slice(0, MAX_FINDINGS),
    judged,
    hidden: Math.max(0, qualified.length - MAX_FINDINGS),
    skipped,
    costOnly,
  };
}

/** Money at stake, discounted by how sure we are. */
function risk(f: CreativeFatigue): number {
  const best = Math.max(...f.signals.map((s) => s.confidence));
  return f.recentSpend * best;
}
