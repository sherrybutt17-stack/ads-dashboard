/**
 * Where this month lands if nothing changes.
 *
 * ── 🔴 Only spend and leads are forecast, and that is the design ───────
 *
 * The obvious next columns are appointments, shows and closes, and every one of
 * them would be systematically wrong in the same direction.
 *
 * A lead is instantaneous: it arrived on the day it arrived, and a day's lead
 * count is final the moment the day ends. An appointment is not. Leads arriving
 * on the 28th have not had time to book by the 31st — §6.9 measures that
 * maturation directly and it runs to weeks — so the month-to-date appointment
 * count is not a sample of the month's appointment rate, it is a censored one.
 * Pacing it forward multiplies a number that is low BECAUSE the month is young,
 * and reports the resulting under-projection as a forecast. Every reader would
 * take it as a forecast of demand rather than an artifact of the calendar.
 *
 * So the two columns that can be honestly extrapolated are extrapolated and the
 * rest are absent. `MATURING_STAGES` records the reason next to the decision.
 *
 * ── Why the projection is weighted by weekday ─────────────────────────
 *
 * The naive form is `spend so far ÷ days elapsed × days in month`. It is wrong
 * whenever the days remaining are not a representative sample of the days
 * elapsed, which for a calendar month is most of the time: a month beginning on
 * a Friday has three weekend days in its first nine, so on the 9th a flat pace
 * projects the whole month at a weekend-heavy rate. For lead volume that gap is
 * large — the heatmap shows it on every client — and it is largest exactly at
 * the start of the month when the multiplier is biggest.
 *
 * So each weekday gets an index (its mean ÷ the overall mean) and the
 * projection is `observed × Σweights(all days) ÷ Σweights(observed days)`.
 * Because that is a ratio of weight sums, the normalisation of the weights
 * cancels — which is what makes it safe to leave an under-observed weekday at
 * a flat 1.0 rather than having to scale the rest around it.
 *
 * ── Two guards without which this would be worse than nothing ─────────
 *
 * · **Only COMPLETE days are observed.** Today is in progress; counting it as a
 *   full day drags the mean down by however much of it is left, and the effect
 *   is largest at the start of a month where the multiplier is largest. Today is
 *   projected, not observed.
 * · **Below `MIN_COMPLETE_DAYS` there is no forecast at all.** On the 3rd, two
 *   days are being multiplied by fifteen; the honest output is not a number with
 *   a wide band, it is the statement that it is too early.
 */

/**
 * ISO weekday, 1 (Monday) – 7 (Sunday), for a local date key.
 *
 * Lives here rather than in the loader because it is pure and because the
 * loader imports `queries.ts`, which opens a database connection at module
 * scope — importing this one function from there would make every arithmetic
 * test require a `DATABASE_URL`.
 *
 * Parsed as UTC deliberately. A date key already denotes a calendar date in the
 * client's timezone, so its weekday is a property of the string; constructing it
 * through the runtime's local zone would shift the day on any non-UTC host and
 * put every weekday index on the wrong bucket.
 */
export function isoDow(dateKey: string): number {
  const d = new Date(`${dateKey}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

export const MIN_COMPLETE_DAYS = 5;

/** A weekday needs this many observations before its own index is trusted. */
export const MIN_PER_WEEKDAY = 2;

/**
 * How far a weekday index may move the projection.
 *
 * A single Saturday that happened to carry a campaign launch would otherwise
 * produce an index of 6 and be applied to every remaining Saturday. The band is
 * wide enough to carry a real weekday effect and narrow enough that one
 * anomalous day cannot rewrite the month.
 */
export const INDEX_FLOOR = 0.3;
export const INDEX_CEILING = 3;

/** ~80% interval. Named rather than inlined because the panel says "80%". */
export const Z80 = 1.2816;

/** Stages deliberately not forecast, and why — rendered, not just commented. */
export const MATURING_STAGES =
  "Appointments, shows and closes are not projected: leads arriving late in the month have not had time to reach them yet, so pacing those forward would report the calendar as a decline.";

export type ForecastVerdict = "ok" | "too_early" | "no_data" | "month_over";

export interface ForecastMetric {
  key: "spend" | "leads";
  label: string;
  /** Complete days only. */
  observed: number;
  /** Observed + the projection for the days remaining. */
  projected: number;
  /** 80% interval on the projected total. */
  low: number;
  high: number;
  /** Same-length prior month, for context. Null when not supplied. */
  previous: number | null;
}

export interface ForecastReport {
  verdict: ForecastVerdict;
  monthKey: string;
  /** Complete days used as observations. */
  completeDays: number;
  /** Days still to come, including today. */
  remainingDays: number;
  daysInMonth: number;
  /** True when per-weekday indices were applied rather than a flat pace. */
  weekdayWeighted: boolean;
  metrics: ForecastMetric[];
  /** Projected spend ÷ projected leads. Null when either is unusable. */
  projectedCpl: number | null;
  /** Cost per lead over the complete days so far. */
  observedCpl: number | null;
}

export interface ForecastDay {
  dateKey: string;
  /** ISO weekday 1–7 in the client's timezone. */
  dow: number;
  spend: number;
  leads: number;
}

function mean(xs: readonly number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/**
 * Per-weekday multipliers, or all-ones when there is not enough to say.
 *
 * Returns `null` for "flat" rather than an array of ones so the caller can tell
 * the reader which of the two happened. A forecast that quietly stopped
 * adjusting for weekday is a different claim from one that never needed to.
 */
export function weekdayIndices(
  days: readonly ForecastDay[],
  value: (d: ForecastDay) => number,
): Map<number, number> | null {
  const overall = mean(days.map(value));
  if (!(overall > 0)) return null;

  const byDow = new Map<number, number[]>();
  for (const d of days) {
    const list = byDow.get(d.dow) ?? [];
    list.push(value(d));
    byDow.set(d.dow, list);
  }

  const idx = new Map<number, number>();
  let anyAdjusted = false;
  for (let dow = 1; dow <= 7; dow++) {
    const vals = byDow.get(dow);
    if (!vals || vals.length < MIN_PER_WEEKDAY) {
      // Not enough of this weekday yet. Flat, rather than a guess from one day.
      idx.set(dow, 1);
      continue;
    }
    const raw = mean(vals) / overall;
    const clamped = Math.min(Math.max(raw, INDEX_FLOOR), INDEX_CEILING);
    idx.set(dow, clamped);
    if (Math.abs(clamped - 1) > 1e-9) anyAdjusted = true;
  }

  return anyAdjusted ? idx : null;
}

function projectOne(
  days: readonly ForecastDay[],
  remaining: readonly number[],
  value: (d: ForecastDay) => number,
  indices: Map<number, number> | null,
): { projected: number; halfWidth: number } {
  const observed = days.reduce((a, d) => a + value(d), 0);
  const k = days.length;
  const r = remaining.length;
  if (r === 0) return { projected: observed, halfWidth: 0 };

  const weight = (dow: number) => indices?.get(dow) ?? 1;
  const wObserved = days.reduce((a, d) => a + weight(d.dow), 0);
  const wRemaining = remaining.reduce((a, dow) => a + weight(dow), 0);

  /*
   * Guard the divisor before it is a divisor. `wObserved` is a sum of clamped
   * positive weights over a non-empty list, so it cannot be zero — but this
   * function is the one place a zero would turn the whole forecast into NaN and
   * render as a blank panel with no explanation, so it is checked rather than
   * argued about.
   */
  const perWeight = wObserved > 0 ? observed / wObserved : 0;
  const projectedRemaining = perWeight * wRemaining;

  /*
   * The interval carries BOTH sources of error, because at these sample sizes
   * the second one dominates and omitting it would produce a band far too tight
   * to be honest:
   *
   *   · day-to-day variation across the days still to come — r·σ²
   *   · our uncertainty about the daily mean itself, from only k observations —
   *     r²·σ²/k
   *
   * The second term grows with r², so early in a month the band is wide. That
   * is the correct behaviour and the reason the band is shown at all.
   */
  const m = observed / k;
  const variance =
    k > 1
      ? days.reduce((a, d) => a + (value(d) - m) ** 2, 0) / (k - 1)
      : 0;
  const totalVar = r * variance + (r * r * variance) / k;
  const halfWidth = Z80 * Math.sqrt(Math.max(totalVar, 0));

  return { projected: observed + projectedRemaining, halfWidth };
}

export function buildForecast(
  days: readonly ForecastDay[],
  opts: {
    monthKey: string;
    /** Today's date key in the CLIENT's timezone. */
    todayKey: string;
    daysInMonth: number;
    /** ISO weekday for each remaining day, today first. */
    remainingDows: readonly number[];
    /** Same metrics over the whole prior month, for context. */
    previous?: { spend: number; leads: number } | null;
  },
): ForecastReport {
  const { monthKey, todayKey, daysInMonth, remainingDows } = opts;

  /*
   * Complete days only — strictly before today. See the header: today is in
   * progress, and counting a part-day as a whole one biases every projection
   * downward by however much of the day is left.
   */
  const complete = days
    .filter((d) => d.dateKey < todayKey)
    .sort((a, b) => a.dateKey.localeCompare(b.dateKey));

  const base = {
    monthKey,
    completeDays: complete.length,
    remainingDays: remainingDows.length,
    daysInMonth,
    weekdayWeighted: false,
    metrics: [] as ForecastMetric[],
    projectedCpl: null,
    observedCpl: null,
  };

  /*
   * A finished month is not a forecast — it is the answer. Checked before the
   * too-early guard, because a month with fewer than five days of data that has
   * nonetheless ended is complete, not premature.
   */
  if (remainingDows.length === 0) {
    return { ...base, verdict: "month_over" };
  }
  if (complete.length === 0) {
    return { ...base, verdict: "no_data" };
  }
  if (complete.length < MIN_COMPLETE_DAYS) {
    return { ...base, verdict: "too_early" };
  }

  const spendIdx = weekdayIndices(complete, (d) => d.spend);
  const leadIdx = weekdayIndices(complete, (d) => d.leads);

  const spend = projectOne(complete, remainingDows, (d) => d.spend, spendIdx);
  const leads = projectOne(complete, remainingDows, (d) => d.leads, leadIdx);

  const observedSpend = complete.reduce((a, d) => a + d.spend, 0);
  const observedLeads = complete.reduce((a, d) => a + d.leads, 0);

  const metrics: ForecastMetric[] = [
    {
      key: "spend",
      label: "Spend",
      observed: observedSpend,
      projected: spend.projected,
      low: Math.max(0, spend.projected - spend.halfWidth),
      high: spend.projected + spend.halfWidth,
      previous: opts.previous?.spend ?? null,
    },
    {
      key: "leads",
      label: "Leads",
      observed: observedLeads,
      projected: leads.projected,
      /*
       * The lower bound is floored at the count already banked, not at zero: a
       * month cannot end with fewer leads than it has. On a volatile client the
       * raw interval dips below what has already happened, which looks like an
       * arithmetic error because it is one.
       */
      low: Math.max(observedLeads, leads.projected - leads.halfWidth),
      high: leads.projected + leads.halfWidth,
      previous: opts.previous?.leads ?? null,
    },
  ];

  return {
    ...base,
    verdict: "ok",
    weekdayWeighted: spendIdx !== null || leadIdx !== null,
    metrics,
    projectedCpl: leads.projected > 0 ? spend.projected / leads.projected : null,
    observedCpl: observedLeads > 0 ? observedSpend / observedLeads : null,
  };
}
