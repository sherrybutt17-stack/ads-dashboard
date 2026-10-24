import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, CLIENT_A, type TestDb } from "@/lib/metrics/__testdb__/harness";
import { windowFromKeys } from "@/lib/dates";
import type { Client } from "@/db/schema";
import type { WidgetData, WidgetQuery } from "./types";

/**
 * Board widgets over every platform's other figures, against a real Postgres:
 * Google's columns beside Conversions, TikTok's engagement and video figures,
 * and Meta's action families and ad-row quartiles.
 *
 * The rules under test are the Board's usual ones — ratios from summed
 * components, the same source for a tile and a table — plus the two this kind
 * of stat adds: a platform reads its OWN rows for a stat two platforms share,
 * and a range synced before a figure was collected says so.
 */

let harness: { db: TestDb; close: () => Promise<void> };

vi.mock("@/db", () => ({
  get db() {
    return harness.db;
  },
  schema: {},
}));

let agg: typeof import("./aggregate");

const TZ = "America/Los_Angeles";
const WINDOW = windowFromKeys("2026-09-01", "2026-09-10", TZ);
/** The days Google's extra figures were collected on — Sept 10 was synced before. */
const COLLECTED = windowFromKeys("2026-09-01", "2026-09-09", TZ);

const CLIENT = {
  id: CLIENT_A,
  name: "Acme",
  slug: "acme",
  timezone: TZ,
  paidLeadFilter: "all",
  paidLeadTag: "facebook-lead",
  metaCurrency: "USD",
  agencyId: "00000000-0000-0000-0000-000000000099",
} as unknown as Client;

const ALL = { meta: true, google: true, tiktok: true, crm: false };
const run = (s: string) => harness.db.execute(sql.raw(s));

function one(query: WidgetQuery, window = WINDOW): Promise<WidgetData> {
  return agg.loadWidgetData(
    { client: CLIENT, window, mode: "page", connections: ALL, assets: { logoSrc: null, brandName: "Acme" } },
    query,
  );
}

function valueOf(d: WidgetData) {
  if (d.kind !== "value") throw new Error(`expected a value, got ${d.kind}: ${JSON.stringify(d)}`);
  return d;
}

const day = (d: number) => `2026-09-${String(d).padStart(2, "0")}`;

beforeAll(async () => {
  harness = await createTestDb();
  agg = await import("./aggregate");

  /*
   * Google: two campaigns, every day collected except Sept 10, which was
   * synced before the extra figures existed.
   */
  for (let d = 1; d <= 10; d++) {
    const families =
      d === 10
        ? {}
        : {
            xc: { all_conversions: 1.5, all_conversions_value: 120, conversions_value: 100, view_through_conversions: 0 },
            xe: { interactions: d === 1 ? 300 : 20, engagements: 0, video_views: 4, phone_calls: 1 },
          };
    await run(`
      INSERT INTO google_daily_metrics (client_id, customer_id, date, google_campaign_id, campaign_name, spend, impressions, clicks, conversions, raw)
      VALUES ('${CLIENT_A}', '1', '${day(d)}', 'g1', 'Search', 50, ${d === 1 ? 1000 : 400}, 20, 1, '${JSON.stringify(families)}'::jsonb),
             ('${CLIENT_A}', '1', '${day(d)}', 'g2', 'Video', 10, 2000, 5, 0, '${JSON.stringify(d === 10 ? {} : { xc: families.xc, xe: { ...families.xe, video_views: 100 } })}'::jsonb)
    `);
  }

  // TikTok: comments, likes, plays and a quartile on its daily rows.
  for (let d = 1; d <= 10; d++) {
    await run(`
      INSERT INTO tiktok_daily_metrics (client_id, advertiser_id, date, tiktok_campaign_id, campaign_name, spend, impressions, clicks, conversions, raw)
      VALUES ('${CLIENT_A}', 'adv', '${day(d)}', 't1', 'Prospecting', 20, 1000, 40, 2,
              '${JSON.stringify({ x: { likes: 10, comments: 3, shares: 1, follows: 0, profile_visits: 2, video_views: 500, video_2s: 300, video_6s: 120, video_p25: 200, video_p50: 100, video_p75: 50, video_p100: 25 } })}'::jsonb)
    `);
  }

  // Meta: registrations on campaign rows, outbound clicks and quartiles on ad rows.
  const actions = (pairs: Record<string, string>) =>
    JSON.stringify({ actions: Object.entries(pairs).map(([action_type, value]) => ({ action_type, value })) });
  for (let d = 1; d <= 10; d++) {
    await run(`
      INSERT INTO fb_daily_metrics (client_id, date, level, meta_campaign_id, campaign_name, spend, impressions, link_clicks, raw)
      VALUES ('${CLIENT_A}', '${day(d)}', 'campaign', 'm1', 'Signups', 30, 3000, 60,
              '${actions({ omni_complete_registration: "2", complete_registration: "2" })}'::jsonb)
    `);
    await run(`
      INSERT INTO fb_daily_metrics (client_id, date, level, meta_campaign_id, meta_adset_id, meta_ad_id, ad_name, spend, impressions,
                                    outbound_clicks, video_p25, video_plays, raw)
      VALUES ('${CLIENT_A}', '${day(d)}', 'ad', 'm1', 's1', 'a1', 'Signup video', 30, 3000, 45, 999, 1500, '${actions({})}'::jsonb)
    `);
  }
});

afterAll(async () => {
  await harness.close();
});

describe("Google's columns beside Conversions", () => {
  it("sums conversion value, and prices it as value ÷ spend", async () => {
    const value = valueOf(await one({ kind: "kpi", platform: "google", metric: "conversion_value" }));
    // 9 collected days × 2 campaigns × $100.
    expect(value.value).toBe(1800);
    const ratio = valueOf(await one({ kind: "kpi", platform: "google", metric: "conv_value_per_cost" }, COLLECTED));
    // $1,800 over the $540 spent on those same nine days.
    expect(ratio.value).toBeCloseTo(1800 / 540, 6);
  });

  it("🔴 says when part of the range was synced before these figures existed", async () => {
    const d = valueOf(await one({ kind: "kpi", platform: "google", metric: "all_conversions" }));
    expect(d.notes?.join(" ")).toMatch(/synced before these figures were collected/);
    // Spend alone never carries that note: it is always collected.
    const spend = valueOf(await one({ kind: "kpi", platform: "google", metric: "spend" }));
    expect(spend.notes ?? []).toEqual([]);
    // A range of collected days only has nothing to own up to.
    const whole = valueOf(await one({ kind: "kpi", platform: "google", metric: "all_conversions" }, COLLECTED));
    expect(whole.notes ?? []).toEqual([]);
  });

  it("🔴 prints no rate that would divide nine days of a figure by ten days of delivery", async () => {
    // Sept 10 has impressions and spend but no interactions on record.
    const rate = valueOf(await one({ kind: "kpi", platform: "google", metric: "interaction_rate" }));
    expect(rate.value).toBeNull();
    expect(rate.notes?.join(" ")).toMatch(/re-pull history/);
    const cost = valueOf(await one({ kind: "kpi", platform: "google", metric: "cpv" }));
    expect(cost.value).toBeNull();
    // A count of what was collected still shows, with the same note.
    const sum = valueOf(await one({ kind: "kpi", platform: "google", metric: "interactions" }));
    expect(sum.value).toBe(920);
  });

  it("🔴 a rate is a ratio of sums, in the tile and the table total alike", async () => {
    const tile = valueOf(await one({ kind: "kpi", platform: "google", metric: "interaction_rate" }, COLLECTED));
    // g1: 300 + 8×20 = 460 interactions; g2 the same: 920 over 1000 + 8×400 + 9×2000 = 22,200.
    expect(tile.value).toBeCloseTo(920 / 22200, 8);

    const table = await one(
      {
        kind: "table",
        platform: "google",
        dimension: "campaign",
        metrics: ["spend", "interactions", "interaction_rate"],
        sort: "spend",
        topN: 10,
      },
      COLLECTED,
    );
    if (table.kind !== "table") throw new Error(table.kind);
    expect(table.rows.map((r) => r.key)).toEqual(["g1", "g2"]);
    expect(table.rows[0].values[1]).toBe(460);
    expect(table.totals[2]).toBeCloseTo(tile.value!, 10);
  });

  it("draws a figure day by day", async () => {
    const s = await one({ kind: "series", platform: "google", metric: "video_views", form: "line", compare: false });
    if (s.kind !== "series") throw new Error(s.kind);
    expect(s.points).toHaveLength(10);
    expect(s.points[0].value).toBe(104);
    expect(s.points[9].value).toBe(0);
  });
});

describe("TikTok's engagement and video figures", () => {
  it("🔴 shows comments under the stat Meta uses, from TikTok's own rows", async () => {
    const d = valueOf(await one({ kind: "kpi", platform: "tiktok", metric: "comments" }));
    expect(d.value).toBe(30);
  });

  it("🔴 reads its quartiles from its daily rows, never Meta's ad rows", async () => {
    const tiktok = valueOf(await one({ kind: "kpi", platform: "tiktok", metric: "video_p25" }));
    expect(tiktok.value).toBe(2000);
    // Meta's own quartiles still come from Meta's ad rows.
    const meta = valueOf(await one({ kind: "kpi", platform: "meta", metric: "video_p25" }));
    expect(meta.value).toBe(9990);
  });

  it("divides conversions by clicks for TikTok's CVR, and has no uncollected days", async () => {
    const d = valueOf(await one({ kind: "kpi", platform: "tiktok", metric: "cvr" }));
    expect(d.value).toBeCloseTo(20 / 400, 8);
    const likes = valueOf(await one({ kind: "kpi", platform: "tiktok", metric: "likes" }));
    expect(likes.value).toBe(100);
    expect(likes.notes ?? []).toEqual([]);
  });

  it("splits a figure by campaign", async () => {
    const c = await one({ kind: "category", platform: "tiktok", metric: "video_views", dimension: "campaign", form: "bar", topN: 5 });
    if (c.kind !== "categories") throw new Error(c.kind);
    expect(c.rows).toEqual([{ key: "t1", label: "Prospecting", value: 5000 }]);
  });
});

describe("Meta's action families and ad-row figures", () => {
  it("counts registrations once per row, and prices them", async () => {
    const regs = valueOf(await one({ kind: "kpi", platform: "meta", metric: "registrations" }));
    // Reported twice a day under overlapping types; counted once: 2 × 10 days.
    expect(regs.value).toBe(20);
    const cost = valueOf(await one({ kind: "kpi", platform: "meta", metric: "cp_registration" }));
    expect(cost.value).toBe(15);
  });

  it("reads outbound clicks from ad rows, with their own CTR", async () => {
    const ctr = valueOf(await one({ kind: "kpi", platform: "meta", metric: "outbound_ctr" }));
    expect(ctr.value).toBeCloseTo(450 / 30000, 8);
  });

  it("puts the new stats on creative cards", async () => {
    const cards = await one({
      kind: "creatives",
      platform: "meta",
      by: "ad",
      stats: ["outbound_clicks", "video_p25", "video_plays"],
      sort: "outbound_clicks",
      topN: 3,
    });
    if (cards.kind !== "creatives") throw new Error(cards.kind);
    expect(cards.cards[0].values).toEqual([450, 9990, 15000]);
  });
});
