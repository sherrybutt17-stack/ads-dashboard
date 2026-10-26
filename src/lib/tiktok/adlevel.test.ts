import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { sql } from "drizzle-orm";
import type { Client } from "@/db/schema";
import { createTestDb, type TestDb } from "@/lib/metrics/__testdb__/harness";
import { TIKTOK_EXTRAS } from "@/lib/metrics/platform-extras";

/**
 * The TikTok ad-level pass, against a real Postgres with TikTok faked at the
 * client: what it writes, what it names each row by, what it keeps when TikTok
 * will not answer, and what it never touches.
 */

let harness: { db: TestDb; close: () => Promise<void> };

vi.mock("@/db", () => ({
  get db() {
    return harness.db;
  },
  schema: {},
}));

/** What the fake TikTok answers. */
type Report = { rows: unknown[]; fields: string[] };
/** The ad report's answer: fixed, an error, or by the window asked for. */
let report: Report | Error | ((since: string, until: string) => Report) = { rows: [], fields: [] };
let ads: unknown[] | Error = [];
let videos: Record<string, unknown> = {};
const asked: { method: string; ids?: string[]; since?: string; until?: string }[] = [];

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return {
    ...actual,
    TiktokClient: class {
      constructor(readonly token: string) {}
      async getAdDailyReport(_adv: string, since: string, until: string) {
        asked.push({ method: "report", since, until });
        if (report instanceof Error) throw report;
        return typeof report === "function" ? report(since, until) : report;
      }
      async getAdsByIds(_adv: string, ids: string[]) {
        asked.push({ method: "ads", ids: [...ids] });
        if (ads instanceof Error) throw ads;
        return (ads as Array<{ ad_id: string }>).filter((a) => ids.includes(a.ad_id));
      }
      async getVideoInfo(_adv: string, ids: string[]) {
        asked.push({ method: "videos", ids: [...ids] });
        return ids.filter((id) => videos[id]).map((id) => ({ video_id: id, ...(videos[id] as object) }));
      }
      async getImageInfo(_adv: string, ids: string[]) {
        asked.push({ method: "images", ids: [...ids] });
        return ids.map((id) => ({ image_id: id, width: 1080, height: 1080, image_url: "https://p16-sign.tiktokcdn.com/i.jpeg?x-expires=1" }));
      }
    },
  };
});

/** Pictures the fake CDN serves: by URL, or null for a CDN that fails. */
let picture: ((url: string) => { bytes: Buffer; contentType: string } | null) | null = null;
const fetched: string[] = [];
vi.mock("./thumbs", () => ({
  fetchTiktokPicture: async (url: string) => {
    fetched.push(url);
    return picture ? picture(url) : null;
  },
}));

let activeAccounts: Record<string, unknown>[] = [];
vi.mock("./accounts", () => ({
  activeTiktokAccounts: async () => activeAccounts,
}));

let mod: typeof import("./adlevel");
let encrypt: (s: string) => string;

const CLIENT_ID = "11111111-1111-1111-1111-111111111111";
const ADV = "7012345678901234567";
const TZ = "America/Los_Angeles";
const client = { id: CLIENT_ID, slug: "acme", name: "Acme", timezone: TZ } as Client;

async function run(q: string) {
  return (await harness.db.execute(sql.raw(q))) as unknown as { rows: Record<string, unknown>[] };
}

/** One ad's day, shaped the way the report sends it. */
const adDay = (ad: string, day = "2026-10-20", over: Record<string, unknown> = {}) => ({
  dimensions: { ad_id: ad, stat_time_day: `${day} 00:00:00` },
  metrics: {
    ad_name: `Ad ${ad}`,
    adgroup_id: "1700000000000001",
    adgroup_name: "Lookalike",
    campaign_id: "1600000000000001",
    campaign_name: "Spring",
    spend: "40.00",
    impressions: "4000",
    clicks: "80",
    conversion: "3",
    result: "4",
    objective_type: "LEAD_GENERATION",
    likes: "12",
    video_play_actions: "900",
    video_watched_2s: "500",
    ...over,
  },
});
const ALL_FIELDS = ["spend", "impressions", "clicks", "ad_name", "adgroup_id", "adgroup_name", "campaign_id", "campaign_name", "conversion", "result", "objective_type", ...Object.values(TIKTOK_EXTRAS)];

const pass = (deadline = Date.now() + 60_000) => mod.syncClientTiktokAdLevel(client, { days: 28, deadline });
const rows = async () =>
  (await run(`SELECT tiktok_ad_id, date::text AS date, creative_key, creative_type, spend::float AS spend FROM tiktok_ad_daily_metrics ORDER BY tiktok_ad_id, date`)).rows;
const runs = async () => (await run(`SELECT kind, status, rows_written, error, meta FROM sync_runs ORDER BY started_at`)).rows;

beforeAll(async () => {
  harness = await createTestDb();
  process.env.ENCRYPTION_KEY = "a".repeat(64);
  ({ encrypt } = await import("@/lib/crypto"));
  mod = await import("./adlevel");
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  asked.length = 0;
  fetched.length = 0;
  picture = (url) => ({ bytes: Buffer.from(`jpeg:${url}`), contentType: "image/jpeg" });
  report = { rows: [adDay("1801"), adDay("1802"), adDay("1803", "2026-10-20", { spend: "10.00" })], fields: ALL_FIELDS };
  ads = [
    { ad_id: "1801", ad_name: "Ad 1801", video_id: "v1", image_ids: ["cover/1"], ad_format: "SINGLE_VIDEO" },
    { ad_id: "1802", ad_name: "Ad 1802", video_id: "v1", ad_format: "SINGLE_VIDEO" },
    { ad_id: "1803", ad_name: "Ad 1803", image_ids: ["img/1"], ad_format: "SINGLE_IMAGE" },
  ];
  videos = { v1: { duration: 14.6, width: 720, height: 1280, video_cover_url: "https://p16-common-sign.tiktokcdn.com/v1.jpeg?x-expires=1&x-signature=s" } };
  await run(`TRUNCATE sync_runs, tiktok_daily_metrics, tiktok_ad_daily_metrics, tiktok_ad_creatives, tiktok_creative_assets, clients RESTART IDENTITY CASCADE`);
  await run(`INSERT INTO clients (id, name, slug, timezone) VALUES ('${CLIENT_ID}', 'Acme', 'acme', '${TZ}')`);
  activeAccounts = [{ id: "cccccccc-0000-4000-8000-000000000001", clientId: CLIENT_ID, advertiserId: ADV, currency: "USD", status: "active", accessTokenEncrypted: encrypt("tok") }];
});

describe("the ad-level pass", () => {
  it("🔴 writes one row per ad per day, each under its creative — and never the spend table", async () => {
    const res = await pass();
    expect(res.rowsWritten).toBe(3);
    expect(await rows()).toEqual([
      // Two ads, one video: one creative.
      { tiktok_ad_id: "1801", date: "2026-10-20", creative_key: "v:v1", creative_type: "video", spend: 40 },
      { tiktok_ad_id: "1802", date: "2026-10-20", creative_key: "v:v1", creative_type: "video", spend: 40 },
      { tiktok_ad_id: "1803", date: "2026-10-20", creative_key: "i:img/1", creative_type: "image", spend: 10 },
    ]);
    // Its readers sum this with no level filter: ad rows there would double TikTok spend.
    expect((await run(`SELECT count(*)::int AS n FROM tiktok_daily_metrics`)).rows[0].n).toBe(0);
    expect(await runs()).toEqual([expect.objectContaining({ kind: "tiktok_adlevel", status: "success", rows_written: 3 })]);
  });

  it("stores Results and the extras in raw, as the campaign table does", async () => {
    await pass();
    const [row] = (await run(`SELECT raw->'results' AS results, raw->'x' AS x FROM tiktok_ad_daily_metrics WHERE tiktok_ad_id = '1801'`)).rows;
    expect(row.results).toEqual({ value: 4, objective: "LEAD_GENERATION" });
    expect(row.x).toMatchObject({ likes: 12, video_views: 900, video_2s: 500 });
  });

  it("leaves a refused extra out of the row, so it reads as not collected rather than 0", async () => {
    report = { rows: [adDay("1801")], fields: ALL_FIELDS.filter((f) => f !== "likes" && f !== "result") };
    await pass();
    const [row] = (await run(`SELECT raw->'x' AS x, raw ? 'results' AS has_results FROM tiktok_ad_daily_metrics`)).rows;
    expect(row.x).not.toHaveProperty("likes");
    expect(row.x).toHaveProperty("video_views");
    expect(row.has_results).toBe(false);
  });

  it("asks TikTok for each ad's identity once, by id", async () => {
    await pass();
    expect(asked.filter((a) => a.method === "ads").map((a) => a.ids)).toEqual([["1801", "1802", "1803"]]);
    const stored = (await run(`SELECT tiktok_ad_id, creative_key, thumb_key, video_id FROM tiktok_ad_creatives ORDER BY tiktok_ad_id`)).rows;
    expect(stored).toEqual([
      { tiktok_ad_id: "1801", creative_key: "v:v1", thumb_key: "v:v1", video_id: "v1" },
      { tiktok_ad_id: "1802", creative_key: "v:v1", thumb_key: "v:v1", video_id: "v1" },
      { tiktok_ad_id: "1803", creative_key: "i:img/1", thumb_key: "i:img/1", video_id: null },
    ]);
  });

  it("🔴 keeps an ad's creative on a night TikTok will not describe it, and says so on the run", async () => {
    await pass();
    ads = new Error("TikTok error 51021");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await pass();
    expect(res.rowsWritten).toBe(3);
    expect((await rows()).map((r) => r.creative_key)).toEqual(["v:v1", "v:v1", "i:img/1"]);
    const last = (await runs()).at(-1)!;
    expect(last.status).toBe("success");
    expect((last.meta as { failures?: string[] }).failures).toEqual([expect.stringMatching(/^ads: TikTok error 51021/)]);
  });

  it("names rows written before their ad was known", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    ads = new Error("unavailable");
    await pass();
    expect((await rows()).map((r) => r.creative_key)).toEqual(["", "", ""]);
    ads = [{ ad_id: "1801", video_id: "v1" }, { ad_id: "1802", video_id: "v1" }, { ad_id: "1803", image_ids: ["img/1"] }];
    // An older day this pass no longer pulls is named too.
    report = { rows: [adDay("1801", "2026-10-21")], fields: ALL_FIELDS };
    await pass();
    expect((await rows()).map((r) => [r.tiktok_ad_id, r.date, r.creative_key])).toEqual([
      ["1801", "2026-10-20", "v:v1"],
      ["1801", "2026-10-21", "v:v1"],
      ["1802", "2026-10-20", ""],
      ["1803", "2026-10-20", ""],
    ]);
  });

  it("🔴 fails the run, and writes nothing, when the ad report itself fails", async () => {
    report = new Error("max time span is 30 days");
    await expect(pass()).rejects.toThrow(/30 days/);
    expect(await rows()).toEqual([]);
    expect((await runs())[0]).toMatchObject({ kind: "tiktok_adlevel", status: "failed" });
  });
});

describe("pictures", () => {
  it("🔴 stores the cover's bytes for each asset that spent, and does not fetch it again", async () => {
    await pass();
    const assets = (await run(`SELECT asset_key, kind, duration_seconds::float AS duration, thumb IS NOT NULL AS has_thumb, raw FROM tiktok_creative_assets ORDER BY asset_key`)).rows;
    expect(assets.map((a) => [a.asset_key, a.kind, a.duration, a.has_thumb])).toEqual([
      ["i:img/1", "image", null, true],
      ["v:v1", "video", 14.6, true],
    ]);
    // The signed URL is never kept.
    expect(JSON.stringify(assets.map((a) => a.raw))).not.toMatch(/https?:|signature/);

    fetched.length = 0;
    asked.length = 0;
    await pass();
    expect(fetched).toEqual([]);
    expect(asked.some((a) => a.method === "videos" || a.method === "images")).toBe(false);
  });

  it("asks a video ad's video, never its cover image, of the image endpoint", async () => {
    await pass();
    // TikTok refuses a video's cover image there, failing the whole batch.
    expect(asked.filter((a) => a.method === "images").flatMap((a) => a.ids)).toEqual(["img/1"]);
  });

  it("keeps an asset's length when its picture could not be fetched, and asks again next run", async () => {
    picture = () => null;
    await pass();
    const [v] = (await run(`SELECT duration_seconds::float AS duration, thumb IS NULL AS no_thumb FROM tiktok_creative_assets WHERE asset_key = 'v:v1'`)).rows;
    expect(v).toEqual({ duration: 14.6, no_thumb: true });
    expect(((await runs())[0].meta as { failures?: string[] }).failures).toEqual(["pictures: 2 could not be fetched"]);

    picture = (url) => ({ bytes: Buffer.from(url), contentType: "image/jpeg" });
    fetched.length = 0;
    await pass();
    expect(fetched).toHaveLength(2);
  });

  it("stops fetching pictures at the run's deadline — the rows never wait on them", async () => {
    const res = await pass(Date.now() - 1);
    expect(res.rowsWritten).toBe(3);
    expect(fetched).toEqual([]);
  });
});

describe("importTiktokAdLevelHistory", () => {
  const byMonth = (since: string) => ({ rows: [adDay("1801", since)], fields: ALL_FIELDS });

  it("🔴 imports newest month first, names its ads, and writes no sync run", async () => {
    report = byMonth;
    const res = await mod.importTiktokAdLevelHistory(client, { days: 60 });
    expect(res.done).toBe(true);
    const windows = asked.filter((a) => a.method === "report").map((a) => a.since!);
    expect(windows.length).toBeGreaterThanOrEqual(2);
    expect([...windows].sort().reverse()).toEqual(windows);
    expect(new Set((await rows()).map((r) => r.creative_key))).toEqual(new Set(["v:v1"]));
    // A failed month from last year must not mark anything broken.
    expect(await runs()).toEqual([]);
  });

  it("skips a month whose ad rows already add up to its campaign rows", async () => {
    report = byMonth;
    const first = await mod.importTiktokAdLevelHistory(client, { days: 20 });
    const month = first.months[0];
    const since = asked.find((a) => a.method === "report")!.since!;
    await run(`INSERT INTO tiktok_daily_metrics (client_id, advertiser_id, date, tiktok_campaign_id, spend)
               VALUES ('${CLIENT_ID}', '${ADV}', '${since}', '1600000000000001', 40)`);
    asked.length = 0;
    const again = await mod.importTiktokAdLevelHistory(client, { days: 20 });
    expect(again.months[0]).toEqual({ month: month.month, status: "complete", rows: 0 });
    expect(asked.some((a) => a.method === "report" && a.since === since)).toBe(false);
  });

  it("🔴 stops at its budget and carries on from there", async () => {
    report = byMonth;
    const first = await mod.importTiktokAdLevelHistory(client, { days: 60, budgetMs: -1 });
    expect(first.done).toBe(false);
    expect(first.months).toEqual([]);
    expect(first.nextBefore).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const rest = await mod.importTiktokAdLevelHistory(client, { days: 60, before: first.nextBefore! });
    expect(rest.done).toBe(true);
    expect(rest.months.length).toBeGreaterThanOrEqual(2);
  });

  it("asks TikTok for each ad's identity once across the months", async () => {
    report = byMonth;
    await mod.importTiktokAdLevelHistory(client, { days: 60 });
    expect(asked.filter((a) => a.method === "ads").map((a) => a.ids)).toEqual([["1801"]]);
  });
});

describe("pictures an earlier run left missing", () => {
  const COVER = "http://p16-common-sign.tiktokcdn.com/v0.jpeg?x-expires=1";

  /** An ad identified on an earlier run whose asset was stored without its picture. */
  async function earlierAd(ad: string, video: string, spend = 0) {
    await run(`INSERT INTO tiktok_ad_creatives (client_id, advertiser_id, tiktok_ad_id, ad_name, creative_key, creative_type, thumb_key, video_id)
               VALUES ('${CLIENT_ID}', '${ADV}', '${ad}', 'Ad ${ad}', 'v:${video}', 'video', 'v:${video}', '${video}')`);
    await run(`INSERT INTO tiktok_creative_assets (client_id, advertiser_id, asset_key, kind, video_id, duration_seconds)
               VALUES ('${CLIENT_ID}', '${ADV}', 'v:${video}', 'video', '${video}', 12)`);
    if (spend > 0) {
      await run(`INSERT INTO tiktok_ad_daily_metrics (client_id, advertiser_id, date, tiktok_ad_id, creative_key, creative_type, spend)
                 VALUES ('${CLIENT_ID}', '${ADV}', '2026-01-10', '${ad}', 'v:${video}', 'video', ${spend})`);
    }
  }
  const pictured = async (key: string) =>
    (await run(`SELECT (thumb IS NOT NULL) AS p FROM tiktok_creative_assets WHERE asset_key = '${key}'`)).rows[0]?.p;

  it("🔴 the nightly pass fetches them for ads that no longer run", async () => {
    await earlierAd("1790", "v0");
    videos.v0 = { duration: 12, width: 720, height: 1280, video_cover_url: COVER };
    await pass();
    expect(await pictured("v:v0")).toBe(true);
    expect(fetched).toContain(COVER);
  });

  it("🔴 the import fetches them first — before any month, which may all be complete", async () => {
    await earlierAd("1790", "v0", 25);
    videos.v0 = { duration: 12, width: 720, height: 1280, video_cover_url: COVER };
    report = { rows: [], fields: ALL_FIELDS };
    await mod.importTiktokAdLevelHistory(client, { days: 20 });
    expect(asked[0]).toEqual({ method: "videos", ids: ["v0"] });
    expect(fetched[0]).toBe(COVER);
    expect(await pictured("v:v0")).toBe(true);
  });

  it("asks only for those still missing, and posts never", async () => {
    await earlierAd("1790", "v0");
    await run(`UPDATE tiktok_creative_assets SET thumb = '\\xffd8'::bytea, thumb_content_type = 'image/jpeg' WHERE asset_key = 'v:v0'`);
    await run(`INSERT INTO tiktok_ad_creatives (client_id, advertiser_id, tiktok_ad_id, creative_key, creative_type, thumb_key)
               VALUES ('${CLIENT_ID}', '${ADV}', '1791', 'p:7290000000000000001', 'video', 'p:7290000000000000001')`);
    report = { rows: [], fields: ALL_FIELDS };
    await mod.importTiktokAdLevelHistory(client, { days: 20 });
    expect(asked.filter((a) => a.method === "videos" || a.method === "images")).toEqual([]);
  });

  it("never fails the run when the picture cannot be fetched", async () => {
    await earlierAd("1790", "v0");
    videos.v0 = { duration: 12, video_cover_url: COVER };
    picture = () => null;
    await pass();
    const [r] = await runs();
    expect(r).toMatchObject({ kind: "tiktok_adlevel", status: "success" });
    expect(await pictured("v:v0")).toBe(false);
  });
});
