import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, CLIENT_A, CLIENT_B, type TestDb } from "./__testdb__/harness";
import { windowFromKeys } from "@/lib/dates";

/**
 * The board's new queries against a real Postgres.
 *
 * The one that matters most reads Meta's `actions` array out of `raw` jsonb —
 * data nothing has ever read before, whose values Meta sends as strings, whose
 * keys come and go, and where several types describe the same purchase. Every
 * one of those is a way to print a wrong number or fail a statement, and a
 * failed statement on the Neon pool takes its neighbours with it.
 */

let harness: { db: TestDb; close: () => Promise<void> };

vi.mock("@/db", () => ({
  get db() {
    return harness.db;
  },
  schema: {},
}));

let bq: typeof import("./board-queries");

const TZ = "America/Los_Angeles";
const SEPT = windowFromKeys("2026-09-01", "2026-09-10", TZ);

beforeAll(async () => {
  harness = await createTestDb();
  bq = await import("./board-queries");
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await harness.db.execute(sql`DELETE FROM fb_daily_metrics`);
  await harness.db.execute(sql`DELETE FROM fb_breakdown_metrics`);
  await harness.db.execute(sql`DELETE FROM fb_period_reach`);
});

interface Fact {
  client?: string;
  date: string;
  level?: "campaign" | "ad";
  campaign?: string;
  campaignName?: string | null;
  adset?: string;
  adsetName?: string | null;
  ad?: string;
  adName?: string | null;
  spend?: number;
  impressions?: number;
  linkClicks?: number;
  lpv?: number;
  v3s?: number;
  plays?: number;
  thru?: number;
  raw?: unknown;
}

async function fact(f: Fact) {
  const raw = f.raw === undefined ? null : JSON.stringify(f.raw);
  await harness.db.execute(sql`
    INSERT INTO fb_daily_metrics (
      client_id, date, level, meta_campaign_id, campaign_name,
      meta_adset_id, adset_name, meta_ad_id, ad_name,
      spend, impressions, link_clicks, landing_page_views,
      video_3s_views, video_plays, thru_plays, raw
    ) VALUES (
      ${f.client ?? CLIENT_A}, ${f.date}, ${f.level ?? "campaign"},
      ${f.campaign ?? "c1"}, ${f.campaignName ?? null},
      ${f.adset ?? ""}, ${f.adsetName ?? null}, ${f.ad ?? ""}, ${f.adName ?? null},
      ${f.spend ?? 0}, ${f.impressions ?? 0}, ${f.linkClicks ?? 0}, ${f.lpv ?? 0},
      ${f.v3s ?? 0}, ${f.plays ?? 0}, ${f.thru ?? 0},
      ${raw}::jsonb
    )
  `);
}

const actions = (pairs: Record<string, string | number>) => ({
  actions: Object.entries(pairs).map(([action_type, value]) => ({ action_type, value })),
});

describe("getMetaCampaignExtras", () => {
  it("🔴 sums string values per type, and shrugs off junk instead of failing", async () => {
    await fact({ date: "2026-09-01", raw: actions({ post_reaction: "12", comment: "3", post: "2" }) });
    await fact({
      date: "2026-09-02",
      campaign: "c2",
      raw: actions({ post_reaction: "abc", comment: "1e5", post: "4", like: "7" }),
    });
    await fact({ date: "2026-09-03", campaign: "c3", raw: { actions: "not a list" } });
    await fact({ date: "2026-09-04", campaign: "c4", raw: { spend: "1" } });
    await fact({ date: "2026-09-05", campaign: "c5" }); // no raw at all

    const [total] = await bq.getMetaCampaignExtras(CLIENT_A, SEPT, "total");
    expect(total.postReactions).toBe(12);
    expect(total.comments).toBe(3);
    expect(total.shares).toBe(6);
    expect(total.pageLikes).toBe(7);
    expect(total.rowsWithoutRaw).toBe(1);
  });

  it("🔴 never adds overlapping purchase types together", async () => {
    await fact({
      date: "2026-09-01",
      raw: actions({ omni_purchase: "2", purchase: "2", "offsite_conversion.fb_pixel_purchase": "2" }),
    });
    await fact({
      date: "2026-09-01",
      campaign: "c2",
      raw: actions({ purchase: "1", "offsite_conversion.fb_pixel_purchase": "1" }),
    });
    await fact({ date: "2026-09-01", campaign: "c3", raw: actions({ "offsite_conversion.fb_pixel_purchase": "3" }) });

    const [total] = await bq.getMetaCampaignExtras(CLIENT_A, SEPT, "total");
    expect(total.purchases).toBe(6);
  });

  it("reads campaign rows only — ad rows describe the same delivery twice", async () => {
    await fact({ date: "2026-09-01", raw: actions({ post_reaction: "5" }), lpv: 10 });
    await fact({ date: "2026-09-01", level: "ad", ad: "a1", raw: actions({ post_reaction: "5" }), lpv: 10 });
    const [total] = await bq.getMetaCampaignExtras(CLIENT_A, SEPT, "total");
    expect(total.postReactions).toBe(5);
    expect(total.landingPageViews).toBe(10);
  });

  it("groups by day and by campaign, inside the window and the tenant", async () => {
    await fact({ date: "2026-09-01", campaign: "c1", campaignName: "Spring", raw: actions({ comment: "1" }) });
    await fact({ date: "2026-09-02", campaign: "c1", campaignName: "Spring", raw: actions({ comment: "2" }) });
    await fact({ date: "2026-09-02", campaign: "c2", campaignName: "Autumn", raw: actions({ comment: "4" }) });
    await fact({ date: "2026-08-31", campaign: "c1", raw: actions({ comment: "100" }) });
    await fact({ client: CLIENT_B, date: "2026-09-02", campaign: "c1", raw: actions({ comment: "100" }) });

    const days = await bq.getMetaCampaignExtras(CLIENT_A, SEPT, "day");
    expect(Object.fromEntries(days.map((d) => [d.key, d.comments]))).toEqual({
      "2026-09-01": 1,
      "2026-09-02": 6,
    });
    const campaigns = await bq.getMetaCampaignExtras(CLIENT_A, SEPT, "campaign");
    expect(Object.fromEntries(campaigns.map((c) => [c.key, [c.label, c.comments]]))).toEqual({
      c1: ["Spring", 3],
      c2: ["Autumn", 4],
    });
  });
});

describe("getMetaAdLevel", () => {
  it("🔴 never multiplies spend by the number of actions on a row", async () => {
    await fact({
      date: "2026-09-01",
      level: "ad",
      ad: "a1",
      spend: 10,
      impressions: 1000,
      raw: actions({ post_reaction: "1", comment: "1", post: "1", like: "1", post_engagement: "9" }),
    });
    await fact({ date: "2026-09-02", level: "ad", ad: "a1", spend: 5, impressions: 500 });
    const [total] = await bq.getMetaAdLevel(CLIENT_A, SEPT, "total");
    expect(total.spend).toBe(15);
    expect(total.impressions).toBe(1500);
    expect(total.postEngagement).toBe(9);
  });

  it("labels an ad with its most recent name, and names its campaign", async () => {
    await fact({ date: "2026-09-01", level: "ad", ad: "a1", adName: "Old name", campaignName: "Spring", spend: 1 });
    await fact({ date: "2026-09-03", level: "ad", ad: "a1", adName: "New name", campaignName: "Spring", spend: 1 });
    await fact({ date: "2026-09-04", level: "ad", ad: "a1", adName: null, spend: 1 });
    const [row] = await bq.getMetaAdLevel(CLIENT_A, SEPT, "ad");
    expect(row.label).toBe("New name");
    expect(row.parent).toBe("Spring");
    expect(row.spend).toBe(3);
  });

  it("carries the video figures only ad rows have, and ignores campaign rows", async () => {
    await fact({ date: "2026-09-01", level: "ad", ad: "a1", adset: "s1", adsetName: "Set one", thru: 7, plays: 20, v3s: 30 });
    await fact({ date: "2026-09-01", level: "campaign", thru: 999 });
    const [set] = await bq.getMetaAdLevel(CLIENT_A, SEPT, "adset");
    expect(set.key).toBe("s1");
    expect(set.label).toBe("Set one");
    expect(set.thruPlays).toBe(7);
    expect(set.videoPlays).toBe(20);
    const days = await bq.getMetaAdLevel(CLIENT_A, SEPT, "day");
    expect(days.map((d) => d.key)).toEqual(["2026-09-01"]);
  });
});

describe("getMetaCoverage", () => {
  it("reports where each kind of row starts", async () => {
    await fact({ date: "2026-06-01" });
    await fact({ date: "2026-09-05", level: "ad", ad: "a1" });
    await harness.db.execute(sql`
      INSERT INTO fb_breakdown_metrics (client_id, date_start, date_end, breakdown_key, segment_value)
      VALUES (${CLIENT_A}, '2026-09-07', '2026-09-07', 'gender', 'female')
    `);
    expect(await bq.getMetaCoverage(CLIENT_A)).toEqual({
      firstCampaignDay: "2026-06-01",
      firstAdDay: "2026-09-05",
      firstBreakdownDay: "2026-09-07",
    });
    expect(await bq.getMetaCoverage(CLIENT_B)).toEqual({
      firstCampaignDay: null,
      firstAdDay: null,
      firstBreakdownDay: null,
    });
  });
});

describe("getPeriodReachRow", () => {
  async function reach(account: string, start: string, end: string, value: number) {
    await harness.db.execute(sql`
      INSERT INTO fb_period_reach (client_id, meta_ad_account_id, period_start, period_end, reach, frequency)
      VALUES (${CLIENT_A}, ${account}, ${start}, ${end}, ${value}, 1.75)
    `);
  }

  it("returns the cached figure for exactly this range only", async () => {
    await reach("act1", "2026-09-01", "2026-09-10", 4200);
    await reach("act1", "2026-09-01", "2026-09-11", 9999);
    expect(await bq.getPeriodReachRow(CLIENT_A, SEPT)).toEqual({ reach: 4200, frequency: 1.75 });
    expect(await bq.getPeriodReachRow(CLIENT_A, windowFromKeys("2026-09-02", "2026-09-10", TZ))).toBeNull();
  });

  it("🔴 refuses to add reach across ad accounts", async () => {
    await reach("act1", "2026-09-01", "2026-09-10", 4200);
    await reach("act2", "2026-09-01", "2026-09-10", 1000);
    expect(await bq.getPeriodReachRow(CLIENT_A, SEPT)).toBe("multiple");
  });
});

describe("creative pairs, ad identity and campaign choices", () => {
  beforeEach(async () => {
    await harness.db.execute(sql`DELETE FROM meta_ad_creatives`);
  });

  async function adDay(f: {
    client?: string;
    date: string;
    level?: "ad" | "campaign";
    campaign?: string;
    ad?: string;
    key?: string;
    spend: number;
    clicksAll?: number;
    onsite?: number;
    pixel?: number;
    quality?: string | null;
  }) {
    await harness.db.execute(sql`
      INSERT INTO fb_daily_metrics (client_id, date, level, meta_campaign_id, campaign_name, meta_ad_id, ad_name,
                                    creative_key, spend, clicks_all, leads_onsite, leads_pixel, quality_ranking)
      VALUES (${f.client ?? CLIENT_A}, ${f.date}, ${f.level ?? "ad"}, ${f.campaign ?? "c1"}, ${"Camp " + (f.campaign ?? "c1")},
              ${f.level === "campaign" ? "" : (f.ad ?? "a1")}, ${f.level === "campaign" ? null : "Ad " + (f.ad ?? "a1")},
              ${f.key ?? ""}, ${f.spend}, ${f.clicksAll ?? 0}, ${f.onsite ?? 0}, ${f.pixel ?? 0},
              ${f.quality ?? null}::delivery_ranking)
    `);
  }

  it("🔴 gives one row per (creative, ad) — ad rows only, this client only", async () => {
    await adDay({ date: "2026-09-01", ad: "a1", key: "vid", spend: 10, onsite: 2, quality: "average" });
    await adDay({ date: "2026-09-02", ad: "a1", key: "vid", spend: 30, onsite: 1, quality: "above_average" });
    await adDay({ date: "2026-09-03", ad: "a1", key: "vid", spend: 5, quality: "unknown" });
    // The same ad after its creative was swapped.
    await adDay({ date: "2026-09-04", ad: "a1", key: "img", spend: 7, pixel: 3 });
    await adDay({ date: "2026-09-01", level: "campaign", spend: 999 });
    await adDay({ date: "2026-09-01", client: CLIENT_B, ad: "b1", key: "vid", spend: 999 });

    const pairs = await bq.getMetaAdCreativePairs(CLIENT_A, SEPT);
    const byKey = new Map(pairs.map((p) => [`${p.adId}|${p.creativeKey}`, p]));
    expect([...byKey.keys()].sort()).toEqual(["a1|img", "a1|vid"]);
    expect(byKey.get("a1|vid")).toMatchObject({ spend: 45, leadsOnsite: 3, leadsPixel: 0, campaignId: "c1" });
    expect(byKey.get("a1|img")).toMatchObject({ spend: 7, leadsPixel: 3 });
    // The most recent judgement, never "unknown", never an average.
    expect(byKey.get("a1|vid")?.qualityRanking).toBe("above_average");
  });

  it("sums Meta's on-Facebook and website leads apart, at both levels", async () => {
    await adDay({ date: "2026-09-01", level: "campaign", spend: 20, onsite: 4, pixel: 1 });
    await adDay({ date: "2026-09-02", level: "campaign", spend: 20, onsite: 2, pixel: 5 });
    await adDay({ date: "2026-09-01", ad: "a1", spend: 20, onsite: 4, pixel: 1 });
    const [extras] = await bq.getMetaCampaignExtras(CLIENT_A, SEPT, "total");
    expect(extras).toMatchObject({ leadsOnsite: 6, leadsPixel: 6 });
    const [ads] = await bq.getMetaAdLevel(CLIENT_A, SEPT, "total");
    expect(ads).toMatchObject({ leadsOnsite: 4, leadsPixel: 1 });
  });

  it("reads each ad's identity and stored preview link, for this client only", async () => {
    await harness.db.execute(sql`
      INSERT INTO meta_ad_creatives (client_id, meta_ad_id, ad_name, creative_key, creative_type, title, thumbnail_url, raw)
      VALUES (${CLIENT_A}, 'a1', 'Spring', 'vid', 'video', 'Book now', 'https://cdn.example/x.jpg',
              '{"preview_shareable_link":"https://fb.me/x"}'::jsonb),
             (${CLIENT_A}, 'a2', 'No raw', 'img', 'image', NULL, NULL, NULL),
             (${CLIENT_B}, 'b1', 'Other tenant', 'vid', 'video', NULL, NULL, NULL)
    `);
    const ids = await bq.getMetaAdIdentity(CLIENT_A, ["a1", "a2", "b1", "missing"]);
    expect([...ids.keys()].sort()).toEqual(["a1", "a2"]);
    expect(ids.get("a1")).toMatchObject({ adName: "Spring", title: "Book now", hasThumbnail: true, previewLink: "https://fb.me/x" });
    expect(ids.get("a2")).toMatchObject({ hasThumbnail: false, previewLink: null });
  });

  it("offers recent campaigns, the latest first, by their current name", async () => {
    await harness.db.execute(sql`
      INSERT INTO fb_daily_metrics (client_id, date, level, meta_campaign_id, campaign_name, spend)
      VALUES (${CLIENT_A}, CURRENT_DATE - 30, 'campaign', 'old', 'Old name', 5),
             (${CLIENT_A}, CURRENT_DATE - 2, 'campaign', 'old', 'Renamed', 5),
             (${CLIENT_A}, CURRENT_DATE - 10, 'campaign', 'mid', 'Middle', 50),
             (${CLIENT_A}, CURRENT_DATE - 900, 'campaign', 'ancient', 'Ancient', 50),
             (${CLIENT_B}, CURRENT_DATE - 1, 'campaign', 'theirs', 'Theirs', 50)
    `);
    expect(await bq.getMetaCampaignOptions(CLIENT_A)).toEqual([
      { id: "old", name: "Renamed" },
      { id: "mid", name: "Middle" },
    ]);
  });
});
