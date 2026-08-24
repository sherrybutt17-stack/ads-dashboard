import { budgetForMonth } from "./pacing";

/**
 * Did we actually place what the client agreed to pay for?
 *
 * Pacing answers it for the month in progress, while it can still be changed.
 * This answers it in arrears, across a year — and it is the record an agency
 * needs in front of them at a renewal, where "we delivered your budget every
 * month bar one" is a different conversation from a shrug.
 *
 * ── A client against their own history, and nothing else ──────────────
 *
 * Every comparison here is this client's spend against this client's own
 * agreement, month by month. There is no peer figure, no book median, no rank —
 * that is a product line this codebase does not cross.
 *
 * ── 🔴 The month in progress is not a miss ────────────────────────────
 *
 * On the 8th, a month with a £4,000 budget has £900 placed. Scored the same way
 * as a closed month that is a 78% shortfall, and it would be the loudest red on
 * the panel every month for three weeks — training the reader to ignore the
 * colour by the time it means something. The current month is carried as
 * `inProgress` and excluded from every total and every count.
 *
 * ── What "delivered" is, exactly ──────────────────────────────────────
 *
 * Spend ÷ budget, per month, recomputed from the components — never an average
 * of monthly percentages, which would let a £200 month weigh as much as a
 * £20,000 one. A month with no agreement on file is `null`, not 0%: nothing was
 * promised, so nothing was missed.
 */

/** Inside this band of the agreed budget, a month counts as delivered. */
export const DELIVERY_TOLERANCE = 0.1;

export type DeliveryVerdict =
  /** Within tolerance of the agreement. */
  | "on_target"
  | "under"
  | "over"
  /** No agreement on file for that month — nothing was promised. */
  | "no_budget"
  /** The month currently running: too early to score. */
  | "in_progress";

export interface DeliveryMonth {
  monthKey: string;
  label: string;
  budget: number | null;
  spend: number;
  /** Spend ÷ budget. Null when there was no budget to divide by. */
  delivered: number | null;
  verdict: DeliveryVerdict;
}

export interface BudgetHistory {
  months: DeliveryMonth[];
  /** Closed months that had an agreement — the denominator for the record. */
  scored: number;
  /** How many of those landed within tolerance. */
  onTarget: number;
  /** Committed and placed across the scored months only. */
  committed: number;
  placed: number;
  /** Placed ÷ committed across those months. Null when nothing was committed. */
  deliveredOverall: number | null;
}

export const EMPTY_BUDGET_HISTORY: BudgetHistory = {
  months: [],
  scored: 0,
  onTarget: 0,
  committed: 0,
  placed: 0,
  deliveredOverall: null,
};

export function buildBudgetHistory(opts: {
  /** Months to report, most recent first — as `trailingMonths` returns them. */
  months: ReadonlyArray<{ monthKey: string; label: string }>;
  /** Spend per month key. Absent means zero spend, which is a real answer. */
  spendByMonth: ReadonlyMap<string, number>;
  budgets: ReadonlyArray<{ effectiveFrom: string; monthlyAmount: number | null }>;
  /** The month currently running, in the client's timezone. */
  currentMonth: string;
}): BudgetHistory {
  const months: DeliveryMonth[] = opts.months.map((m) => {
    const budget = budgetForMonth(opts.budgets, m.monthKey);
    const spend = opts.spendByMonth.get(m.monthKey) ?? 0;

    /*
     * A month LATER than the current one can appear when the caller asks for a
     * fixed window; it is not in progress, it simply has not happened. Both are
     * unscoreable, and `in_progress` is the honest label for either — neither
     * is a miss.
     */
    const inProgress = m.monthKey >= opts.currentMonth;

    const delivered =
      budget === null || budget === 0 ? null : spend / budget;

    let verdict: DeliveryVerdict;
    if (inProgress) verdict = "in_progress";
    else if (budget === null) verdict = "no_budget";
    else if (delivered === null) {
      // A zero budget that was honoured is on target; any spend against it is not.
      verdict = spend > 0 ? "over" : "on_target";
    } else if (delivered > 1 + DELIVERY_TOLERANCE) verdict = "over";
    else if (delivered < 1 - DELIVERY_TOLERANCE) verdict = "under";
    else verdict = "on_target";

    return { monthKey: m.monthKey, label: m.label, budget, spend, delivered, verdict };
  });

  const scoredMonths = months.filter(
    (m) => m.verdict !== "in_progress" && m.verdict !== "no_budget",
  );

  const committed = scoredMonths.reduce((sum, m) => sum + (m.budget ?? 0), 0);
  const placed = scoredMonths.reduce((sum, m) => sum + m.spend, 0);

  return {
    months,
    scored: scoredMonths.length,
    onTarget: scoredMonths.filter((m) => m.verdict === "on_target").length,
    committed,
    placed,
    // Recomputed from the summed components, never the mean of the monthly
    // percentages — see the header.
    deliveredOverall: committed > 0 ? placed / committed : null,
  };
}
