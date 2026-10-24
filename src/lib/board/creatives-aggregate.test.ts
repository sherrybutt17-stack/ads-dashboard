import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, CLIENT_A, type TestDb } from "@/lib/metrics/__testdb__/harness";
import { windowFromKeys } from "@/lib/dates";
import type { Client } from "@/db/schema";
import type { WidgetData, WidgetQuery } from "./types";

/**
 * Creative cards against a real Postgres.
 *
 * The account below is the shape the Overview's leaderboard was built for:
 * one video running in three ads across two campaigns, an image ad, and a
 * Dynamic Creative ad with no single asset. What must hold: a creative card is
 * the leaderboard's number, a cost ranks cheapest first with the unmeasurable
 * last, a campaign filter counts only that campaign's ads, and nothing unsafe
 * reaches a link.
 */

let harness: { db: TestDb; close: () => Promise<void> };

vi.mock("@/db", () => ({
  get db() {
    return harness.db;
  },
  schema: {},
}));

let agg: typeof import("./aggregate");
let queries: typeof import("@/lib/metrics/queries");

const TZ = "America/Los_Angeles";
const WINDOW = windowFromKeys("2026-09-01", "2026-09-10", TZ);

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

const ALL = { meta: true, google: false, tiktok: false, crm: false };
const run = (s: string) => harness.db.execute(sql.raw(s));

function one(query: WidgetQuery): Promise<WidgetData> {
  return agg.loadWidgetData(
    { client: CLIENT, window: WINDOW, mode: "page", connections: ALL, assets: { logoSrc: null, brandName: "Acme" } },
    query,
  );
}

function cardsOf(d: WidgetData) {
  if (d.kind !== "creatives") throw new Error(`expected cards, got ${d.kind}: ${JSON.stringify(d)}`);
  return d;
}

/** One ad's day: campaign, ad, asset, spend and the counts a card reads. */
async function adDay(f: {
  date: string;
  campaign: string;
  campaignName: string;
  ad: string;
  key: string;
  type: "video" | "image" | "carousel" | "unknown";
  spend: number;
  impressions: number;
  linkClicks?: number;
  clicksAll?: number;
  onsite?: number;
  leads?: number;
  quality?: string | null;
}) {
  await run(`
    INSERT INTO fb_daily_metrics
      (client_id, date, level, meta_campaign_id, campaign_name, meta_ad_id, ad_name, creative_key, creative_type,
       spend, impressions, link_clicks, clicks_all, leads_total, leads_onsite, quality_ranking)
    VALUES ('${CLIENT_A}', '${f.date}', 'ad', '${f.campaign}', '${f.campaignName}', '${f.ad}', 'Ad ${f.ad}',
            '${f.key}', '${f.type}', ${f.spend}, ${f.impressions}, ${f.linkClicks ?? 0}, ${f.clicksAll ?? 0},
            ${f.leads ?? f.onsite ?? 0}, ${f.onsite ?? 0}, ${f.quality ? `'${f.quality}'` : "NULL"})
  `);
}

beforeAll(async () => {
  harness = await createTestDb();
  agg = await import("./aggregate");
  queries = await import("@/lib/metrics/queries");

  for (const d of ["2026-09-02", "2026-09-03"]) {
    // vid_a in three ads: two in Spring, one in Autumn.
    await adDay({ date: d, campaign: "101", campaignName: "Spring", ad: "1", key: "vid_a", type: "video", spend: 50, impressions: 2000, linkClicks: 20, clicksAll: 40, onsite: 5, quality: "above_average" });
    await adDay({ date: d, campaign: "101", campaignName: "Spring", ad: "2", key: "vid_a", type: "video", spend: 25, impressions: 1000, linkClicks: 10, clicksAll: 15, onsite: 1 });
    await adDay({ date: d, campaign: "202", campaignName: "Autumn", ad: "3", key: "vid_a", type: "video", spend: 15, impressions: 500, linkClicks: 5, clicksAll: 6, onsite: 0 });
    // An image with clicks but no leads: no cost per lead, so it ranks last on cost.
    await adDay({ date: d, campaign: "101", campaignName: "Spring", ad: "4", key: "img_b", type: "image", spend: 100, impressions: 4000, linkClicks: 80, clicksAll: 90, onsite: 0 });
    // Dynamic Creative: no single asset.
    await adDay({ date: d, campaign: "202", campaignName: "Autumn", ad: "5", key: "", type: "carousel", spend: 20, impressions: 800, linkClicks: 4, clicksAll: 5, onsite: 2 });
  }

  await run(`
    INSERT INTO meta_ad_creatives (client_id, meta_ad_id, ad_name, meta_campaign_id, creative_key, creative_type, title, body, thumbnail_url, raw)
    VALUES
      ('${CLIENT_A}', '1', 'Spring video — main', '101', 'vid_a', 'video', 'Book a free consult', 'See why patients choose us.',
         'https://cdn.example/a.jpg', '{"preview_shareable_link":"https://fb.me/abc123"}'::jsonb),
      ('${CLIENT_A}', '2', 'Spring video — copy', '101', 'vid_a', 'video', 'Book a free consult', NULL, 'https://cdn.example/a.jpg', NULL),
      ('${CLIENT_A}', '3', 'Autumn video', '202', 'vid_a', 'video', NULL, NULL, 'https://cdn.example/a.jpg', NULL),
      ('${CLIENT_A}', '4', 'Before and after', '101', 'img_b', 'image', 'Before and after', 'Real results.',
         'https://cdn.example/b.jpg', '{"preview_shareable_link":"http://evil.example/steal"}'::jsonb)
  `);
});

afterAll(async () => {
  await harness.close();
});

describe("one card per creative", () => {
  const byCreative: WidgetQuery = {
    kind: "creatives",
    platform: "meta",
    by: "creative",
    stats: ["spend", "fb_onsite_leads", "cp_onsite_lead"],
    sort: "spend",
    topN: 6,
  };

  it("🔴 merges every ad that runs the same video into one card", async () => {
    const d = cardsOf(await one(byCreative));
    const video = d.cards.find((c) => c.key === "vid_a")!;
    expect(video.values).toEqual([180, 12, 15]);
    expect(video.context).toBe("3 ads · 43% of spend");
    // The biggest-spending ad names the card; its headline is kept, being different.
    expect(video.name).toBe("Spring video — main");
    expect(video.headline).toBe("Book a free consult");
    expect(video.thumb).toEqual({ ref: "vid_a" });
  });

  it("matches the Overview's leaderboard spend, asset by asset", async () => {
    const d = cardsOf(await one(byCreative));
    const board = new Map(d.cards.map((c) => [c.key, c.values[0]]));
    for (const row of await queries.getCreativePerformance(CLIENT_A, WINDOW)) {
      if (row.creativeKey === "") continue;
      expect(board.get(row.creativeKey), row.creativeKey).toBe(row.totals.spend);
    }
  });

  it("keeps Dynamic Creative off the cards but in every share, and says so", async () => {
    const d = cardsOf(await one(byCreative));
    expect(d.cards.map((c) => c.key)).not.toContain("");
    expect(d.notes?.join(" ")).toMatch(/\$40\.00 went to ads with no single image or video/);
    // 200 of 420 total spend, the Dynamic Creative ad's 40 included.
    expect(d.cards.find((c) => c.key === "img_b")!.context).toBe("1 ad · 48% of spend");
  });

  it("🔴 ranks a cost cheapest first, and a card with no value for it last", async () => {
    const d = cardsOf(await one({ ...byCreative, sort: "cp_onsite_lead" }));
    expect(d.cards.map((c) => c.key)).toEqual(["vid_a", "img_b"]);
    expect(d.cards[1].values[2]).toBeNull();
    expect(d.notes?.join(" ")).toMatch(/lowest first/);
  });
});

describe("one card per ad", () => {
  const byAd: WidgetQuery = {
    kind: "creatives",
    platform: "meta",
    by: "ad",
    stats: ["impressions", "clicks", "ctr_all"],
    sort: "clicks",
    topN: 3,
  };

  it("gives every ad its own card, named by its campaign, ranked by the chosen stat", async () => {
    const d = cardsOf(await one(byAd));
    expect(d.cards.map((c) => c.key)).toEqual(["4", "1", "2"]);
    expect(d.cards[0].context).toBe("Spring · 48% of spend");
    // CTR (all) is clicks of any kind over impressions: 180 / 8000.
    expect(d.cards[0].values).toEqual([8000, 160, 0.0225]);
    expect(d.more).toBe(2);
  });

  it("names an ad with no single asset by itself, and looks its picture up by ad", async () => {
    const d = cardsOf(await one({ ...byAd, topN: 12 }));
    const dynamic = d.cards.find((c) => c.key === "5")!;
    expect(dynamic.name).toBe("Ad 5");
    // No identity stored for it, so no picture to ask for at all.
    expect(dynamic.thumb).toBeNull();
  });

  it("🔴 counts only the chosen campaign's ads, and names it", async () => {
    const d = cardsOf(await one({ ...byAd, topN: 12, campaigns: ["202"] }));
    expect(d.cards.map((c) => c.key).sort()).toEqual(["3", "5"]);
    expect(d.notes?.join(" ")).toMatch(/Only ads in the campaign: Autumn\./);
  });

  it("🔴 shows Facebook's preview link, and never anything else", async () => {
    const d = cardsOf(await one({ ...byAd, topN: 12 }));
    expect(d.cards.find((c) => c.key === "1")!.previewUrl).toBe("https://fb.me/abc123");
    expect(d.cards.find((c) => c.key === "4")!.previewUrl).toBeNull();
  });

  it("gives delivery rankings only where Meta has judged enough impressions", async () => {
    const d = cardsOf(await one({ ...byAd, topN: 12, rankings: true }));
    expect(d.cards.find((c) => c.key === "1")!.rankings).toEqual([{ label: "Quality", value: "above_average" }]);
    // Enough impressions, but Meta returned no ranking for it.
    expect(d.cards.find((c) => c.key === "3")!.rankingNote).toBe(
      "Meta has not returned a delivery ranking for this ad.",
    );
  });
});

describe("when there is nothing to show", () => {
  it("says so, and how to fill older dates", async () => {
    const d = await agg.loadWidgetData(
      {
        client: CLIENT,
        window: windowFromKeys("2026-08-01", "2026-08-31", TZ),
        mode: "page",
        connections: ALL,
        assets: { logoSrc: null, brandName: "Acme" },
      },
      { kind: "creatives", platform: "meta", by: "ad", stats: ["spend"], sort: "spend", topN: 6 },
    );
    expect(d).toMatchObject({ kind: "unavailable", title: "No ads ran in this range" });
    if (d.kind === "unavailable") expect(d.detail).toMatch(/Import ad-level history on the Connections page/);
  });
});

describe("results on a card", () => {
  it("count each card's own kind of result, and say which", async () => {
    // Last: this adds results to the video's ad rows.
    await run(`
      UPDATE fb_daily_metrics
         SET raw = '{"results":[{"indicator":"actions:onsite_conversion.lead_grouped","values":[{"value":"3","attribution_windows":["default"]}]}]}'::jsonb
       WHERE client_id = '${CLIENT_A}' AND meta_ad_id IN ('1', '2', '3')
    `);
    const d = cardsOf(
      await one({
        kind: "creatives",
        platform: "meta",
        by: "creative",
        stats: ["spend", "results", "cost_per_result"],
        sort: "results",
        topN: 6,
      }),
    );
    const video = d.cards.find((c) => c.key === "vid_a")!;
    // 3 results on each of 6 ad-days; $180 ÷ 18.
    expect(video.values).toEqual([180, 18, 10]);
    expect(video.resultLabel).toBe("On-Facebook leads");
    expect(d.notes?.join(" ")).toMatch(/Each card counts its own kind of result/);
  });
});
