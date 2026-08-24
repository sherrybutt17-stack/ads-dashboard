import { OUTCOME_LABEL, OUTCOME_NOUN, OUTCOME_STAGES, type OutcomeStage } from "./speed-outcome";

/**
 * Why last month looks worse than the month before, when it isn't.
 *
 * A client opens the dashboard on the 8th. June produced 35 leads, 12
 * appointments and 4 closed deals; July produced 40 leads, 3 appointments and
 * nothing. The campaign gets switched off. What actually happened is that
 * July's leads are eleven days old and this business closes in six weeks — June
 * looked identical on ITS eighth day, and the two numbers being compared were
 * never comparable.
 *
 * This is the same right-censoring that shapes the speed-to-lead panel, one
 * level up: there it decided whether a single lead could be judged, here it
 * decides whether a whole month can. It is also the most expensive version of
 * the mistake, because the action it triggers is killing a working campaign.
 *
 * ---
 *
 * **The method is a development triangle, which is a solved problem.**
 *
 * Actuaries have projected incurred-but-not-reported claims this way for a
 * century: cohorts as rows, age-since-arrival as columns, and the fill-in
 * pattern of the mature rows applied to the immature ones. Nothing here is
 * invented, which is the point — a bespoke heuristic for this would be a worse
 * version of a method with a name.
 *
 * **🔴 The curve must be estimated from mature cohorts ONLY.** Fold recent
 * cohorts in and they contribute their early conversions without their late
 * ones, so the curve reports that conversions land sooner than they do — and a
 * curve that is too fast makes an immature month look nearly complete, which is
 * exactly the error being corrected. The bias runs in the direction that
 * silently defeats the feature.
 *
 * **🔴 Projection is not observation, and the panel never blurs them.** The
 * observed count is always the primary figure. A projection is secondary,
 * labelled, quoted with the maturity it rests on, and refused entirely below
 * `MIN_MATURITY_TO_PROJECT` — at 5% maturity the arithmetic turns one
 * appointment into twenty, which is not an estimate, it is a rumour.
 *
 * **The strongest output needs no projection at all.** Truncating both cohorts
 * to the same age compares counted numbers with counted numbers: "at eleven
 * days old, June had 2 appointments and July has 3." That is the sentence that
 * stops the campaign being killed, and every figure in it was observed.
 */

/** Conversions later than this are out of scope, and the panel says so. */
export const HORIZON_DAYS = 90;

/** Ages the curve is estimated at. Dense early, where the shape moves. */
const GRID = [1, 3, 7, 14, 21, 30, 45, 60, 75, 90] as const;

/** A cohort with fewer conversions than this gives a curve of 0s and 1s. */
const MIN_COHORT_CONVERSIONS = 5;
/** Below this many usable cohorts the curve is one month's habit. */
const MIN_COHORTS = 3;
/** Below this share landed, projecting multiplies noise by four or more. */
const MIN_MATURITY_TO_PROJECT = 0.25;

/* ------------------------------------------------------------------ *
 * Inputs
 * ------------------------------------------------------------------ */

export interface CohortInput {
  /** Calendar month key, `YYYY-MM`. */
  month: string;
  label: string;
  /** Paid leads that arrived in the month. */
  leads: number;
  /** Start of the month, in the client's timezone, as a UTC instant. */
  startUtc: string;
  /** True once the calendar month itself has ended. */
  complete: boolean;
}

/** One conversion, placed by the cohort it belongs to and its age at the time. */
export interface ConversionInput {
  month: string;
  stage: OutcomeStage;
  /** Days from the lead arriving to first reaching the stage. */
  days: number;
}

/* ------------------------------------------------------------------ *
 * Outputs
 * ------------------------------------------------------------------ */

export interface CurvePoint {
  day: number;
  /** Share of a cohort's eventual conversions that have landed by this age. */
  share: number;
}

export interface StageCurve {
  stage: OutcomeStage;
  label: string;
  noun: string;
  curve: CurvePoint[];
  /** Ages by which half and nine-tenths of conversions have landed. */
  halfDays: number | null;
  ninetyDays: number | null;
  /** Mature cohorts the curve was measured from. */
  basis: number;
  measured: boolean;
}

export interface CohortStage {
  /** Counted. Always the primary figure. */
  observed: number;
  /** Share of this cohort's eventual conversions expected to have landed. */
  maturity: number;
  /** Inferred final count, or null when too early to be worth saying. */
  projected: number | null;
}

export interface CohortRow {
  month: string;
  label: string;
  leads: number;
  /** Days since the cohort opened. */
  ageDays: number;
  /** The calendar month has ended, so the lead count itself is final. */
  complete: boolean;
  stages: Record<OutcomeStage, CohortStage>;
}

/**
 * The two most recent cohorts, each truncated to the age of the younger.
 *
 * Every number here was counted, not inferred — which is what makes it the
 * finding rather than the projection beside it.
 */
export interface EqualAgeCheck {
  stage: OutcomeStage;
  /** The age both cohorts are cut to: how old the younger one is today. */
  atDays: number;
  recent: { label: string; leads: number; converted: number; rate: number | null };
  prior: { label: string; leads: number; converted: number; rate: number | null };
  /**
   * 🔴 The raw side-by-side says the recent cohort is worse, and the like-for-
   * like comparison says it is not. This is the flag the whole feature exists
   * to raise.
   */
  misleading: boolean;
  /** Raw, untruncated counts — what the month-on-month table shows today. */
  rawRecent: number;
  rawPrior: number;
}

export interface MaturationReport {
  curves: StageCurve[];
  cohorts: CohortRow[];
  checks: EqualAgeCheck[];
  horizonDays: number;
}

export const EMPTY_MATURATION: MaturationReport = {
  curves: [],
  cohorts: [],
  checks: [],
  horizonDays: HORIZON_DAYS,
};

/* ------------------------------------------------------------------ *
 * The curve
 * ------------------------------------------------------------------ */

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Linear interpolation along the curve; 0 before the first point, 1 past 90. */
export function shareAt(curve: readonly CurvePoint[], day: number): number {
  if (curve.length === 0) return 0;
  if (day >= HORIZON_DAYS) return 1;
  if (day <= 0) return 0;
  let prev: CurvePoint = { day: 0, share: 0 };
  for (const p of curve) {
    if (day <= p.day) {
      const span = p.day - prev.day;
      if (span <= 0) return p.share;
      return prev.share + ((p.share - prev.share) * (day - prev.day)) / span;
    }
    prev = p;
  }
  return prev.share;
}

/** The age at which the curve first reaches `target`. */
function ageAtShare(curve: readonly CurvePoint[], target: number): number | null {
  if (curve.length === 0) return null;
  let prev: CurvePoint = { day: 0, share: 0 };
  for (const p of curve) {
    if (p.share >= target) {
      const rise = p.share - prev.share;
      if (rise <= 0) return p.day;
      return prev.day + ((target - prev.share) * (p.day - prev.day)) / rise;
    }
    prev = p;
  }
  return null;
}

function buildCurve(
  stage: OutcomeStage,
  cohorts: readonly CohortInput[],
  conversions: readonly ConversionInput[],
  ageOf: (c: CohortInput) => number,
): StageCurve {
  const byMonth = new Map<string, number[]>();
  for (const c of conversions) {
    if (c.stage !== stage) continue;
    if (!(c.days >= 0) || c.days > HORIZON_DAYS) continue;
    const list = byMonth.get(c.month);
    if (list) list.push(c.days);
    else byMonth.set(c.month, [c.days]);
  }

  /*
   * 🔴 Mature cohorts only. A cohort younger than the horizon has not finished
   * converting, so its late conversions are missing from the denominator AND
   * from the numerator — which reports the curve as steeper than it is, makes
   * every recent month look nearly complete, and quietly cancels the correction
   * this whole module exists to apply.
   */
  const usable = cohorts.filter((c) => {
    if (ageOf(c) < HORIZON_DAYS) return false;
    return (byMonth.get(c.month)?.length ?? 0) >= MIN_COHORT_CONVERSIONS;
  });

  const base = {
    stage,
    label: OUTCOME_LABEL[stage],
    noun: OUTCOME_NOUN[stage],
  };

  if (usable.length < MIN_COHORTS) {
    return { ...base, curve: [], halfDays: null, ninetyDays: null, basis: usable.length, measured: false };
  }

  const curve: CurvePoint[] = GRID.map((day) => {
    // Median across cohorts, not a pooled ratio: one freak month with a single
    // enormous batch of conversions would otherwise set the shape for the book.
    const shares = usable.map((c) => {
      const days = byMonth.get(c.month)!;
      return days.filter((d) => d <= day).length / days.length;
    });
    return { day, share: median(shares) };
  });

  /*
   * There is deliberately no monotonicity clamp here, though the shape of the
   * code invites one. Each cohort's own share is a count of conversions at or
   * before an age divided by a fixed total, so it cannot fall as the age rises;
   * and the median of a set of pointwise-ordered values is itself pointwise
   * ordered. The curve therefore cannot run backwards, and a clamp would be a
   * guard that can never fire — removed once a mutation proved no test could
   * tell it apart from nothing.
   */

  return {
    ...base,
    curve,
    halfDays: ageAtShare(curve, 0.5),
    ninetyDays: ageAtShare(curve, 0.9),
    basis: usable.length,
    measured: true,
  };
}

/* ------------------------------------------------------------------ *
 * Engine
 * ------------------------------------------------------------------ */

export function buildMaturation(
  cohorts: readonly CohortInput[],
  conversions: readonly ConversionInput[],
  opts: { asOf: Date },
): MaturationReport {
  const asOfMs = opts.asOf.getTime();
  const ageOf = (c: CohortInput) =>
    Math.max(0, (asOfMs - Date.parse(c.startUtc)) / 86_400_000);

  const curves = OUTCOME_STAGES.map((s) => buildCurve(s, cohorts, conversions, ageOf));
  const curveFor = new Map(curves.map((c) => [c.stage, c]));

  const counted = new Map<string, number>();
  for (const c of conversions) {
    if (!(c.days >= 0) || c.days > HORIZON_DAYS) continue;
    const key = `${c.month}|${c.stage}`;
    counted.set(key, (counted.get(key) ?? 0) + 1);
  }

  const rows: CohortRow[] = [...cohorts]
    .sort((a, b) => (a.month < b.month ? 1 : -1))
    .map((c) => {
      const ageDays = ageOf(c);
      const stages = {} as Record<OutcomeStage, CohortStage>;
      for (const stage of OUTCOME_STAGES) {
        const observed = counted.get(`${c.month}|${stage}`) ?? 0;
        const cv = curveFor.get(stage)!;
        const maturity = cv.measured ? shareAt(cv.curve, ageDays) : ageDays >= HORIZON_DAYS ? 1 : 0;
        stages[stage] = {
          observed,
          maturity,
          /*
           * Refused below a quarter matured. Dividing by 0.05 turns one
           * appointment into twenty and puts a number on the screen that is
           * mostly the reciprocal of a guess.
           */
          projected:
            maturity >= MIN_MATURITY_TO_PROJECT && cv.measured
              ? Math.round(observed / maturity)
              : null,
        };
      }
      return { month: c.month, label: c.label, leads: c.leads, ageDays, complete: c.complete, stages };
    });

  return {
    curves,
    cohorts: rows,
    checks: equalAgeChecks(cohorts, conversions, ageOf),
    horizonDays: HORIZON_DAYS,
  };
}

/**
 * The like-for-like comparison — the part with no inference in it.
 *
 * Both cohorts are cut to the age of the younger, so the only thing that
 * differs between the two numbers is the advertising. A raw month-on-month row
 * compares a finished month against a third of a month and calls the difference
 * performance.
 */
export function equalAgeChecks(
  cohorts: readonly CohortInput[],
  conversions: readonly ConversionInput[],
  ageOf: (c: CohortInput) => number,
): EqualAgeCheck[] {
  const ordered = [...cohorts].sort((a, b) => (a.month < b.month ? 1 : -1));
  const recent = ordered[0];
  const prior = ordered[1];
  if (!recent || !prior) return [];

  const atDays = Math.floor(ageOf(recent));
  if (atDays <= 0) return [];

  const countAt = (month: string, stage: OutcomeStage, maxDays: number) =>
    conversions.filter(
      (c) => c.month === month && c.stage === stage && c.days >= 0 && c.days <= maxDays,
    ).length;
  const rawCount = (month: string, stage: OutcomeStage) =>
    countAt(month, stage, HORIZON_DAYS);

  const rate = (k: number, n: number) => (n > 0 ? k / n : null);

  return OUTCOME_STAGES.map((stage) => {
    const rK = countAt(recent.month, stage, atDays);
    const pK = countAt(prior.month, stage, atDays);
    const rawRecent = rawCount(recent.month, stage);
    const rawPrior = rawCount(prior.month, stage);

    const rRate = rate(rK, recent.leads);
    const pRate = rate(pK, prior.leads);

    /*
     * 🔴 The flag, and every clause in it is load-bearing.
     *
     * Raw the recent cohort looks worse; at equal age it is level or better; and
     * — the clause live data forced — the truncation actually removed something
     * from the older cohort. Without that last condition the flag fires on GG's
     * bookings, which land the same day the lead arrives: cutting July to
     * twelve days changes its count not at all, so maturity explains nothing
     * and the difference is lead volume. Announcing "July has had months to
     * fill in" about a stage that fills in overnight is a false explanation,
     * which is worse than a missing one — it is the kind of confident wrong
     * sentence a client repeats in a meeting.
     *
     * A month that is genuinely worse looks worse both ways, and shouting
     * "misleading" at it would teach the reader to ignore the flag on the month
     * where it matters.
     */
    const maturityExplainsIt = pK < rawPrior;
    const misleading =
      rawRecent < rawPrior &&
      maturityExplainsIt &&
      rRate !== null &&
      pRate !== null &&
      rRate >= pRate &&
      // Nothing to be misled about if neither cohort produced anything.
      (rK > 0 || pK > 0);

    return {
      stage,
      atDays,
      recent: { label: recent.label, leads: recent.leads, converted: rK, rate: rRate },
      prior: { label: prior.label, leads: prior.leads, converted: pK, rate: pRate },
      misleading,
      rawRecent,
      rawPrior,
    };
  });
}
