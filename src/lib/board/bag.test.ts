import { describe, it, expect } from "vitest";
import { EMPTY_BAG, addBags, bag, metricValue, remainder, sumBags } from "./bag";

/**
 * The extra figures in a bag (`Bag.x`) and the stats computed from them by
 * `MetricDef.calc` — the same rules as the first stats: sums of components,
 * ratios from those sums, and no "free" results.
 */

describe("extra figures in a bag", () => {
  it("sums key by key, and a key one row lacks counts as zero", () => {
    const a = bag({ spend: 10, x: { likes: 3, follows: 1 } });
    const b = bag({ spend: 5, x: { likes: 2, video_views: 40 } });
    expect(addBags(a, b).x).toEqual({ likes: 5, follows: 1, video_views: 40 });
    expect(sumBags([a, b, bag({})]).x).toEqual({ likes: 5, follows: 1, video_views: 40 });
  });

  it("never shares the frozen empty map between bags", () => {
    const a = bag({});
    expect(a.x).not.toBe(EMPTY_BAG.x);
    expect(Object.isFrozen(EMPTY_BAG.x)).toBe(true);
  });

  it("keeps a whole's withheld remainder of each figure, never below zero", () => {
    const whole = bag({ x: { registrations: 10, contacts: 2 } });
    const parts = bag({ x: { registrations: 7, contacts: 5 } });
    expect(remainder(whole, parts).x).toEqual({ registrations: 3, contacts: 0 });
  });
});

describe("stats with a calc", () => {
  it("sum: the figure itself, zero when the row has none", () => {
    expect(metricValue("likes", bag({ x: { likes: 12 } }))).toBe(12);
    expect(metricValue("likes", bag({}))).toBe(0);
    expect(metricValue("video_plays", bag({ videoPlays: 90 }))).toBe(90);
  });

  it("per: spend ÷ the figure, and no honest cost without one", () => {
    expect(metricValue("cp_registration", bag({ spend: 100, x: { registrations: 4 } }))).toBe(25);
    expect(metricValue("cp_registration", bag({ spend: 100 }))).toBeNull();
    // Results with no spend are not free — the dashboard's costPer rule.
    expect(metricValue("cp_registration", bag({ spend: 0, x: { registrations: 4 } }))).toBeNull();
  });

  it("ratio: from the row's summed components, never an average of rates", () => {
    const day1 = bag({ impressions: 1000, x: { interactions: 100 } });
    const day2 = bag({ impressions: 9000, x: { interactions: 90 } });
    // (100 + 90) / (1000 + 9000), not the 5.5% average of 10% and 1%.
    expect(metricValue("interaction_rate", sumBags([day1, day2]))).toBeCloseTo(0.019, 6);
    expect(metricValue("interaction_rate", bag({}))).toBeNull();
  });

  it("Google's conversion rate divides by interactions; TikTok's CVR by clicks", () => {
    expect(metricValue("conversion_rate", bag({ x: { conversions: 3, interactions: 60 } }))).toBeCloseTo(0.05);
    expect(metricValue("cvr", bag({ linkClicks: 40, x: { conversions: 2 } }))).toBeCloseTo(0.05);
  });

  it("conv. value / cost is Google's own value over spend", () => {
    expect(metricValue("conv_value_per_cost", bag({ spend: 50, x: { conversions_value: 200 } }))).toBe(4);
  });

  it("leaves the first stats' own cases alone", () => {
    const b = bag({ spend: 30, linkClicks: 10, impressions: 1000, comments: 4 });
    expect(metricValue("cpc", b)).toBe(3);
    expect(metricValue("ctr", b)).toBeCloseTo(0.01);
    expect(metricValue("comments", b)).toBe(4);
  });
});

describe("figures collected for only part of a row's days", () => {
  // 30 days of delivery; interactions on record for 20 of them.
  const b = bag({ spend: 300, impressions: 30000, x: { interactions: 600 }, xMissing: { interactions: 10 } });

  it("still counts what was collected", () => {
    expect(metricValue("interactions", b)).toBe(600);
  });

  it("🔴 gives no rate or cost that would mix two ranges", () => {
    expect(metricValue("interaction_rate", b)).toBeNull();
    expect(metricValue("cpv", bag({ spend: 50, x: { video_views: 10 }, xMissing: { video_views: 1 } }))).toBeNull();
  });

  it("adds the missing days up, so a total of a partial row is partial too", () => {
    const whole = addBags(b, bag({ impressions: 1000, x: { interactions: 30 } }));
    expect(whole.xMissing).toEqual({ interactions: 10 });
    expect(metricValue("interaction_rate", whole)).toBeNull();
    // A figure no row is missing still divides.
    expect(metricValue("cvr", bag({ linkClicks: 40, x: { conversions: 2 }, xMissing: { likes: 3 } }))).toBeCloseTo(0.05);
  });
});
