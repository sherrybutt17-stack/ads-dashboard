import { describe, it, expect } from "vitest";
import { buildBudgetHistory, DELIVERY_TOLERANCE } from "./budget-history";

/** Aug back to May 2026, most recent first — as `trailingMonths` returns them. */
const MONTHS = [
  { monthKey: "2026-08", label: "Aug 2026" },
  { monthKey: "2026-07", label: "Jul 2026" },
  { monthKey: "2026-06", label: "Jun 2026" },
  { monthKey: "2026-05", label: "May 2026" },
];

const BUDGETS = [{ effectiveFrom: "2026-06", monthlyAmount: 4000 }];

function build(spend: Record<string, number>, current = "2026-08") {
  return buildBudgetHistory({
    months: MONTHS,
    spendByMonth: new Map(Object.entries(spend)),
    budgets: BUDGETS,
    currentMonth: current,
  });
}

describe("scoring a closed month", () => {
  it("calls a delivered month delivered", () => {
    const h = build({ "2026-07": 4000, "2026-06": 3900 });
    const jul = h.months.find((m) => m.monthKey === "2026-07")!;
    expect(jul.verdict).toBe("on_target");
    expect(jul.delivered).toBe(1);
    // Inside the band on the low side is still delivered.
    expect(h.months.find((m) => m.monthKey === "2026-06")!.verdict).toBe("on_target");
  });

  it("calls a shortfall and an overspend", () => {
    const h = build({ "2026-07": 2000, "2026-06": 6000 });
    expect(h.months.find((m) => m.monthKey === "2026-07")!.verdict).toBe("under");
    expect(h.months.find((m) => m.monthKey === "2026-06")!.verdict).toBe("over");
  });

  it("breaks the band at the stated tolerance", () => {
    const inside = build({ "2026-07": 4000 * (1 - DELIVERY_TOLERANCE) });
    const outside = build({ "2026-07": 4000 * (1 - DELIVERY_TOLERANCE) - 1 });
    expect(inside.months.find((m) => m.monthKey === "2026-07")!.verdict).toBe("on_target");
    expect(outside.months.find((m) => m.monthKey === "2026-07")!.verdict).toBe("under");
  });

  it("treats missing spend as zero, which is a real answer", () => {
    // No row for July means nothing was placed — not that we do not know.
    const h = build({});
    const jul = h.months.find((m) => m.monthKey === "2026-07")!;
    expect(jul.spend).toBe(0);
    expect(jul.verdict).toBe("under");
  });
});

describe("months that must not be scored", () => {
  it("🔴 does not score the month in progress as a shortfall", () => {
    /*
     * On the 8th, £900 of a £4,000 month is not a 78% miss — it is the 8th.
     * Scoring it would make the loudest red on the panel appear every month for
     * three weeks, and the colour would be ignored by the time it meant
     * something.
     */
    const h = build({ "2026-08": 900, "2026-07": 4000 });
    const aug = h.months.find((m) => m.monthKey === "2026-08")!;
    expect(aug.verdict).toBe("in_progress");

    /*
     * July and June are scored — both had a £4,000 agreement, and June placed
     * nothing. August is not, and the totals prove it: its £900 appears in
     * neither, and its £4,000 budget is not counted as committed.
     */
    expect(h.scored).toBe(2);
    expect(h.committed).toBe(8000);
    expect(h.placed).toBe(4000);
  });

  it("does not score a month before any agreement existed", () => {
    // Nothing was promised in May, so nothing was missed.
    const h = build({ "2026-05": 0 });
    const may = h.months.find((m) => m.monthKey === "2026-05")!;
    expect(may.verdict).toBe("no_budget");
    expect(may.budget).toBeNull();
    expect(may.delivered).toBeNull();
  });

  it("does not score a future month as a miss", () => {
    // A caller asking for a fixed window can hand us months that have not
    // happened. Unscoreable, exactly like the one in progress.
    const h = build({}, "2026-06");
    expect(h.months.find((m) => m.monthKey === "2026-08")!.verdict).toBe("in_progress");
    expect(h.months.find((m) => m.monthKey === "2026-07")!.verdict).toBe("in_progress");
  });

  it("applies the agreement in force for each month, not the newest", () => {
    // June's raise must not restate May, which had no agreement at all.
    const h = buildBudgetHistory({
      months: MONTHS,
      spendByMonth: new Map([["2026-05", 1800]]),
      budgets: [
        { effectiveFrom: "2026-06", monthlyAmount: 4000 },
        { effectiveFrom: "2026-07", monthlyAmount: 8000 },
      ],
      currentMonth: "2026-08",
    });
    expect(h.months.find((m) => m.monthKey === "2026-05")!.budget).toBeNull();
    expect(h.months.find((m) => m.monthKey === "2026-06")!.budget).toBe(4000);
    expect(h.months.find((m) => m.monthKey === "2026-07")!.budget).toBe(8000);
  });
});

describe("the record across months", () => {
  it("🔴 recomputes the overall figure from summed components", () => {
    /*
     * Not the mean of the monthly percentages: a £200 month would weigh as much
     * as a £20,000 one, and the headline would move on the smallest month.
     */
    const h = buildBudgetHistory({
      months: [
        { monthKey: "2026-07", label: "Jul 2026" },
        { monthKey: "2026-06", label: "Jun 2026" },
      ],
      spendByMonth: new Map([
        ["2026-07", 10_000],
        ["2026-06", 100],
      ]),
      budgets: [
        { effectiveFrom: "2026-06", monthlyAmount: 200 },
        { effectiveFrom: "2026-07", monthlyAmount: 10_000 },
      ],
      currentMonth: "2026-08",
    });
    // Summed: 10,100 placed of 10,200 committed ≈ 99%. The mean of the two
    // monthly rates (100% and 50%) would say 75%.
    expect(h.deliveredOverall).toBeCloseTo(10_100 / 10_200, 6);
  });

  it("counts the months that landed on target", () => {
    const h = build({ "2026-07": 4000, "2026-06": 1000 });
    expect(h.scored).toBe(2);
    expect(h.onTarget).toBe(1);
  });

  it("has no overall figure when nothing was ever committed", () => {
    const h = buildBudgetHistory({
      months: MONTHS,
      spendByMonth: new Map([["2026-07", 500]]),
      budgets: [],
      currentMonth: "2026-08",
    });
    expect(h.deliveredOverall).toBeNull();
    expect(h.scored).toBe(0);
  });

  it("treats a zero budget as an instruction, like pacing does", () => {
    const h = buildBudgetHistory({
      months: [{ monthKey: "2026-07", label: "Jul 2026" }],
      spendByMonth: new Map([["2026-07", 300]]),
      budgets: [{ effectiveFrom: "2026-07", monthlyAmount: 0 }],
      currentMonth: "2026-08",
    });
    // "Paused, spend nothing" — so spending is a breach, not a delivery.
    expect(h.months[0].verdict).toBe("over");
  });
});
