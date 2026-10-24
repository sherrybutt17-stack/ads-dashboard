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

describe("Meta's other action families and ad-row figures", () => {
  it("🔴 counts each family once — the first type present on a row wins", async () => {
    // One registration, reported three ways; one contact, two ways.
    await fact({
      date: "2026-09-01",
      raw: actions({
        omni_complete_registration: "2",
        complete_registration: "2",
        "offsite_conversion.fb_pixel_complete_registration": "2",
        contact_website: "1",
        "offsite_conversion.fb_pixel_contact": "1",
        "onsite_conversion.messaging_conversation_started_7d": "5",
      }),
    });
    // Only the pixel's type on this row: it is the count.
    await fact({ date: "2026-09-02", campaign: "c2", raw: actions({ "offsite_conversion.fb_pixel_complete_registration": "3" }) });

    const [total] = await bq.getMetaCampaignExtras(CLIENT_A, SEPT, "total");
    expect(total.x.registrations).toBe(5);
    expect(total.x.contacts).toBe(1);
    expect(total.x.messaging_conversations).toBe(5);
    expect(total.x.checkouts).toBe(0);
    const byCampaign = await bq.getMetaCampaignExtras(CLIENT_A, SEPT, "campaign");
    expect(byCampaign.find((r) => r.key === "c2")?.x.registrations).toBe(3);
  });

  it("carries outbound clicks and the quartiles from ad rows, beside the action families", async () => {
    await fact({ date: "2026-09-01", level: "ad", ad: "a1", raw: actions({ schedule_total: "2" }) });
    await fact({ date: "2026-09-02", level: "ad", ad: "a1" });
    await harness.db.execute(sql`
      UPDATE fb_daily_metrics SET outbound_clicks = 9, video_p25 = 40, video_p100 = 4 WHERE meta_ad_id = 'a1'`);
    const [ad] = await bq.getMetaAdLevel(CLIENT_A, SEPT, "ad");
    expect(ad.x).toMatchObject({ outbound_clicks: 18, video_p25: 80, video_p100: 8, schedules: 2 });
    const [pair] = await bq.getMetaAdCreativePairs(CLIENT_A, SEPT);
    expect(pair.x).toMatchObject({ outbound_clicks: 18, video_p25: 80, schedules: 2 });
  });
});

describe("getSimpleExtras", () => {
  beforeEach(async () => {
    await harness.db.execute(sql`DELETE FROM google_daily_metrics`);
    await harness.db.execute(sql`DELETE FROM tiktok_daily_metrics`);
  });

  async function googleRow(o: {
    client?: string;
    date: string;
    campaign?: string;
    spend?: number;
    impressions?: number;
    conversions?: number;
    raw?: unknown;
  }) {
    await harness.db.execute(sql`
      INSERT INTO google_daily_metrics (client_id, customer_id, date, google_campaign_id, spend, impressions, conversions, raw)
      VALUES (${o.client ?? CLIENT_A}, '1', ${o.date}, ${o.campaign ?? "g1"}, ${o.spend ?? 10}, ${o.impressions ?? 100},
              ${o.conversions ?? 0}, ${o.raw === undefined ? null : JSON.stringify(o.raw)}::jsonb)`);
  }

  const XC = { all_conversions: 2.5, all_conversions_value: 300, conversions_value: 250, view_through_conversions: 1 };
  const XE = { interactions: 40, engagements: 0, video_views: 7, phone_calls: 1 };

  it("sums Google's two families and its conversions column, by day and campaign, for this client only", async () => {
    await googleRow({ date: "2026-09-01", conversions: 2, raw: { xc: XC, xe: XE } });
    await googleRow({ date: "2026-09-02", campaign: "g2", conversions: 1, raw: { xc: XC, xe: XE } });
    await googleRow({ client: CLIENT_B, date: "2026-09-01", conversions: 50, raw: { xc: XC, xe: XE } });
    const [total] = await bq.getSimpleExtras("google", CLIENT_A, SEPT, "total");
    expect(total.x).toMatchObject({ all_conversions: 5, conversions_value: 500, interactions: 80, video_views: 14, conversions: 3 });
    expect(total.uncollected.interactions).toBe(0);
    const days = await bq.getSimpleExtras("google", CLIENT_A, SEPT, "day");
    expect(days.map((d) => d.key).sort()).toEqual(["2026-09-01", "2026-09-02"]);
    const campaigns = await bq.getSimpleExtras("google", CLIENT_A, SEPT, "campaign");
    expect(campaigns.find((c) => c.key === "g2")?.x.phone_calls).toBe(1);
  });

  it("🔴 counts the delivery days synced before a family was collected, figure by figure", async () => {
    await googleRow({ date: "2026-09-01", raw: { xc: XC } }); // the engagement family failed that night
    await googleRow({ date: "2026-09-02", raw: { campaignId: "g1" } }); // synced before either existed
    await googleRow({ date: "2026-09-03" }); // no raw at all
    await googleRow({ date: "2026-09-04", spend: 0, impressions: 0 }); // no delivery: nothing missing
    const [total] = await bq.getSimpleExtras("google", CLIENT_A, SEPT, "total");
    expect(total.uncollected.all_conversions).toBe(2);
    expect(total.uncollected.interactions).toBe(3);
  });

  it("reads TikTok's figures from raw.x, and shrugs off junk", async () => {
    await harness.db.execute(sql`
      INSERT INTO tiktok_daily_metrics (client_id, advertiser_id, date, tiktok_campaign_id, spend, impressions, conversions, raw)
      VALUES (${CLIENT_A}, 'adv', '2026-09-01', 't1', 20, 500, 4, ${JSON.stringify({ x: { likes: 12, comments: "3", follows: "lots" } })}::jsonb),
             (${CLIENT_A}, 'adv', '2026-09-02', 't1', 20, 500, 1, ${JSON.stringify({ metrics: {} })}::jsonb)`);
    const [total] = await bq.getSimpleExtras("tiktok", CLIENT_A, SEPT, "total");
    expect(total.x).toMatchObject({ likes: 12, comments: 3, follows: 0, conversions: 5 });
    // The second day was synced before the figures existed. "lots" on the first
    // is collected but unreadable, so it reads as zero and is not missing.
    expect(total.uncollected.likes).toBe(1);
    expect(total.uncollected.follows).toBe(1);
    expect(total.uncollected.profile_visits).toBe(2);
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
