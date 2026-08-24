import { describe, it, expect } from "vitest";
import {
  EMPTY_CREATIVE_TOTALS,
  hookRate,
  holdRate,
  hookRateGrade,
  holdRateGrade,
  landRate,
  retentionCurve,
  rankingIsMeaningful,
  sortCreatives,
  sumCreativeTotals,
  type CreativeTotals,
} from "./creative";

const t = (over: Partial<CreativeTotals>): CreativeTotals => ({
  ...EMPTY_CREATIVE_TOTALS,
  ...over,
});

describe("hook rate", () => {
  it("is 3-second views over impressions", () => {
    expect(hookRate(t({ video3sViews: 300, impressions: 1000 }))).toBeCloseTo(0.3);
  });

  it("is null for a non-video creative, not zero", () => {
    // An image has no hook rate. Reporting 0% would rank every image below
    // every video on a metric that does not apply to it.
    expect(hookRate(t({ impressions: 5000 }))).toBeNull();
  });

  it("ignores video_plays entirely", () => {
    /*
     * The trap: `video_play_actions` counts autoplay starts nobody chose. On
     * feed placements that is nearly every impression, so a hook rate built
     * from plays reads ~100% for every ad ever run. Only `video_view` (3s)
     * belongs in the numerator.
     */
    const withPlays = t({ video3sViews: 200, videoPlays: 990, impressions: 1000 });
    expect(hookRate(withPlays)).toBeCloseTo(0.2);
  });

  it("grades against the published medians", () => {
    expect(hookRateGrade(0.2)).toBe("weak"); // below cold-prospecting median
    expect(hookRateGrade(0.3)).toBe("solid");
    expect(hookRateGrade(0.4)).toBe("strong"); // above warm-retargeting median
    expect(hookRateGrade(null)).toBe("unknown");
  });
});

describe("hold rate — the non-comparability trap", () => {
  it("is ThruPlays over 3-second views", () => {
    expect(holdRate(t({ thruPlays: 50, video3sViews: 200 }))).toBeCloseTo(0.25);
  });

  /*
   * THE load-bearing test. Meta counts a ThruPlay as "watched to completion"
   * below 15s and "reached 15s" above it. The same 50% hold rate therefore
   * means "half of them finished the whole ad" on a 10-second video and "half
   * of them got a quarter of the way in" on a 60-second one. Grading both the
   * same way rewards long videos for clearing a lower bar.
   */
  it("grades the SAME hold rate differently by video length", () => {
    const rate = 0.5;
    expect(holdRateGrade(rate, 10)).toBe("solid"); // completion — a high bar
    expect(holdRateGrade(rate, 20)).toBe("solid");
    expect(holdRateGrade(rate, 45)).toBe("strong");
    expect(holdRateGrade(rate, 90)).toBe("strong"); // 15s of 90s — an easy bar
  });

  it("refuses to grade a video whose length we do not know", () => {
    // An ungraded metric is honest; a wrongly graded one is not.
    expect(holdRateGrade(0.5, null)).toBe("unknown");
    expect(holdRateGrade(0.5, undefined)).toBe("unknown");
    expect(holdRateGrade(0.5, 0)).toBe("unknown");
  });

  it("is null when there is no video activity at all", () => {
    expect(holdRate(t({ impressions: 900 }))).toBeNull();
  });
});

describe("retention curve", () => {
  it("returns exactly the five anchors Meta actually reports", () => {
    const c = retentionCurve(
      t({
        video3sViews: 1000,
        videoP25: 600,
        videoP50: 400,
        videoP75: 250,
        videoP95: 120,
        videoP100: 100,
      }),
    );
    expect(c.map((p) => p.at)).toEqual([25, 50, 75, 95, 100]);
    expect(c[0].share).toBeCloseTo(0.6);
    expect(c[4].share).toBeCloseTo(0.1);
  });

  it("returns null shares rather than zero when nobody watched", () => {
    const c = retentionCurve(t({}));
    expect(c.every((p) => p.share === null)).toBe(true);
  });
});

describe("landing-page leak", () => {
  it("measures clicks that never reached the page", () => {
    expect(landRate(t({ linkClicks: 100, landingPageViews: 62 }))).toBeCloseTo(0.62);
  });

  it("is null rather than zero when nobody clicked", () => {
    expect(landRate(t({}))).toBeNull();
  });
});

describe("delivery rankings", () => {
  it("treats UNKNOWN as absent, not as average", () => {
    expect(rankingIsMeaningful("unknown", 10_000)).toBe(false);
    expect(rankingIsMeaningful(null, 10_000)).toBe(false);
  });

  it("requires the impression volume Meta itself requires", () => {
    // Below ~500 impressions Meta has not formed a judgement; showing one
    // would turn "no data yet" into "a mediocre ad".
    expect(rankingIsMeaningful("average", 200)).toBe(false);
    expect(rankingIsMeaningful("average", 500)).toBe(true);
  });
});

describe("leaderboard ordering", () => {
  const row = (id: string, over: Partial<CreativeTotals>) => ({ id, totals: t(over) });

  it("sorts spend, leads and rates biggest-first", () => {
    const rows = [
      row("small", { spend: 10 }),
      row("big", { spend: 100 }),
      row("mid", { spend: 50 }),
    ];
    expect(sortCreatives(rows, "spend").map((r) => r.id)).toEqual(["big", "mid", "small"]);
  });

  /*
   * The direction trap: every other column's "best" is its LARGEST value, but
   * cost's best is its smallest. Sorting them all the same way puts the most
   * expensive creative at the top of a list being scanned for winners.
   */
  it("sorts cost per lead CHEAPEST first", () => {
    const rows = [
      row("expensive", { spend: 100, leads: 2 }), // $50
      row("cheap", { spend: 100, leads: 20 }), // $5
      row("mid", { spend: 100, leads: 5 }), // $20
    ];
    expect(sortCreatives(rows, "cpl").map((r) => r.id)).toEqual([
      "cheap",
      "mid",
      "expensive",
    ]);
  });

  /*
   * And the trap that follows from it: ascending order would float every
   * unmeasurable creative to the TOP of the cost-per-lead view, so the first
   * thing a reader sees under "cheapest" is a list of creatives with no cost
   * per lead at all.
   */
  it("sinks unmeasurable creatives even when sorting ascending", () => {
    const rows = [
      row("noLeads", { spend: 80, leads: 0 }), // cpl is null
      row("cheap", { spend: 100, leads: 20 }),
    ];
    expect(sortCreatives(rows, "cpl").map((r) => r.id)).toEqual(["cheap", "noLeads"]);
  });

  it("sinks images when sorting on a video-only metric", () => {
    const rows = [
      row("image", { impressions: 9000, spend: 90 }), // hookRate → null
      row("video", { impressions: 1000, video3sViews: 100, spend: 10 }),
    ];
    // Despite 9× the impressions and spend, the image has no hook rate at all
    // and must not outrank the one creative the metric actually applies to.
    expect(sortCreatives(rows, "hook").map((r) => r.id)).toEqual(["video", "image"]);
  });

  it("breaks ties on spend so the biggest bets stay visible", () => {
    const rows = [
      row("tinyBudget", { spend: 5, leads: 1 }), // $5 cpl
      row("bigBudget", { spend: 500, leads: 100 }), // $5 cpl
    ];
    expect(sortCreatives(rows, "cpl").map((r) => r.id)).toEqual([
      "bigBudget",
      "tinyBudget",
    ]);
  });

  it("does not mutate its input", () => {
    const rows = [row("a", { spend: 1 }), row("b", { spend: 2 })];
    sortCreatives(rows, "spend");
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
  });
});

describe("summing", () => {
  it("adds every counter and keeps ratios out of storage", () => {
    const total = sumCreativeTotals([
      t({ impressions: 100, video3sViews: 30, spend: 10, leads: 1 }),
      t({ impressions: 200, video3sViews: 50, spend: 20, leads: 3 }),
    ]);
    expect(total.impressions).toBe(300);
    expect(total.video3sViews).toBe(80);
    expect(total.spend).toBe(30);
    expect(total.leads).toBe(4);
    // Derived from the summed components — 80/300, not the average of 30% and 25%.
    expect(hookRate(total)).toBeCloseTo(80 / 300);
  });
});
