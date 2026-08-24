/**
 * Budget pacing — "is this client's spend on track for the month?"
 *
 * Every other engine here reports what HAPPENED. This one reports what is going
 * to happen if nothing changes, which is the only form of the question an
 * agency can still act on: a month that closes 30% underspent cannot be fixed
 * in arrears, and the client's money simply did not buy anything.
 *
 * ---
 *
 * 🔴 THE MISTAKE THAT MAKES A PACING WIDGET WORSE THAN NONE
 *
 * **Today's spend is a partial figure**, and the run-rate must not see it.
 *
 * A month-to-date total naturally includes today, and today is a few hours old.
 * Divide that total by the day number and the average is dragged down by a day
 * that has not finished happening. At 9am on the 10th, nine full days at £100
 * plus £8 so far reads as £908 over 10 days = £90.80/day, and projects £2,724
 * against a £3,000 budget: a 9% underspend alarm on a campaign that is exactly
 * on target. The widget would fire every morning and be right by evening, which
 * is precisely how people learn to ignore a dashboard.
 *
 * So the projection divides COMPLETE days only, while the headline "spent so
 * far" still includes today — the two numbers answer different questions and
 * this module keeps them apart deliberately. `spendThroughYesterday` is a
 * separate input rather than something derived here, because only the caller
 * knows the client's timezone and which rows are complete.
 *
 * A corollary worth stating: on day 1 there are no complete days, so there is
 * no projection at all. `null`, never zero — zero would render as "projected to
 * spend nothing" on the first of the month, for every client at once.
 *
 * ---
 *
 * WHAT COUNTS AS OFF-PACE
 *
 * Two guards, both there to stop this crying wolf:
 *
 * 1. **A ±10% band.** Delivery is lumpy — auctions, weekends, a disapproved ad
 *    reinstated at noon — and a platform pacing its own budget will drift
 *    within a few percent all month. Anything inside the band is on pace.
 * 2. **A minimum of complete days before judging.** Three days of spend is not
 *    a trend; a single slow launch day would otherwise put a client on a red
 *    "40% underspent" the moment the month turns.
 *
 * Both are exported so the UI can explain them rather than assert them.
 *
 * ---
 *
 * Pure, no I/O, no clock: every temporal fact arrives as an input, so the whole
 * thing is testable and cannot disagree with the timezone the rest of the
 * dashboard is computed in.
 */

/** Inside this band of the linear target, spend is "on pace". */
export const PACE_TOLERANCE = 0.1;

/** Complete days required before a verdict is offered at all. */
export const MIN_DAYS_FOR_VERDICT = 3;

export type PaceStatus =
  /** No budget on record — the honest answer, not "on pace". */
  | "no_budget"
  /** Too early in the month to say anything that would not be noise. */
  | "too_early"
  | "under"
  | "on_pace"
  | "over";

export interface PacingInput {
  /** Monthly budget in the ad account's currency; null when none is set. */
  budget: number | null;
  /**
   * Month-end spend as projected by `forecast.ts`, when it is willing to say.
   *
   * 🔴 Supplied rather than computed here, and preferred over this module's own
   * arithmetic whenever it is present. `forecast.ts` weights by weekday, and
   * its header explains why the flat `spend ÷ elapsed × days` this module falls
   * back to is wrong: a month beginning on a Friday has three weekend days in
   * its first nine, so on the 9th a flat pace projects the whole month at a
   * weekend-heavy rate.
   *
   * The deeper reason is coherence. "Where this month lands" and the pacing
   * meter are two panels on one screen answering one question, and a dashboard
   * that prints two different month-end figures a few hundred pixels apart has
   * refuted itself — the reader now has to decide which of its own numbers to
   * believe, which is worse than either number alone.
   *
   * Null when the forecast declines (too early, no data), and the run-rate
   * fallback then applies — labelled as such in `projectionSource`, so the UI
   * can say which kind of projection it is showing.
   */
  forecastSpend?: number | null;
  /** Month-to-date spend INCLUDING today's partial figure. */
  spendToDate: number;
  /** Spend across COMPLETE days only — excludes today. See the note above. */
  spendThroughYesterday: number;
  /** Calendar length of the month, in the client's timezone. */
  daysInMonth: number;
  /**
   * Today's day-of-month, 1-based, in the client's timezone. For a month that
   * has already closed, pass `daysInMonth + 1` — every day is complete.
   */
  dayOfMonth: number;
}

export interface Pacing {
  status: PaceStatus;
  budget: number | null;
  spendToDate: number;
  /**
   * Echoed back so the UI can draw the two apart.
   *
   * The meter renders complete days as one segment and today's partial figure
   * as a second, lighter one, for the same reason the run rate excludes it: a
   * single bar reaching past the pace marker every afternoon would read as an
   * overspend that reverses itself overnight.
   */
  spendThroughYesterday: number;
  /** Complete days elapsed — the denominator behind every projection here. */
  completeDays: number;
  daysInMonth: number;
  /** Days still to spend in, today included. 0 once the month has closed. */
  daysRemaining: number;
  /** Where a perfectly even spend would stand after `completeDays`. */
  expectedToDate: number | null;
  /** Complete-day spend ÷ expected. 1 is exactly on target. */
  paceRatio: number | null;
  /** Month-end total: the weekday-weighted forecast, or a flat run rate. */
  projectedSpend: number | null;
  /** Which of the two produced `projectedSpend`, so the UI can name it. */
  projectionSource: "forecast" | "run_rate" | null;
  /** Projected minus budget: positive is an overspend. */
  projectedVariance: number | null;
  /** Budget left, floored at 0 — an exhausted budget is not a negative one. */
  remainingBudget: number | null;
  /**
   * What to spend per remaining day to land exactly on budget. The one number
   * here that is an instruction rather than an observation.
   */
  dailyTargetRemaining: number | null;
}

/**
 * `null` for any ratio whose denominator is 0, matching the house rule that an
 * undefined metric renders as `-` rather than as a confident zero.
 */
function ratio(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return null;
  if (denominator === 0) return null;
  return numerator / denominator;
}

export function computePacing(input: PacingInput): Pacing {
  const { spendToDate, spendThroughYesterday, daysInMonth } = input;

  /*
   * Clamp before anything is divided by it. `dayOfMonth` comes from a date
   * formatted in the client's timezone and should always be in range, but a
   * silently negative `completeDays` would flip the sign of every projection
   * below and report an overspending client as underspending — a wrong answer
   * in the confident direction, which is the only kind that does damage.
   */
  const dayOfMonth = Math.min(Math.max(input.dayOfMonth, 1), daysInMonth + 1);
  const completeDays = Math.min(dayOfMonth - 1, daysInMonth);
  const daysRemaining = Math.max(daysInMonth - completeDays, 0);

  /*
   * A budget of 0 is a real instruction — "this client is paused, spend
   * nothing" — and must not be conflated with having no budget on record. It
   * survives as a number here so the checks below can call any spend against it
   * an overspend, which it is.
   */
  const budget =
    input.budget !== null && Number.isFinite(input.budget) && input.budget >= 0
      ? input.budget
      : null;

  const dailyRunRate = ratio(spendThroughYesterday, completeDays);
  const runRateProjection =
    dailyRunRate === null ? null : dailyRunRate * daysInMonth;

  const forecast =
    input.forecastSpend !== null &&
    input.forecastSpend !== undefined &&
    Number.isFinite(input.forecastSpend)
      ? input.forecastSpend
      : null;

  const projectedSpend = forecast ?? runRateProjection;
  const projectionSource: "forecast" | "run_rate" | null =
    forecast !== null ? "forecast" : runRateProjection === null ? null : "run_rate";

  if (budget === null) {
    return {
      status: "no_budget",
      budget: null,
      spendToDate,
      spendThroughYesterday,
      completeDays,
      daysInMonth,
      daysRemaining,
      expectedToDate: null,
      paceRatio: null,
      // Still projected: "you are on track to spend £4,100" is useful even with
      // nothing to compare it against, and it is what makes the empty state an
      // invitation to set a budget rather than a dead panel.
      projectedSpend,
      projectionSource,
      projectedVariance: null,
      remainingBudget: null,
      dailyTargetRemaining: null,
    };
  }

  const expectedToDate = (budget * completeDays) / daysInMonth;
  const remainingBudget = Math.max(budget - spendToDate, 0);

  const common = {
    budget,
    spendToDate,
    spendThroughYesterday,
    completeDays,
    daysInMonth,
    daysRemaining,
    expectedToDate,
    paceRatio: ratio(spendThroughYesterday, expectedToDate),
    projectedSpend,
    projectionSource,
    projectedVariance: projectedSpend === null ? null : projectedSpend - budget,
    remainingBudget,
    dailyTargetRemaining: ratio(remainingBudget, daysRemaining),
  };

  if (completeDays < MIN_DAYS_FOR_VERDICT) {
    return { ...common, status: "too_early" };
  }

  /*
   * The zero-budget case, kept ahead of the ratio test because `paceRatio` is
   * null when `expectedToDate` is 0 and a null ratio would otherwise fall
   * through to "on pace" — reporting a paused client's live spend as on target.
   */
  if (budget === 0) {
    return { ...common, status: spendToDate > 0 ? "over" : "on_pace" };
  }

  const { paceRatio } = common;
  if (paceRatio === null) return { ...common, status: "too_early" };
  if (paceRatio > 1 + PACE_TOLERANCE) return { ...common, status: "over" };
  if (paceRatio < 1 - PACE_TOLERANCE) return { ...common, status: "under" };
  return { ...common, status: "on_pace" };
}

/**
 * Which budget applies to a given month.
 *
 * Rows are "from this month onward, until superseded", so the answer is the
 * latest row at or before the month asked about — NOT the newest row overall.
 * That distinction is the whole point: it is what stops a raise agreed in June
 * from silently restating March, turning a month that hit its target into one
 * that missed by half.
 *
 * A month earlier than every row on file has no budget, which is correct and
 * different from having a budget of zero: nothing was agreed yet.
 */
export function budgetForMonth(
  rows: ReadonlyArray<{ effectiveFrom: string; monthlyAmount: number | null }>,
  month: string,
): number | null {
  let best: { effectiveFrom: string; monthlyAmount: number | null } | null = null;
  for (const row of rows) {
    // String comparison is safe and intended: `yyyy-MM` sorts chronologically.
    if (row.effectiveFrom > month) continue;
    if (!best || row.effectiveFrom > best.effectiveFrom) best = row;
  }
  return best?.monthlyAmount ?? null;
}
