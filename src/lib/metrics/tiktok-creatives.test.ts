import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, CLIENT_A, CLIENT_B, type TestDb } from "@/lib/metrics/__testdb__/harness";
import { windowFromKeys } from "@/lib/dates";

/**
 * TikTok per creative, against a real Postgres: one card per asset, TikTok's
 * own Results by main type, extras summed, a picture only where one is stored,
 * and nothing from another client or outside the range.
 */

let harness: { db: TestDb; close: () => Promise<void> };

vi.mock("@/db", () => ({
  get db() {
    return harness.db;
  },
  schema: {},
}));

let mod: typeof import("./tiktok-creatives");
let thumbs: typeof import("@/lib/tiktok/thumbs");

const TZ = "America/Los_Angeles";
const WINDOW = windowFromKeys("2026-10-01", "2026-10-31", TZ);
const ADV = "7012345678901234567";

async function run(q: string) {
  return (await harness.db.execute(sql.raw(q))) as unknown as { rows: Record<string, unknown>[] };
}

/** One ad's day. */
async function adDay(
  client: string,
  ad: string,
  key: string,
  date: string,
  spend: number,
  raw: Record<string, unknown> = {},
  over: { type?: string; adgroup?: string; campaign?: string } = {},
) {
  await run(`INSERT INTO tiktok_ad_daily_metrics
    (client_id, advertiser_id, date, tiktok_campaign_id, campaign_name, tiktok_adgroup_id, tiktok_ad_id, ad_name,
     creative_key, creative_type, spend, impressions, clicks, raw)
    VALUES ('${client}', '${ADV}', '${date}', 'c1', '${over.campaign ?? "Spring"}', '${over.adgroup ?? "g1"}', '${ad}', 'Ad ${ad}',
     '${key}', '${over.type ?? (key.startsWith("i:") ? "image" : key ? "video" : "unknown")}', ${spend}, ${spend * 100}, ${spend * 2},
     '${JSON.stringify(raw)}'::jsonb)`);
}

const lead = (value: number) => ({ results: { value, objective: "LEAD_GENERATION" } });

beforeAll(async () => {
  harness = await createTestDb();
  mod = await import("./tiktok-creatives");
  thumbs = await import("@/lib/tiktok/thumbs");
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await run(`TRUNCATE tiktok_ad_daily_metrics, tiktok_ad_creatives, tiktok_creative_assets RESTART IDENTITY`);
});

describe("getTiktokCreativePerformance", () => {
  it("🔴 gives one card per video, however many ads and ad groups run it", async () => {
    await adDay(CLIENT_A, "1801", "v:v1", "2026-10-05", 40, { ...lead(4), x: { video_2s: 500, likes: 3 } });
    await adDay(CLIENT_A, "1802", "v:v1", "2026-10-06", 60, { ...lead(2), x: { video_2s: 700, likes: 1 } }, { adgroup: "g2" });
    const [card] = await mod.getTiktokCreativePerformance(CLIENT_A, WINDOW);
    expect(card).toMatchObject({
      creativeKey: "v:v1",
      creativeType: "video",
      adCount: 2,
      adgroupCount: 2,
      campaignNames: ["Spring"],
      totals: { spend: 100, impressions: 10000, video_2s: 1200, likes: 4 },
    });
    // Cost per result is a ratio of the sums: $100 over 6 leads.
    expect(card.results).toMatchObject({ count: 6, otherTypes: 0 });
    expect(card.results!.type.label).toBe("Leads");
    expect(card.results!.costPer).toBeCloseTo(100 / 6, 8);
  });

  it("counts a card's main result type, never a sum across types", async () => {
    await adDay(CLIENT_A, "1801", "v:v1", "2026-10-05", 80, lead(4));
    await adDay(CLIENT_A, "1802", "v:v1", "2026-10-05", 20, { results: { value: 900, objective: "VIDEO_VIEWS" } });
    const [card] = await mod.getTiktokCreativePerformance(CLIENT_A, WINDOW);
    expect(card.results).toMatchObject({ count: 4, costPer: 20, otherTypes: 1 });
  });

  it("keeps the spend no single asset served as its own row", async () => {
    await adDay(CLIENT_A, "1801", "v:v1", "2026-10-05", 40);
    await adDay(CLIENT_A, "1803", "", "2026-10-05", 15, {}, { type: "carousel" });
    const cards = await mod.getTiktokCreativePerformance(CLIENT_A, WINDOW);
    expect(cards.map((c) => [c.creativeKey, c.totals.spend])).toEqual(
      expect.arrayContaining([
        ["v:v1", 40],
        ["", 15],
      ]),
    );
  });

  it("names a card from its ad and links its picture only when one is stored", async () => {
    await adDay(CLIENT_A, "1801", "v:v1", "2026-10-05", 40);
    await adDay(CLIENT_A, "1803", "i:img/1", "2026-10-05", 10);
    await run(`INSERT INTO tiktok_ad_creatives (client_id, advertiser_id, tiktok_ad_id, ad_name, ad_text, creative_key, creative_type, thumb_key)
               VALUES ('${CLIENT_A}', '${ADV}', '1801', 'Spring hook', 'Book your consult', 'v:v1', 'video', 'v:v1')`);
    await run(`INSERT INTO tiktok_creative_assets (client_id, advertiser_id, asset_key, kind, duration_seconds, thumb, thumb_content_type)
               VALUES ('${CLIENT_A}', '${ADV}', 'v:v1', 'video', 14.6, '\\xffd8'::bytea, 'image/jpeg'),
                      ('${CLIENT_A}', '${ADV}', 'i:img/1', 'image', NULL, NULL, NULL)`);
    const cards = await mod.getTiktokCreativePerformance(CLIENT_A, WINDOW);
    const video = cards.find((c) => c.creativeKey === "v:v1")!;
    expect(video).toMatchObject({ adName: "Spring hook", adText: "Book your consult", videoSeconds: 14.6 });
    expect(video.pictureRef).toBe(thumbs.tiktokPictureRef("v:v1"));
    // An image with no stored picture shows the typed placeholder, never a dead link.
    expect(cards.find((c) => c.creativeKey === "i:img/1")!.pictureRef).toBeNull();
  });

  it("says which delivered days were synced before the extras were collected", async () => {
    await adDay(CLIENT_A, "1801", "v:v1", "2026-10-05", 40);
    await adDay(CLIENT_A, "1801", "v:v1", "2026-10-06", 40, { x: { likes: 1 } });
    const [card] = await mod.getTiktokCreativePerformance(CLIENT_A, WINDOW);
    expect(card.uncollectedDays).toBe(1);
  });

  it("🔴 reads only this client's rows, in the range", async () => {
    await adDay(CLIENT_A, "1801", "v:v1", "2026-10-05", 40);
    await adDay(CLIENT_A, "1801", "v:v1", "2026-09-30", 999);
    await adDay(CLIENT_B, "1901", "v:v1", "2026-10-05", 777);
    const cards = await mod.getTiktokCreativePerformance(CLIENT_A, WINDOW);
    expect(cards.map((c) => c.totals.spend)).toEqual([40]);
  });
});

describe("hasTiktokAdLevelData", () => {
  it("tells 'not imported yet' from 'nothing ran'", async () => {
    expect(await mod.hasTiktokAdLevelData(CLIENT_A)).toBe(false);
    await adDay(CLIENT_A, "1801", "v:v1", "2025-01-05", 40);
    expect(await mod.hasTiktokAdLevelData(CLIENT_A)).toBe(true);
    expect(await mod.hasTiktokAdLevelData(CLIENT_B)).toBe(false);
  });
});

describe("loadTiktokPicture", () => {
  it("🔴 serves a stored picture to its own client only", async () => {
    await run(`INSERT INTO tiktok_creative_assets (client_id, advertiser_id, asset_key, kind, thumb, thumb_content_type)
               VALUES ('${CLIENT_A}', '${ADV}', 'v:v1', 'video', '\\xffd8ffe0'::bytea, 'image/jpeg')`);
    const mine = await thumbs.loadTiktokPicture(CLIENT_A, "v:v1");
    expect(mine?.contentType).toBe("image/jpeg");
    expect(Buffer.from(mine!.bytes).toString("hex")).toBe("ffd8ffe0");
    expect(await thumbs.loadTiktokPicture(CLIENT_B, "v:v1")).toBeNull();
  });
});
