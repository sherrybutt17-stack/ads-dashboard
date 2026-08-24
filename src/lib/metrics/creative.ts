import { div, costPer } from "./compute";
import { lengthBucket, type LengthBucket } from "@/lib/meta/creative";

/**
 * Creative performance metrics — pure, so every benchmark claim is testable.
 *
 * The two headline video metrics both have a trap, and both traps are the kind
 * that make a number look authoritative while meaning something else.
 */

/** Additive counters for one creative over a period. Ratios are NEVER stored. */
export interface CreativeTotals {
  impressions: number;
  video3sViews: number;
  videoPlays: number;
  thruPlays: number;
  videoP25: number;
  videoP50: number;
  videoP75: number;
  videoP95: number;
  videoP100: number;
  linkClicks: number;
  landingPageViews: number;
  outboundClicks: number;
  spend: number;
  leads: number;
}

export const EMPTY_CREATIVE_TOTALS: CreativeTotals = {
  impressions: 0,
  video3sViews: 0,
  videoPlays: 0,
  thruPlays: 0,
  videoP25: 0,
  videoP50: 0,
  videoP75: 0,
  videoP95: 0,
  videoP100: 0,
  linkClicks: 0,
  landingPageViews: 0,
  outboundClicks: 0,
  spend: 0,
  leads: 0,
};

/**
 * HOOK RATE — did the scroll stop?
 *
 * 3-second views ÷ impressions. The numerator must be `actions[video_view]`,
 * Meta's 3-second threshold, and NOT `video_play_actions`: a "play" includes an
 * autoplay start nobody chose, and on feed placements that is nearly every
 * impression, which would put hook rate near 100% for every ad ever run.
 *
 * Null for a non-video creative rather than 0 — an image has no hook rate, and
 * reporting 0% would rank every image below every video on a metric that does
 * not apply to it.
 */
export function hookRate(t: CreativeTotals): number | null {
  if (t.video3sViews === 0 && t.videoPlays === 0) return null; // not a video
  return div(t.video3sViews, t.impressions);
}

/**
 * HOLD RATE — did they stay?
 *
 * ThruPlays ÷ 3-second views.
 *
 * 🔴 **Not comparable across video lengths.** Meta counts a ThruPlay as
 * "watched to completion" below 15 seconds and "reached 15 seconds" at or above
 * it. So a 10-second ad must be FINISHED to score, while a 60-second ad scores
 * at the quarter mark — and a leaderboard sorted on raw hold rate systematically
 * favours long videos for clearing a lower bar. Always render it with its length
 * bucket; `holdRateBenchmark` refuses to grade one without a length.
 */
export function holdRate(t: CreativeTotals): number | null {
  if (t.thruPlays === 0 && t.video3sViews === 0) return null;
  return div(t.thruPlays, t.video3sViews);
}

/** Of the people who clicked, how many actually reached the page. */
export function landRate(t: CreativeTotals): number | null {
  return div(t.landingPageViews, t.linkClicks);
}

/**
 * The retention curve.
 *
 * Meta exposes exactly FIVE anchors — 25/50/75/95/100% — plus the 3-second
 * view. Every smooth "second-by-second retention curve" in this category is
 * interpolation between those points; this returns the anchors and says so, so
 * nobody reads a straight line between 25% and 50% as measurement.
 */
export interface RetentionPoint {
  /** Percent of the video watched. */
  at: number;
  viewers: number;
  /** Share of 3-second viewers still watching. Null when there were none. */
  share: number | null;
}

export function retentionCurve(t: CreativeTotals): RetentionPoint[] {
  const base = t.video3sViews;
  const pt = (at: number, viewers: number): RetentionPoint => ({
    at,
    viewers,
    share: div(viewers, base),
  });
  return [
    pt(25, t.videoP25),
    pt(50, t.videoP50),
    pt(75, t.videoP75),
    pt(95, t.videoP95),
    pt(100, t.videoP100),
  ];
}

export const RETENTION_IS_INTERPOLATED =
  "Meta reports only five retention anchors (25/50/75/95/100%). Anything between them is interpolation, not measurement.";

/* ------------------------------------------------------------------ *
 * Benchmarks
 * ------------------------------------------------------------------ */

export type Grade = "weak" | "solid" | "strong" | "unknown";

/**
 * Hook-rate benchmarks. Published medians: ~22% cold prospecting, ~36% warm
 * retargeting, which is why the boundaries sit where they do.
 */
export function hookRateGrade(rate: number | null): Grade {
  if (rate === null) return "unknown";
  if (rate < 0.25) return "weak";
  if (rate <= 0.35) return "solid";
  return "strong";
}

/**
 * Hold-rate benchmarks, SEGMENTED BY LENGTH — the thing no competitor does.
 *
 * A single set of thresholds applied to every video grades a 10-second ad on
 * "did they finish it" and a 60-second ad on "did they reach 15 seconds", then
 * prints both as one number. Without a known duration this returns `unknown`
 * rather than guessing: an ungraded metric is honest, a wrongly graded one is
 * not.
 *
 * Thresholds rise as videos shorten because finishing a short video is a lower
 * bar than a minute of attention.
 */
const HOLD_THRESHOLDS: Record<LengthBucket, { weak: number; strong: number } | null> = {
  // Sub-15s: a ThruPlay is a COMPLETION, so good creative clears a high bar.
  under_15s: { weak: 0.45, strong: 0.7 },
  // 15–30s: a ThruPlay is 15s, i.e. half to all of the video.
  "15_30s": { weak: 0.35, strong: 0.55 },
  "30_60s": { weak: 0.25, strong: 0.45 },
  // Over a minute, 15 seconds is a small fraction — the bar drops accordingly.
  over_60s: { weak: 0.2, strong: 0.4 },
  unknown: null,
};

export function holdRateGrade(
  rate: number | null,
  videoLengthSeconds: number | null | undefined,
): Grade {
  if (rate === null) return "unknown";
  const t = HOLD_THRESHOLDS[lengthBucket(videoLengthSeconds)];
  if (!t) return "unknown"; // no length → no honest grade
  if (rate < t.weak) return "weak";
  if (rate < t.strong) return "solid";
  return "strong";
}

/**
 * Delivery rankings need volume before they mean anything.
 *
 * Meta returns `UNKNOWN` below roughly 500 impressions, and `UNKNOWN` is a
 * different statement from `AVERAGE`. Rendering the two the same is how an ad
 * with no data yet gets treated as a mediocre performer.
 */
export const RANKING_MIN_IMPRESSIONS = 500;

export function rankingIsMeaningful(
  ranking: string | null | undefined,
  impressions: number,
): boolean {
  return (
    Boolean(ranking) &&
    ranking !== "unknown" &&
    impressions >= RANKING_MIN_IMPRESSIONS
  );
}

/* ------------------------------------------------------------------ *
 * Leaderboard ordering
 * ------------------------------------------------------------------ */

export type CreativeSortKey = "spend" | "leads" | "cpl" | "hook" | "hold";

/**
 * Order the leaderboard.
 *
 * Two rules that are easy to get wrong and change what a reader concludes:
 *
 * 1. **Cost per lead sorts ASCENDING.** Every other column's "best" is its
 *    largest value; cost's best is its smallest. Sorting all of them the same
 *    direction puts the most expensive creative at the top of a list the reader
 *    is scanning for winners.
 * 2. **Nulls sink, in every direction.** A creative with no measurable value —
 *    an image has no hook rate, a creative with no leads has no cost per lead —
 *    must never sort as if it were the best. Ascending order would otherwise
 *    float every unmeasurable creative to the top of the cost-per-lead view.
 *
 * Ties and unmeasurables fall back to spend, so the ordering is stable and the
 * biggest bets stay visible rather than scattering to the bottom.
 */
export function sortCreatives<T extends { totals: CreativeTotals }>(
  rows: readonly T[],
  key: CreativeSortKey,
): T[] {
  const value = (c: T): number | null => {
    switch (key) {
      case "spend":
        return c.totals.spend;
      case "leads":
        return c.totals.leads;
      case "cpl":
        return costPer(c.totals.spend, c.totals.leads);
      case "hook":
        return hookRate(c.totals);
      case "hold":
        return holdRate(c.totals);
    }
  };
  const ascending = key === "cpl";
  return [...rows].sort((a, b) => {
    const av = value(a);
    const bv = value(b);
    if (av === null && bv === null) return b.totals.spend - a.totals.spend;
    if (av === null) return 1;
    if (bv === null) return -1;
    if (av === bv) return b.totals.spend - a.totals.spend;
    return ascending ? av - bv : bv - av;
  });
}

export function sumCreativeTotals(rows: CreativeTotals[]): CreativeTotals {
  return rows.reduce<CreativeTotals>(
    (a, r) => ({
      impressions: a.impressions + r.impressions,
      video3sViews: a.video3sViews + r.video3sViews,
      videoPlays: a.videoPlays + r.videoPlays,
      thruPlays: a.thruPlays + r.thruPlays,
      videoP25: a.videoP25 + r.videoP25,
      videoP50: a.videoP50 + r.videoP50,
      videoP75: a.videoP75 + r.videoP75,
      videoP95: a.videoP95 + r.videoP95,
      videoP100: a.videoP100 + r.videoP100,
      linkClicks: a.linkClicks + r.linkClicks,
      landingPageViews: a.landingPageViews + r.landingPageViews,
      outboundClicks: a.outboundClicks + r.outboundClicks,
      spend: a.spend + r.spend,
      leads: a.leads + r.leads,
    }),
    { ...EMPTY_CREATIVE_TOTALS },
  );
}
