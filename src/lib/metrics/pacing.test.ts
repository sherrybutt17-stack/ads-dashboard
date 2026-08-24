import { describe, it, expect } from "vitest";
import {
  computePacing,
  budgetForMonth,
  PACE_TOLERANCE,
  MIN_DAYS_FOR_VERDICT,
  type PacingInput,
} from "./pacing";

/**
 * The fixture is a £3,000 month over 30 days — £100/day exactly on target — so
 * every assertion below can be read as money rather than as arithmetic.
 */
const base: PacingInput = {
  budget: 3000,
  spendToDate: 0,
  spendThroughYesterday: 0,
  daysInMonth: 30,
  dayOfMonth: 1,
};

/** On the morning of day `n`, having spent `perDay` on each complete day. */
function onDay(n: number, perDay: number, todaySoFar = 0): PacingInput {
  const complete = (n - 1) * perDay;
  return {
    ...base,
    dayOfMonth: n,
    spendThroughYesterday: complete,
    spendToDate: complete + todaySoFar,
  };
}

describe("the partial-day trap", () => {
  it("🔴 does not read a morning as an underspend", () => {
    /*
     * The bug this module is written against. Nine complete days at £100 and
     * £8 spent so far today is a client exactly on target; dividing £908 by 10
     * would project £2,724 and fire a 9% underspend alarm every morning.
     */
    const p = computePacing(onDay(10, 100, 8));
    expect(p.status).toBe("on_pace");
    expect(p.projectedSpend).toBe(3000);
    // The headline total still counts today — the two numbers answer different
    // questions and both are shown.
    expect(p.spendToDate).toBe(908);
    expect(p.completeDays).toBe(9);
  });

  it("🔴 projects nothing on day 1 rather than projecting zero", () => {
    // Zero would render as "on track to spend nothing" for every client at
    // once, on the first of every month.
    const p = computePacing({ ...base, dayOfMonth: 1, spendToDate: 40 });
    expect(p.projectedSpend).toBeNull();
    expect(p.paceRatio).toBeNull();
    expect(p.status).toBe("too_early");
  });

  it("holds its verdict until there is enough month to judge", () => {
    // Two complete days at half rate is a slow launch, not a trend.
    const p = computePacing(onDay(MIN_DAYS_FOR_VERDICT, 50));
    expect(p.completeDays).toBe(MIN_DAYS_FOR_VERDICT - 1);
    expect(p.status).toBe("too_early");
    // The projection is still offered — it is the verdict that waits.
    expect(p.projectedSpend).toBeCloseTo(1500, 6);
  });

  it("judges as soon as there is", () => {
    const p = computePacing(onDay(MIN_DAYS_FOR_VERDICT + 1, 50));
    expect(p.completeDays).toBe(MIN_DAYS_FOR_VERDICT);
    expect(p.status).toBe("under");
  });
});

describe("where the projection comes from", () => {
  it("🔴 prefers the weekday-weighted forecast over its own run rate", () => {
    /*
     * `forecast.ts` weights by weekday; this module's fallback does not, and its
     * own header calls the flat form wrong. More importantly the two panels sit
     * on one screen: a dashboard printing two different month-end figures a few
     * hundred pixels apart has refuted itself.
     */
    const p = computePacing({ ...onDay(15, 100), forecastSpend: 2650 });
    expect(p.projectedSpend).toBe(2650);
    expect(p.projectionSource).toBe("forecast");
    // And the variance follows the figure actually shown, not the discarded one.
    expect(p.projectedVariance).toBe(-350);
    expect(p.status).toBe("on_pace"); // the verdict still reads complete days
  });

  it("falls back to the run rate when the forecast declines", () => {
    // `too_early` / `no_data` arrive here as null rather than as a guess.
    const p = computePacing({ ...onDay(15, 100), forecastSpend: null });
    expect(p.projectedSpend).toBe(3000);
    expect(p.projectionSource).toBe("run_rate");
  });

  it("ignores a non-finite forecast rather than propagating it", () => {
    for (const bad of [NaN, Infinity]) {
      const p = computePacing({ ...onDay(15, 100), forecastSpend: bad });
      expect(p.projectedSpend).toBe(3000);
      expect(p.projectionSource).toBe("run_rate");
    }
  });

  it("names no source when there is no projection at all", () => {
    const p = computePacing({ ...base, dayOfMonth: 1 });
    expect(p.projectedSpend).toBeNull();
    expect(p.projectionSource).toBeNull();
  });

  it("uses the forecast even with no budget on record", () => {
    const p = computePacing({ ...onDay(15, 100), budget: null, forecastSpend: 2650 });
    expect(p.status).toBe("no_budget");
    expect(p.projectedSpend).toBe(2650);
    expect(p.projectionSource).toBe("forecast");
  });
});

describe("verdicts", () => {
  it("calls a genuine underspend", () => {
    const p = computePacing(onDay(15, 60));
    expect(p.status).toBe("under");
    expect(p.projectedSpend).toBe(1800);
    expect(p.projectedVariance).toBe(-1200);
    expect(p.paceRatio).toBeCloseTo(0.6, 6);
  });

  it("calls a genuine overspend", () => {
    const p = computePacing(onDay(15, 140));
    expect(p.status).toBe("over");
    expect(p.projectedSpend).toBe(4200);
    expect(p.projectedVariance).toBe(1200);
  });

  it("tolerates ordinary delivery lumpiness", () => {
    // Inside the band on both sides: this is a platform pacing itself, not a
    // problem, and reporting it as one is how a dashboard trains people to
    // ignore it.
    const justUnder = computePacing(onDay(15, 100 * (1 - PACE_TOLERANCE + 0.01)));
    const justOver = computePacing(onDay(15, 100 * (1 + PACE_TOLERANCE - 0.01)));
    expect(justUnder.status).toBe("on_pace");
    expect(justOver.status).toBe("on_pace");
  });

  it("breaks the band at the stated threshold, not near it", () => {
    const inside = computePacing(onDay(15, 100 * (1 + PACE_TOLERANCE)));
    const outside = computePacing(onDay(15, 100 * (1 + PACE_TOLERANCE) + 1));
    expect(inside.status).toBe("on_pace");
    expect(outside.status).toBe("over");
  });
});

describe("the instruction", () => {
  it("says what to spend per remaining day to land on budget", () => {
    // Half the month gone, £600 behind: 15 days left, £1,600 to place.
    const p = computePacing(onDay(16, 60));
    expect(p.daysRemaining).toBe(15);
    expect(p.remainingBudget).toBe(3000 - 900);
    expect(p.dailyTargetRemaining).toBeCloseTo(2100 / 15, 6);
  });

  it("never asks for a negative daily spend", () => {
    // Budget blown by day 20. "Spend -£40/day" is not an instruction; the
    // remaining budget floors at zero and the answer is "spend nothing".
    const p = computePacing(onDay(21, 200));
    expect(p.remainingBudget).toBe(0);
    expect(p.dailyTargetRemaining).toBe(0);
    expect(p.status).toBe("over");
  });

  it("offers no daily target once the month has closed", () => {
    // dayOfMonth = daysInMonth + 1: every day complete, none remaining.
    const p = computePacing({
      ...base,
      dayOfMonth: 31,
      spendThroughYesterday: 2900,
      spendToDate: 2900,
    });
    expect(p.daysRemaining).toBe(0);
    expect(p.completeDays).toBe(30);
    expect(p.dailyTargetRemaining).toBeNull();
    expect(p.projectedSpend).toBe(2900);
  });
});

describe("budgets that are absent, zero, or nonsense", () => {
  it("🔴 says no budget rather than on pace", () => {
    /*
     * "On pace" against nothing is a green tick over an unanswered question —
     * the failure mode the whole dashboard exists to remove.
     */
    const p = computePacing({ ...onDay(15, 100), budget: null });
    expect(p.status).toBe("no_budget");
    expect(p.paceRatio).toBeNull();
    expect(p.projectedVariance).toBeNull();
    expect(p.dailyTargetRemaining).toBeNull();
    // Still projects, so the empty state can say what the month is heading for.
    expect(p.projectedSpend).toBe(3000);
  });

  it("🔴 treats a zero budget as an instruction, not as absence", () => {
    // "Paused, spend nothing" — so any spend is an overspend, and the ratio
    // being undefined must not fall through to on-pace.
    const spending = computePacing({ ...onDay(15, 20), budget: 0 });
    expect(spending.status).toBe("over");

    const obedient = computePacing({ ...onDay(15, 0), budget: 0 });
    expect(obedient.status).toBe("on_pace");
  });

  it("refuses a negative or non-finite budget", () => {
    for (const bad of [-100, NaN, Infinity]) {
      expect(computePacing({ ...onDay(15, 100), budget: bad }).status).toBe("no_budget");
    }
  });

  it("cannot be pushed into a negative projection by a bad day number", () => {
    /*
     * A day-of-month out of range would make `completeDays` negative and flip
     * the sign of the run rate — an overspending client reported as
     * underspending, which is a wrong answer in the confident direction.
     */
    const p = computePacing({ ...base, dayOfMonth: 0, spendToDate: 100 });
    expect(p.completeDays).toBe(0);
    expect(p.daysRemaining).toBe(30);
    expect(p.projectedSpend).toBeNull();
  });
});

describe("which budget applies to a month", () => {
  const rows = [
    { effectiveFrom: "2026-03", monthlyAmount: 2000 },
    { effectiveFrom: "2026-06", monthlyAmount: 4000 },
  ];

  it("🔴 does not restate history with today's figure", () => {
    /*
     * The reason budgets are stored with an effective month at all. A raise
     * agreed in June must not turn March — which hit £2,000 exactly — into a
     * month that missed a £4,000 target by half.
     */
    expect(budgetForMonth(rows, "2026-03")).toBe(2000);
    expect(budgetForMonth(rows, "2026-05")).toBe(2000);
    expect(budgetForMonth(rows, "2026-06")).toBe(4000);
    expect(budgetForMonth(rows, "2026-11")).toBe(4000);
  });

  it("has no budget before the first agreement", () => {
    // Distinct from a budget of zero: nothing was agreed yet.
    expect(budgetForMonth(rows, "2026-02")).toBeNull();
  });

  it("takes the latest applicable row regardless of input order", () => {
    const shuffled = [rows[1], rows[0]];
    expect(budgetForMonth(shuffled, "2026-07")).toBe(4000);
  });

  it("carries an explicit null forward as 'no budget from here'", () => {
    // A client who stops committing to a monthly figure, recorded without
    // deleting what they used to commit to.
    const stopped = [...rows, { effectiveFrom: "2026-09", monthlyAmount: null }];
    expect(budgetForMonth(stopped, "2026-08")).toBe(4000);
    expect(budgetForMonth(stopped, "2026-09")).toBeNull();
  });

  it("has no budget when nothing is on file", () => {
    expect(budgetForMonth([], "2026-06")).toBeNull();
  });
});
