import { describe, it, expect } from "vitest";
import {
  div,
  derive,
  pctChange,
  sumAds,
  sumFunnels,
  changeSentiment,
  SENTIMENT_DEAD_BAND,
  buildFunnelSteps,
  formatCurrency,
  formatPercent,
  formatChange,
  formatNumber,
  EMPTY_FUNNEL,
  EMPTY_ADS,
  EMPTY_REVENUE,
  roasFrom,
  sumRevenue,
  DASH,
  type FunnelCounts,
  type AdTotals,
  type RevenueTotals,
} from "./compute";
import { FUNNEL_PATH } from "@/db/schema";

const funnel = (over: Partial<FunnelCounts> = {}): FunnelCounts => ({
  ...EMPTY_FUNNEL,
  ...over,
});
const ads = (over: Partial<AdTotals> = {}): AdTotals => ({
  ...EMPTY_ADS,
  ...over,
});
const rev = (over: Partial<RevenueTotals> = {}): RevenueTotals => ({
  ...EMPTY_REVENUE,
  ...over,
});

describe("div — the divide-by-zero guard", () => {
  it("divides normally", () => {
    expect(div(10, 4)).toBe(2.5);
  });

  // The whole point: a zero denominator must never render as 0 or Infinity.
  it("returns null on a zero denominator, not Infinity", () => {
    expect(div(10, 0)).toBeNull();
  });

  it("returns null for 0/0 rather than NaN", () => {
    expect(div(0, 0)).toBeNull();
  });

  it("returns null for non-finite inputs", () => {
    expect(div(Infinity, 2)).toBeNull();
    expect(div(NaN, 2)).toBeNull();
    expect(div(2, NaN)).toBeNull();
  });
});

describe("derive", () => {
  it("computes cost-per-stage from the CRM funnel", () => {
    const d = derive(
      funnel({ new_lead: 100, appointment_booked: 20, showed: 10, closed_won: 5 }),
      ads({ spend: 1000 }),
    );
    expect(d.cpLead).toBe(10);
    expect(d.cpAppt).toBe(50);
    expect(d.cpShow).toBe(100);
    expect(d.cpWon).toBe(200);
  });

  it("computes stage-to-stage conversion", () => {
    const d = derive(
      funnel({ new_lead: 100, appointment_booked: 25, showed: 20, closed_won: 5 }),
      ads(),
    );
    expect(d.bookPct).toBe(0.25);
    expect(d.showPct).toBe(0.8);
    expect(d.closePct).toBe(0.25);
  });

  it("computes traffic economics from summed components", () => {
    const d = derive(funnel(), ads({ spend: 100, impressions: 10_000, linkClicks: 200 }));
    expect(d.ctr).toBe(0.02);
    expect(d.cpm).toBe(10);
    expect(d.cpc).toBe(0.5);
  });

  // A paused account: spend and traffic are zero but the row must still render.
  it("returns all-null derived metrics for a fully zero period", () => {
    const d = derive(funnel(), ads());
    for (const v of Object.values(d)) expect(v).toBeNull();
  });

  // The exact corruption in the source sheet: wins recorded against zero shows.
  it("returns null close rate when shows are zero despite wins existing", () => {
    const d = derive(funnel({ closed_won: 3, showed: 0 }), ads({ spend: 500 }));
    expect(d.closePct).toBeNull();
    expect(d.cpShow).toBeNull();
    expect(d.cpWon).toBeCloseTo(166.67, 2);
  });
});

describe("regression — real figures from the source spreadsheet", () => {
  // Dec 2025 row of the Parfaire CSV: $364.45 spend, 65 leads, 2 appts, 2 won.
  it("reproduces Dec 2025 cost-per-lead", () => {
    const d = derive(
      funnel({ new_lead: 65, appointment_booked: 2, closed_won: 2 }),
      ads({ spend: 364.45, impressions: 12_008, linkClicks: 388 }),
    );
    expect(d.cpLead).toBeCloseTo(5.61, 2); // sheet: $5.61
    expect(d.cpAppt).toBeCloseTo(182.23, 2); // sheet: $182.23
    expect(d.cpWon).toBeCloseTo(182.23, 2); // sheet: $182.23
    expect(d.bookPct).toBeCloseTo(0.0308, 4); // sheet: 3.08%
  });

  it("reproduces Dec 2025 traffic economics", () => {
    const d = derive(funnel(), ads({ spend: 364.45, impressions: 12_008, linkClicks: 388 }));
    expect(d.cpm).toBeCloseTo(30.35, 1); // sheet: $30.35
    expect(d.cpc).toBeCloseTo(0.94, 2); // sheet: $0.94
    expect(d.ctr).toBeCloseTo(0.0323, 3); // sheet: 3.23%
  });

  /*
   * The finding that mattered most in the CSV: CTR held up but click-to-lead
   * collapsed from ~17% to ~3% after the Jan–Feb pause. Asserting both ends so
   * a future refactor of optinPct cannot silently erase the signal.
   */
  it("exposes the click-to-lead collapse between Dec 2025 and Mar 2026", () => {
    const dec = derive(funnel({ new_lead: 65 }), ads({ spend: 364.45, linkClicks: 388 }));
    const mar = derive(funnel({ new_lead: 3 }), ads({ spend: 199.17, linkClicks: 106 }));
    expect(dec.optinPct).toBeCloseTo(0.168, 2);
    expect(mar.optinPct).toBeCloseTo(0.028, 2);
    expect(dec.optinPct! / mar.optinPct!).toBeGreaterThan(5);
  });

  /*
   * May–Jun 2026: 25 leads recorded against $0.00 spend, which the sheet
   * rendered as "$0.00" cost-per-lead — reading as 22 free leads. It must show
   * a dash instead: the spend feed is either broken or these were not paid.
   */
  it("returns a null cost-per-lead when leads arrive with zero spend", () => {
    const d = derive(funnel({ new_lead: 22 }), ads({ spend: 0 }));
    expect(d.cpLead).toBeNull();
    expect(formatCurrency(d.cpLead)).toBe(DASH);
  });

  it("still returns null cost-per for a genuinely empty period", () => {
    const d = derive(funnel(), ads());
    expect(d.cpLead).toBeNull();
    expect(d.cpWon).toBeNull();
  });

  it("returns null cost-per when spend exists but nothing converted", () => {
    const d = derive(funnel({ new_lead: 0 }), ads({ spend: 500 }));
    expect(d.cpLead).toBeNull();
  });

  it("computes a real cost-per when both sides are non-zero", () => {
    const d = derive(funnel({ new_lead: 10 }), ads({ spend: 250 }));
    expect(d.cpLead).toBe(25);
  });
});

describe("revenue and ROAS", () => {
  it("computes ROAS from recorded revenue", () => {
    const d = derive(
      funnel({ closed_won: 4 }),
      ads({ spend: 1000 }),
      rev({ wonOpps: 4, wonWithValue: 4, revenue: 4000 }),
    );
    expect(d.roas).toBe(4);
    expect(d.avgDeal).toBe(1000);
  });

  /**
   * The live failure this guard exists for.
   *
   * Verified against production 2026-08-12: 64 closed-won opportunities, 43 with
   * a deal value, and NONE created since March carries one. Without this rule a
   * recent period reports "0.0x ROAS" — which reads as "the ads made no money"
   * when the truth is that nobody filled the value field in GHL. That blames the
   * ads for an operations gap, and it is the same class of quiet wrongness as
   * the source sheet's $0.00 cost-per-lead.
   */
  it("returns null ROAS when deals closed but no value was recorded", () => {
    const d = derive(
      funnel({ closed_won: 6 }),
      ads({ spend: 900 }),
      rev({ wonOpps: 6, wonWithValue: 0, revenue: 0 }),
    );
    expect(d.roas).toBeNull();
    expect(formatCurrency(d.roas)).toBe(DASH);
  });

  /**
   * Deliberately 0, not a dash — and the distinction from the test above is the
   * whole point. "Six deals closed and nobody recorded what they were worth" is
   * unknown. "Nothing closed" is known, and the return really is zero. Dashes
   * are reserved for absent knowledge; a real zero must be allowed to read as a
   * real zero or the dash stops meaning anything.
   */
  it("reports a genuine zero ROAS when spend produced no closed deals", () => {
    const d = derive(funnel(), ads({ spend: 900 }), rev());
    expect(d.roas).toBe(0);
    expect(d.avgDeal).toBeNull(); // no valued deals to average
  });

  it("returns null ROAS when revenue exists but spend is zero", () => {
    // Same refusal as costPer: revenue against no spend is unattributable,
    // not an infinite return.
    const d = derive(
      funnel({ closed_won: 1 }),
      ads({ spend: 0 }),
      rev({ wonOpps: 1, wonWithValue: 1, revenue: 500 }),
    );
    expect(d.roas).toBeNull();
  });

  it("averages deal size over deals that carry a value, not all deals", () => {
    // 4 closed, only 2 valued at $3,000 total → $1,500 each, not $750.
    const d = derive(
      funnel({ closed_won: 4 }),
      ads({ spend: 1000 }),
      rev({ wonOpps: 4, wonWithValue: 2, revenue: 3000 }),
    );
    expect(d.avgDeal).toBe(1500);
  });

  it("still reports ROAS on partial value coverage, since some is known", () => {
    const d = derive(
      funnel({ closed_won: 4 }),
      ads({ spend: 1000 }),
      rev({ wonOpps: 4, wonWithValue: 2, revenue: 3000 }),
    );
    expect(d.roas).toBe(3);
  });

  it("treats ROAS as higher-better and revenue growth as good", () => {
    expect(changeSentiment("roas", 0.4)).toBe("good");
    expect(changeSentiment("roas", -0.4)).toBe("bad");
    expect(changeSentiment("revenue", 0.2)).toBe("good");
  });

  /**
   * Three distinct states, three distinct outputs. Collapsing any pair of them
   * is how a dashboard starts lying:
   *   not queried  → null   (this test)
   *   queried, nothing closed → 0
   *   queried, closed but unvalued → null, with the reason surfaced in the UI
   */
  it("reports null ROAS when revenue was never queried for the period", () => {
    // No third argument: the trailing-window and month-on-month rows are built
    // this way, and must not print a confident 0.0× for a figure nobody fetched.
    const d = derive(funnel({ closed_won: 3 }), ads({ spend: 900 }));
    expect(d.roas).toBeNull();
    expect(d.avgDeal).toBeNull();
    expect(roasFrom(null, 900)).toBeNull();
  });

  it("roasFrom is the single decision point", () => {
    expect(roasFrom(rev({ wonOpps: 2, wonWithValue: 2, revenue: 200 }), 100)).toBe(2);
    // Closed, but unvalued → unknown.
    expect(roasFrom(rev({ wonOpps: 2, wonWithValue: 0 }), 100)).toBeNull();
    // Nothing closed → a real zero return.
    expect(roasFrom(rev(), 100)).toBe(0);
    // No spend → unattributable, never Infinity.
    expect(roasFrom(rev({ wonOpps: 1, wonWithValue: 1, revenue: 50 }), 0)).toBeNull();
  });

  it("sums all three revenue fields across periods", () => {
    const t = sumRevenue([
      rev({ wonOpps: 2, wonWithValue: 1, revenue: 500 }),
      rev({ wonOpps: 3, wonWithValue: 3, revenue: 1500 }),
    ]);
    expect(t).toEqual({ wonOpps: 5, wonWithValue: 4, revenue: 2000 });
  });
});

describe("sumAds", () => {
  it("sums additive metrics", () => {
    const total = sumAds([
      ads({ spend: 10, impressions: 1000, linkClicks: 5, clicksAll: 8, fbLeads: 1 }),
      ads({ spend: 20, impressions: 2000, linkClicks: 15, clicksAll: 22, fbLeads: 3 }),
    ]);
    expect(total.spend).toBe(30);
    expect(total.impressions).toBe(3000);
    expect(total.linkClicks).toBe(20);
    expect(total.fbLeads).toBe(4);
  });

  /*
   * Reach is deduplicated people, so summing daily values overstates it 2–5x.
   * Forcing null here means the UI shows a dash until a period-specific query
   * supplies the real figure — a dash is recoverable, a wrong number is not.
   */
  it("refuses to sum reach, returning null", () => {
    const total = sumAds([ads({ reach: 500 }), ads({ reach: 600 })]);
    expect(total.reach).toBeNull();
  });
});

describe("sumFunnels", () => {
  it("adds every stage", () => {
    const total = sumFunnels([
      funnel({ new_lead: 5, closed_won: 1 }),
      funnel({ new_lead: 7, no_show: 2 }),
    ]);
    expect(total.new_lead).toBe(12);
    expect(total.closed_won).toBe(1);
    expect(total.no_show).toBe(2);
  });
});

describe("pctChange", () => {
  it("computes a signed ratio", () => {
    expect(pctChange(120, 100)).toBeCloseTo(0.2);
    expect(pctChange(80, 100)).toBeCloseTo(-0.2);
  });

  // "Up from nothing" is not a percentage. The sheet printed "-" and was right.
  it("returns null when the previous period is zero", () => {
    expect(pctChange(50, 0)).toBeNull();
  });

  it("returns null when either side is null", () => {
    expect(pctChange(null, 100)).toBeNull();
    expect(pctChange(100, null)).toBeNull();
  });
});

describe("changeSentiment — polarity awareness", () => {
  // The inversion that matters: cheaper leads are good news, shown in green.
  it("treats a falling cost-per-lead as good", () => {
    expect(changeSentiment("cpLead", -0.2)).toBe("good");
    expect(changeSentiment("cpLead", 0.2)).toBe("bad");
  });

  it("treats rising leads as good", () => {
    expect(changeSentiment("new_lead", 0.3)).toBe("good");
    expect(changeSentiment("new_lead", -0.3)).toBe("bad");
  });

  it("treats rising no-shows as bad", () => {
    expect(changeSentiment("no_show", 0.5)).toBe("bad");
  });

  it("treats spend as neutral in both directions", () => {
    expect(changeSentiment("spend", 0.5)).toBe("neutral");
    expect(changeSentiment("spend", -0.5)).toBe("neutral");
  });

  it("returns neutral for null or zero change", () => {
    expect(changeSentiment("cpLead", null)).toBe("neutral");
    expect(changeSentiment("cpLead", 0)).toBe("neutral");
  });

  /*
   * The dead band. Small moves at these volumes are one extra lead or a day's
   * budget landing on the far side of a date boundary; dressing that as a
   * verdict is how the colours stop meaning anything.
   */
  it("refuses to judge a move smaller than the dead band, in either direction", () => {
    expect(changeSentiment("cpLead", -0.012)).toBe("neutral");
    expect(changeSentiment("cpLead", 0.012)).toBe("neutral");
    expect(changeSentiment("new_lead", 0.049)).toBe("neutral");
    expect(changeSentiment("new_lead", -0.049)).toBe("neutral");
  });

  it("judges a move at or past the dead band", () => {
    expect(changeSentiment("new_lead", SENTIMENT_DEAD_BAND)).toBe("good");
    expect(changeSentiment("new_lead", -SENTIMENT_DEAD_BAND)).toBe("bad");
  });

  it("agrees with the insight strip's own notability threshold", () => {
    // Both are expressed as 5%; the strip compares percentage points and this
    // compares a ratio. If they ever diverge, the prose at the top of the page
    // and the tiles below it start contradicting each other.
    expect(SENTIMENT_DEAD_BAND * 100).toBe(5);
  });

  it("stays neutral on a non-finite change rather than throwing a colour at it", () => {
    expect(changeSentiment("new_lead", Infinity)).toBe("neutral");
    expect(changeSentiment("new_lead", NaN)).toBe("neutral");
  });
});

describe("buildFunnelSteps", () => {
  it("annotates conversion and drop-off between stages", () => {
    const steps = buildFunnelSteps(
      funnel({
        new_lead: 100,
        contacted: 60,
        appointment_booked: 30,
        showed: 15,
        closed_won: 5,
      }),
      FUNNEL_PATH,
    );
    expect(steps[0].conversionFromPrevious).toBeNull();
    expect(steps[1].conversionFromPrevious).toBeCloseTo(0.6);
    expect(steps[1].droppedFromPrevious).toBe(40);
    expect(steps[4].conversionFromPrevious).toBeCloseTo(0.333, 2);
  });

  it("returns null conversion rather than dividing by an empty prior stage", () => {
    const steps = buildFunnelSteps(funnel({ contacted: 5 }), FUNNEL_PATH);
    expect(steps[1].conversionFromPrevious).toBeNull();
  });
});

describe("formatting", () => {
  it("renders null as a dash across every formatter", () => {
    expect(formatCurrency(null)).toBe(DASH);
    expect(formatPercent(null)).toBe(DASH);
    expect(formatNumber(null)).toBe(DASH);
    expect(formatChange(null)).toBe(DASH);
  });

  it("formats currency and percentages", () => {
    expect(formatCurrency(1234.5)).toBe("$1,234.50");
    expect(formatCurrency(0)).toBe("$0.00");
    expect(formatPercent(0.0308)).toBe("3.08%");
  });

  it("signs change values", () => {
    expect(formatChange(0.124)).toBe("+12.4%");
    expect(formatChange(-0.081)).toBe("−8.1%");
    expect(formatChange(0)).toBe("0.0%");
  });

  it("keeps zero distinct from missing", () => {
    expect(formatNumber(0)).toBe("0");
    expect(formatNumber(null)).toBe(DASH);
  });
});
