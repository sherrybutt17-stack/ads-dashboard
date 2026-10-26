import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, CLIENT_A, CLIENT_B, type TestDb } from "@/lib/metrics/__testdb__/harness";
import { windowFromKeys } from "@/lib/dates";
import type { Client } from "@/db/schema";
import type { BoardWidget, WidgetData, WidgetQuery } from "./types";

/**
 * TikTok's creative cards, and its splits by ad and by creative, against a
 * real Postgres.
 *
 * The account: one video in two ads across two campaigns, an image ad, a
 * video-views ad, and a carousel with no single asset. What must hold: a card
 * is the sum of its ads, each card counts its own kind of result, a cost ranks
 * cheapest first with the unmeasurable last, pictures come only from this
 * client's stored covers, and an account whose ad-level detail was never
 * collected says so instead of "no ads ran".
 */

let harness: { db: TestDb; close: () => Promise<void> };

vi.mock("@/db", () => ({
  get db() {
    return harness.db;
  },
  schema: {},
}));

let agg: typeof import("./aggregate");
let thumbs: typeof import("@/lib/tiktok/thumbs");

const TZ = "America/Los_Angeles";
const WINDOW = windowFromKeys("2026-10-01", "2026-10-10", TZ);
const ADV = "7012345678901234567";
/** A client with TikTok connected and no ad rows at all. */
const CLIENT_C = "33333333-3333-3333-3333-333333333333";

const client = (id: string) =>
  ({
    id,
    name: "Parfaire",
    slug: "parfaire",
    timezone: TZ,
    paidLeadFilter: "all",
    paidLeadTag: "facebook-lead",
    metaCurrency: "USD",
    agencyId: "00000000-0000-0000-0000-000000000099",
  }) as unknown as Client;

const CONNECTED = { meta: false, google: false, tiktok: true, crm: false };
const run = (s: string) => harness.db.execute(sql.raw(s));

function one(query: WidgetQuery, id = CLIENT_A): Promise<WidgetData> {
  return agg.loadWidgetData(
    {
      client: client(id),
      window: WINDOW,
      mode: "page",
      connections: CONNECTED,
      assets: { logoSrc: null, brandName: "Parfaire" },
    },
    query,
  );
}

function cardsOf(d: WidgetData) {
  if (d.kind !== "creatives") throw new Error(`expected cards, got ${d.kind}: ${JSON.stringify(d)}`);
  return d;
}

function tableOf(d: WidgetData) {
  if (d.kind !== "table") throw new Error(`expected a table, got ${d.kind}: ${JSON.stringify(d)}`);
  return d;
}

const lead = (value: number) => ({ value, objective: "LEAD_GENERATION" });

/** One ad's day, as the nightly ad-level pass stores it. */
async function adDay(f: {
  client?: string;
  date: string;
  campaign: string;
  campaignName: string;
  ad: string;
  key: string;
  type: "video" | "image" | "carousel";
  spend: number;
  impressions: number;
  clicks: number;
  results?: { value: number; objective: string };
  x?: Record<string, number>;
}) {
  const raw = { ...(f.results ? { results: f.results } : {}), ...(f.x ? { x: f.x } : {}) };
  await run(`
    INSERT INTO tiktok_ad_daily_metrics
      (client_id, advertiser_id, date, tiktok_campaign_id, campaign_name, tiktok_adgroup_id, tiktok_ad_id, ad_name,
       creative_key, creative_type, spend, impressions, clicks, raw)
    VALUES ('${f.client ?? CLIENT_A}', '${ADV}', '${f.date}', '${f.campaign}', '${f.campaignName}', 'g${f.campaign}',
            '${f.ad}', 'Ad ${f.ad}', '${f.key}', '${f.type}', ${f.spend}, ${f.impressions}, ${f.clicks},
            '${JSON.stringify(raw)}'::jsonb)
  `);
}

beforeAll(async () => {
  harness = await createTestDb();
  agg = await import("./aggregate");
  thumbs = await import("@/lib/tiktok/thumbs");

  for (const date of ["2026-10-02", "2026-10-03"]) {
    // v:v1 in two ads, one per campaign.
    await adDay({ date, campaign: "301", campaignName: "Spring", ad: "1801", key: "v:v1", type: "video", spend: 40, impressions: 4000, clicks: 80, results: lead(4), x: { video_6s: 900, likes: 10 } });
    await adDay({ date, campaign: "302", campaignName: "Autumn", ad: "1802", key: "v:v1", type: "video", spend: 20, impressions: 2000, clicks: 30, results: lead(1), x: { video_6s: 300, likes: 2 } });
    // An image whose picture was never stored.
    await adDay({ date, campaign: "301", campaignName: "Spring", ad: "1803", key: "i:img/7", type: "image", spend: 50, impressions: 5000, clicks: 50, results: lead(2) });
    // A carousel: no single asset, but a first image to show.
    await adDay({ date, campaign: "302", campaignName: "Autumn", ad: "1804", key: "", type: "carousel", spend: 15, impressions: 1500, clicks: 10 });
    // Optimised for video views: its own kind of result, cheap per view.
    await adDay({ date, campaign: "302", campaignName: "Autumn", ad: "1805", key: "v:v2", type: "video", spend: 10, impressions: 3000, clicks: 5, results: { value: 500, objective: "VIDEO_VIEWS" } });
    // Another client running the same video id: never on this client's cards.
    await adDay({ client: CLIENT_B, date, campaign: "901", campaignName: "Theirs", ad: "1901", key: "v:v1", type: "video", spend: 999, impressions: 9999, clicks: 999 });
  }

  await run(`
    INSERT INTO tiktok_ad_creatives (client_id, advertiser_id, tiktok_ad_id, ad_name, ad_text, creative_key, creative_type, thumb_key)
    VALUES
      ('${CLIENT_A}', '${ADV}', '1801', 'Spring hook', 'Book your consult today', 'v:v1', 'video', 'v:v1'),
      ('${CLIENT_A}', '${ADV}', '1802', 'Autumn hook', NULL, 'v:v1', 'video', 'v:v1'),
      ('${CLIENT_A}', '${ADV}', '1803', 'Before and after', 'Real results', 'i:img/7', 'image', 'i:img/7'),
      ('${CLIENT_A}', '${ADV}', '1804', 'Three looks', NULL, '', 'carousel', 'i:car/1'),
      ('${CLIENT_A}', '${ADV}', '1805', 'Views push', NULL, 'v:v2', 'video', 'v:v2')
  `);
  await run(`
    INSERT INTO tiktok_creative_assets (client_id, advertiser_id, asset_key, kind, duration_seconds, thumb, thumb_content_type)
    VALUES
      ('${CLIENT_A}', '${ADV}', 'v:v1', 'video', 14.6, '\\xffd8'::bytea, 'image/jpeg'),
      ('${CLIENT_A}', '${ADV}', 'i:car/1', 'image', NULL, '\\xffd8'::bytea, 'image/jpeg'),
      ('${CLIENT_A}', '${ADV}', 'i:img/7', 'image', NULL, NULL, NULL),
      ('${CLIENT_A}', '${ADV}', 'v:v2', 'video', 9, NULL, NULL),
      ('${CLIENT_B}', '${ADV}', 'i:img/7', 'image', NULL, '\\xffd8'::bytea, 'image/jpeg')
  `);
});

afterAll(async () => {
  await harness.close();
});

describe("TikTok creative cards, one per creative", () => {
  const byCreative: WidgetQuery = {
    kind: "creatives",
    platform: "tiktok",
    by: "creative",
    stats: ["spend", "results", "cost_per_result", "video_6s"],
    sort: "spend",
    topN: 6,
  };

  it("🔴 merges every ad that runs a video into one card — the sum of its ads", async () => {
    const d = cardsOf(await one(byCreative));
    expect(d.cards.map((c) => c.key)).toEqual(["v:v1", "i:img/7", "v:v2"]);
    const [video] = d.cards;
    expect(video).toMatchObject({
      name: "Spring hook",
      headline: null,
      body: "Book your consult today",
      type: "video",
      videoSeconds: 14.6,
      thumb: { ref: thumbs.tiktokPictureRef("v:v1") },
      previewUrl: null,
      context: "2 ads · 44% of spend",
      resultLabel: "Leads",
      rankings: [],
      learning: null,
    });
    // $120 over 10 leads; 6-second views summed across both ads.
    expect(video.values).toEqual([120, 10, 12, 2400]);
  });

  it("counts each card's own kind of result, as TikTok Ads Manager does", async () => {
    const d = cardsOf(await one(byCreative));
    const views = d.cards.find((c) => c.key === "v:v2")!;
    expect(views.resultLabel).not.toBe("Leads");
    expect(views.values.slice(0, 3)).toEqual([20, 1000, 0.02]);
    expect(d.notes).toContain("Each card counts its own kind of result, as Ads Manager does.");
  });

  it("🔴 shows only this client's pictures — an asset with none stored gets the placeholder", async () => {
    const d = cardsOf(await one(byCreative));
    // Another client stored a picture under the same key; it is not this client's.
    expect(d.cards.find((c) => c.key === "i:img/7")!.thumb).toBeNull();
    expect(d.cards.find((c) => c.key === "v:v2")!.thumb).toBeNull();
  });

  it("leaves the carousel off the cards and says where its spend went", async () => {
    const d = cardsOf(await one(byCreative));
    expect(d.cards.some((c) => c.key === "")).toBe(false);
    expect(d.notes).toContain("$30.00 went to ads with no single image or video (carousels), so it is on no card.");
  });

  it("names the ad-level days stored before an extra figure was collected, and when ad rows start", async () => {
    const d = cardsOf(await one(byCreative));
    expect(d.notes).toContain(
      "Some ad-level days were synced before these figures were collected — import TikTok ad-level detail on the Connections page again to include them.",
    );
    expect(d.notes).toContain(
      "TikTok ad-level figures start Oct 2; earlier days are not included. Import TikTok ad-level detail on the Connections page to add them.",
    );
  });

  it("🔴 never counts another client's ads", async () => {
    const d = cardsOf(await one({ ...byCreative, topN: 12 }));
    expect(d.cards.reduce((s, c) => s + (c.values[0] ?? 0), 0)).toBe(240);
  });
});

describe("TikTok creative cards, one per ad", () => {
  const byAd: WidgetQuery = {
    kind: "creatives",
    platform: "tiktok",
    by: "ad",
    stats: ["spend", "clicks", "ctr"],
    sort: "clicks",
    topN: 6,
  };

  it("keeps each ad on its own card, its campaign named", async () => {
    const d = cardsOf(await one(byAd));
    expect(d.cards.map((c) => c.key)).toEqual(["1801", "1803", "1802", "1804", "1805"]);
    expect(d.cards[0]).toMatchObject({ name: "Spring hook", context: "Spring · 30% of spend" });
    expect(d.cards[0].values).toEqual([80, 160, 0.02]);
  });

  it("gives a carousel its first image's picture", async () => {
    const d = cardsOf(await one(byAd));
    expect(d.cards.find((c) => c.key === "1804")).toMatchObject({
      name: "Three looks",
      type: "carousel",
      thumb: { ref: thumbs.tiktokPictureRef("i:car/1") },
    });
  });

  it("🔴 ranks a cost cheapest first, and an ad with no results last", async () => {
    const d = cardsOf(await one({ ...byAd, stats: ["spend", "cost_per_result"], sort: "cost_per_result" }));
    expect(d.cards.map((c) => c.key)).toEqual(["1805", "1801", "1802", "1803", "1804"]);
    expect(d.cards.at(-1)!.values[1]).toBeNull();
    expect(d.notes).toContain("Ranked by cost per result, lowest first.");
  });

  it("counts only the chosen campaigns' ads, and says so", async () => {
    const d = cardsOf(await one({ ...byAd, campaigns: ["302"] }));
    expect(d.cards.map((c) => c.key)).toEqual(["1802", "1804", "1805"]);
    expect(d.notes).toContain("Only ads in the campaign: Autumn.");
  });

  it("caps the cards and counts the rest", async () => {
    const d = cardsOf(await one({ ...byAd, topN: 2 }));
    expect(d.cards).toHaveLength(2);
    expect(d.more).toBe(3);
  });
});

describe("TikTok cards in a PDF or a share link", () => {
  it("🔴 carry this client's stored pictures inline — no session, no fetch", async () => {
    const doc = await import("./document");
    const widget: BoardWidget = {
      id: "w1",
      x: 0,
      y: 0,
      w: 12,
      h: 12,
      kind: "creatives",
      platform: "tiktok",
      by: "ad",
      stats: ["spend"],
      sort: "spend",
      topN: 6,
    };
    const data = { w1: await one(widget) };
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      await doc.inlineCreativeThumbs(client(CLIENT_A), [widget], data);
    } finally {
      vi.unstubAllGlobals();
    }
    const cards = cardsOf(data.w1).cards;
    // The stored bytes (ff d8), as they are.
    expect(cards.find((c) => c.key === "1801")!.thumb).toEqual({ src: "data:image/jpeg;base64,/9g=" });
    expect(cards.find((c) => c.key === "1804")!.thumb).toEqual({ src: "data:image/jpeg;base64,/9g=" });
    // No picture stored for this client: none borrowed from another.
    expect(cards.find((c) => c.key === "1803")!.thumb).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("a TikTok account whose ad-level detail was never collected", () => {
  it("🔴 says so, rather than 'no ads ran'", async () => {
    const d = await one(
      { kind: "creatives", platform: "tiktok", by: "ad", stats: ["spend"], sort: "spend", topN: 6 },
      CLIENT_C,
    );
    expect(d).toMatchObject({ kind: "unavailable", tone: "empty", title: "TikTok's ad-level detail isn't collected yet" });
  });
});

describe("TikTok tables and splits by ad and by creative", () => {
  it("lists every ad with its campaign and its own kind of result, from its own rows", async () => {
    const d = tableOf(
      await one({ kind: "table", platform: "tiktok", dimension: "ad", metrics: ["spend", "clicks", "results"], sort: "spend", topN: 10 }),
    );
    expect(d.rows.map((r) => [r.key, r.label, r.sub, r.values[0]])).toEqual([
      ["1803", "Ad 1803", "Spring · Leads", 100],
      ["1801", "Ad 1801", "Spring · Leads", 80],
      ["1802", "Ad 1802", "Autumn · Leads", 40],
      ["1804", "Ad 1804", "Autumn", 30],
      ["1805", "Ad 1805", "Autumn · Video views", 20],
    ]);
    // The total is the ad rows' own, never another client's.
    expect(d.totals[0]).toBe(270);
  });

  it("splits by creative with the no-single-asset spend as a row of its own, so it adds up", async () => {
    const d = tableOf(
      await one({ kind: "table", platform: "tiktok", dimension: "creative", metrics: ["spend", "likes"], sort: "spend", topN: 10 }),
    );
    expect(d.rows.map((r) => [r.label, r.values[0]])).toEqual([
      ["Spring hook", 120],
      ["Before and after", 100],
      ["Not attributable to one asset", 30],
      ["Views push", 20],
    ]);
    expect(d.rows[0].values[1]).toBe(24);
    expect(d.totals[0]).toBe(270);
  });

  it("draws a bar per ad", async () => {
    const d = await one({ kind: "category", platform: "tiktok", metric: "clicks", dimension: "ad", form: "bar", topN: 3 });
    if (d.kind !== "categories") throw new Error(`expected bars, got ${d.kind}`);
    expect(d.rows.slice(0, 2).map((r) => [r.label, r.value])).toEqual([
      ["Ad 1801", 160],
      ["Ad 1803", 100],
    ]);
  });
});
