import { describe, it, expect } from "vitest";
import { sortTiktokCreatives } from "./TiktokCreativeGrid";
import type { TiktokCreativeRow } from "@/lib/metrics/tiktok-creatives";
import { tiktokResultType } from "@/lib/metrics/results";

/** The TikTok leaderboard's order: by the chosen stat, costs lowest first, no-value last. */

const card = (
  key: string,
  spend: number,
  { results, cost, v2, ...over }: Partial<Omit<TiktokCreativeRow, "results">> & { results?: number; cost?: number | null; v2?: number } = {},
): TiktokCreativeRow => ({
  creativeKey: key,
  creativeType: "video",
  adName: key,
  adText: null,
  callToAction: null,
  videoSeconds: null,
  pictureRef: null,
  adCount: 1,
  adgroupCount: 1,
  campaignNames: [],
  uncollectedDays: 0,
  totals: {
    spend, impressions: 1000, clicks: 10, conversions: 0,
    likes: 0, comments: 0, shares: 0, follows: 0, profile_visits: 0,
    video_views: 0, video_2s: v2 ?? 0, video_6s: 0, video_p25: 0, video_p50: 0, video_p75: 0, video_p100: 0,
  },
  results:
    results === undefined
      ? null
      : { type: tiktokResultType("LEAD_GENERATION"), count: results, costPer: cost ?? null, otherTypes: 0 },
  ...over,
});

const keys = (rows: TiktokCreativeRow[]) => rows.map((r) => r.creativeKey);

describe("sortTiktokCreatives", () => {
  const rows = [
    card("v:a", 100, { results: 5, cost: 20, v2: 300 }),
    card("v:b", 300, { results: 30, cost: 10, v2: 100 }),
    card("v:c", 200),
  ];

  it("ranks by spend and by results, highest first", () => {
    expect(keys(sortTiktokCreatives(rows, "spend"))).toEqual(["v:b", "v:c", "v:a"]);
    expect(keys(sortTiktokCreatives(rows, "results"))).toEqual(["v:b", "v:a", "v:c"]);
  });

  it("🔴 ranks cost per result lowest first, with a card that has none last", () => {
    expect(keys(sortTiktokCreatives(rows, "cpr"))).toEqual(["v:b", "v:a", "v:c"]);
  });

  it("ranks view rates for videos, an image's rate being no value", () => {
    // v:c viewed by nobody is a 0% rate, still a value; the image has none.
    const withImage = [...rows, card("i:x", 500, { creativeType: "image", v2: 999 })];
    expect(keys(sortTiktokCreatives(withImage, "view2s"))).toEqual(["v:a", "v:b", "v:c", "i:x"]);
  });
});
