import { describe, it, expect } from "vitest";
import { buildInsights } from "./insights";
import type { DashboardData } from "./dashboard";
import {
  EMPTY_ADS,
  EMPTY_FUNNEL,
  EMPTY_REVENUE,
  type AdTotals,
  type FunnelCounts,
  type RevenueTotals,
} from "./compute";
import type { PeriodMetrics } from "./queries";

/**
 * `buildInsights` shipped with a bug that made it print "Steady period" for
 * every client, forever — thresholds written as percentages compared against
 * ratios. It went unnoticed because this file did not exist.
 *
 * These tests pin both halves of the fix: percentages are compared and rendered
 * correctly, AND small samples are refused rather than promoted to headlines.
 */

function period(
  funnel: Partial<FunnelCounts>,
  ads: Partial<AdTotals>,
  revenue: Partial<RevenueTotals> | null = null,
): PeriodMetrics {
  return {
    label: "",
    window: {} as PeriodMetrics["window"],
    funnel: { ...EMPTY_FUNNEL, ...funnel },
    ads: { ...EMPTY_ADS, ...ads },
    revenue: revenue ? { ...EMPTY_REVENUE, ...revenue } : null,
    derived: {} as PeriodMetrics["derived"],
  };
}

/** Only the three fields `buildInsights` reads; the rest never loads. */
function data(
  current: PeriodMetrics,
  previous: PeriodMetrics,
  deltas: Record<string, number | null>,
): DashboardData {
  return { current, previous, deltas } as unknown as DashboardData;
}

/** A comfortably-above-the-floor pair: 40 → 52 leads on real spend. */
const bigCurrent = period(
  { new_lead: 52, appointment_booked: 20, showed: 12, closed_won: 6 },
  { spend: 3000 },
);
const bigPrevious = period(
  { new_lead: 40, appointment_booked: 15, showed: 10, closed_won: 5 },
  { spend: 2800 },
);

describe("buildInsights — the ratio-vs-percentage fix", () => {
  it("reports a real 30% move instead of falling through to 'Steady period'", () => {
    const out = buildInsights(
      data(bigCurrent, bigPrevious, { new_lead: 0.3, cpLead: null, spend: 0.07 }),
    );
    expect(out[0].text).toContain("Leads up 30%");
    expect(out[0].text).not.toContain("Steady");
  });

  it("renders the percentage from the ratio, not the raw ratio", () => {
    // The old pct() rounded 0.12 to "0%".
    const out = buildInsights(
      data(bigCurrent, bigPrevious, { new_lead: 0.12, spend: null, cpLead: null }),
    );
    expect(out[0].text).toContain("12%");
    expect(out[0].text).not.toContain("0%");
  });

  it("still says nothing when a well-sampled period genuinely didn't move", () => {
    const out = buildInsights(
      data(bigCurrent, bigPrevious, { new_lead: 0.01, spend: 0.02, cpLead: -0.01 }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].text).toContain("Steady period");
  });

  it("combines leads-up-cost-down into one narrative", () => {
    const out = buildInsights(
      data(bigCurrent, bigPrevious, { new_lead: 0.3, cpLead: -0.22, spend: 0.02 }),
    );
    expect(out[0].tone).toBe("good");
    expect(out[0].text).toContain("More leads at a lower cost");
    expect(out[0].text).toContain("30%");
    expect(out[0].text).toContain("22%");
  });

  it("flags spend rising while leads stay flat", () => {
    const out = buildInsights(
      data(bigCurrent, bigPrevious, { spend: 0.35, new_lead: 0.01, cpLead: null }),
    );
    expect(out[0].tone).toBe("bad");
    expect(out[0].text).toContain("Ad spend rose 35%");
  });

  it("honours metric polarity — a falling cost per lead is good news", () => {
    const out = buildInsights(
      data(bigCurrent, bigPrevious, { cpLead: -0.25, new_lead: 0.01, spend: 0.01 }),
    );
    expect(out[0].text).toContain("Cost per lead down 25%");
    expect(out[0].tone).toBe("good");
  });
});

describe("buildInsights — the volume gate", () => {
  /**
   * The load-bearing test. Fixing the comparison without this would have made
   * the feature worse: a client going from 3 leads to 5 would get "Leads up 67%"
   * as a headline every week, on noise.
   */
  it("refuses to headline 3 leads → 5 leads as a 67% rise", () => {
    const out = buildInsights(
      data(
        period({ new_lead: 5 }, { spend: 120 }),
        period({ new_lead: 3 }, { spend: 100 }),
        { new_lead: 0.667, spend: 0.2, cpLead: -0.28 },
      ),
    );
    expect(out).toHaveLength(1);
    expect(out[0].text).not.toContain("67%");
    expect(out[0].text).toContain("Too little activity");
  });

  it("names thin volume rather than claiming the period was steady", () => {
    const out = buildInsights(
      data(
        period({ new_lead: 2 }, { spend: 90 }),
        period({ new_lead: 1 }, { spend: 80 }),
        { new_lead: 1.0, spend: 0.12, cpLead: null },
      ),
    );
    expect(out[0].text).toContain("Too little activity");
    expect(out[0].text).toContain("2 leads vs 1 previously");
    expect(out[0].text).not.toContain("Steady period");
  });

  it("gates on the SMALLER period, so a spike off a tiny base is ignored", () => {
    // 2 → 40 is +1900%, but the previous period cannot support the comparison.
    const out = buildInsights(
      data(
        period({ new_lead: 40 }, { spend: 2000 }),
        period({ new_lead: 2 }, { spend: 1800 }),
        { new_lead: 19, spend: 0.11, cpLead: null },
      ),
    );
    expect(out[0].text).not.toContain("Leads up");
  });

  it("suppresses cost-per-lead commentary when spend is trivial", () => {
    // Leads clear their floor; spend does not, so CPL stays out of the prose.
    const out = buildInsights(
      data(
        period({ new_lead: 30 }, { spend: 60 }),
        period({ new_lead: 28 }, { spend: 55 }),
        { cpLead: -0.4, new_lead: 0.07, spend: 0.09 },
      ),
    );
    expect(out.some((i) => i.text.includes("Cost per lead"))).toBe(false);
  });

  it("only quotes revenue when both periods recorded deal values", () => {
    // Live case: deals close but nobody sets a value, so a revenue move would
    // describe data entry rather than performance.
    const noValues = buildInsights(
      data(
        period({ new_lead: 52, closed_won: 6 }, { spend: 3000 }, { wonOpps: 6, wonWithValue: 0 }),
        period({ new_lead: 40, closed_won: 5 }, { spend: 2800 }, { wonOpps: 5, wonWithValue: 0 }),
        { revenue: 0.9, new_lead: 0.01, spend: 0.01, cpLead: null },
      ),
    );
    expect(noValues.some((i) => i.text.includes("Revenue"))).toBe(false);

    const withValues = buildInsights(
      data(
        period({ new_lead: 52, closed_won: 6 }, { spend: 3000 }, { wonOpps: 6, wonWithValue: 6, revenue: 9000 }),
        period({ new_lead: 40, closed_won: 5 }, { spend: 2800 }, { wonOpps: 5, wonWithValue: 5, revenue: 4500 }),
        { revenue: 0.9, new_lead: 0.01, spend: 0.01, cpLead: null },
      ),
    );
    expect(withValues[0].text).toContain("Revenue up 90%");
  });

  it("returns at most two insights", () => {
    const out = buildInsights(
      data(bigCurrent, bigPrevious, {
        new_lead: 0.4,
        spend: 0.5,
        cpLead: 0.3,
        appointment_booked: 0.6,
        showed: 0.7,
        closed_won: 0.8,
      }),
    );
    expect(out.length).toBeLessThanOrEqual(2);
  });
});
