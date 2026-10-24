import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, CLIENT_A, CLIENT_B, type TestDb } from "./__testdb__/harness";
import { windowFromKeys } from "@/lib/dates";

/**
 * Each platform's own "Results" against a real Postgres.
 *
 * The rows below are shaped exactly like the live API answers recorded on 24 Oct
 * 2026: Meta's `results` list with an indicator even on a zero day, TikTok's
 * per-campaign `{ value, objective }` summed from the ad group report, Google's
 * fractional Conversions column. What must never happen: two result types added
 * together, spend multiplied by a mixed row, or one odd value failing the
 * statement.
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
  await harness.db.execute(sql`DELETE FROM google_daily_metrics`);
  await harness.db.execute(sql`DELETE FROM tiktok_daily_metrics`);
});

const res = (indicator: string, value?: string) =>
  value === undefined
    ? { indicator }
    : { indicator, values: [{ value, attribution_windows: ["default"] }] };

async function meta(f: {
  date: string;
  campaign?: string;
  name?: string;
  level?: "campaign" | "ad";
  ad?: string;
  spend: number;
  results?: unknown;
  client?: string;
}) {
  const raw = f.results === undefined ? null : JSON.stringify({ results: f.results });
  await harness.db.execute(sql`
    INSERT INTO fb_daily_metrics (client_id, date, level, meta_campaign_id, campaign_name, meta_ad_id, ad_name, spend, raw)
    VALUES (${f.client ?? CLIENT_A}, ${f.date}, ${f.level ?? "campaign"}, ${f.campaign ?? "c1"},
            ${f.name ?? null}, ${f.ad ?? ""}, ${f.ad ? `Ad ${f.ad}` : null}, ${f.spend}, ${raw}::jsonb)
  `);
}

const byKey = (rows: Array<{ byType: Array<{ type: { key: string }; count: number; spend: number; pricedCount: number }> }>) =>
  Object.fromEntries(
    (rows[0]?.byType ?? []).map((t) => [
      t.type.key,
      t.pricedCount === t.count ? { count: t.count, spend: t.spend } : { count: t.count, spend: t.spend, priced: t.pricedCount },
    ]),
  );

describe("Meta results", () => {
  it("🔴 counts per type and never adds two types together", async () => {
    await meta({ date: "2026-09-01", campaign: "lead", spend: 100, results: [res("actions:offsite_conversion.fb_pixel_lead", "3")] });
    await meta({ date: "2026-09-02", campaign: "lead", spend: 50, results: [res("actions:offsite_conversion.fb_pixel_lead", "2")] });
    await meta({ date: "2026-09-01", campaign: "traffic", spend: 10, results: [res("actions:omni_landing_page_view", "40")] });

    const [total] = await bq.getPlatformResults("meta", CLIENT_A, SEPT, "total");
    expect(byKey([total])).toEqual({
      "offsite_conversion.fb_pixel_lead": { count: 5, spend: 150 },
      omni_landing_page_view: { count: 40, spend: 10 },
    });
    expect(total.spend).toBe(160);
    expect(total.mixedSpend).toBe(0);
  });

  it("keeps a zero day's spend on its type — the indicator is there without values", async () => {
    await meta({ date: "2026-09-01", spend: 80, results: [res("actions:offsite_conversion.fb_pixel_lead")] });
    await meta({ date: "2026-09-02", spend: 20, results: [res("actions:offsite_conversion.fb_pixel_lead", "1")] });
    const [total] = await bq.getPlatformResults("meta", CLIENT_A, SEPT, "total");
    // $100 for 1 lead, as Ads Manager reports it — not $20 for 1.
    expect(byKey([total])).toEqual({ "offsite_conversion.fb_pixel_lead": { count: 1, spend: 100 } });
  });

  it("🔴 never multiplies spend on a row with two types; the spend goes to neither", async () => {
    await meta({
      date: "2026-09-01",
      spend: 90,
      results: [res("actions:lead", "4"), res("actions:onsite_conversion.messaging_conversation_started_7d", "6")],
    });
    const [total] = await bq.getPlatformResults("meta", CLIENT_A, SEPT, "total");
    expect(total.spend).toBe(90);
    expect(total.mixedSpend).toBe(90);
    // Counted, but priced on nothing: the mixed day's results are in no cost.
    expect(byKey([total])).toEqual({
      lead: { count: 4, spend: 0, priced: 0 },
      "onsite_conversion.messaging_conversation_started_7d": { count: 6, spend: 0, priced: 0 },
    });
  });

  it("merges aliases of one type, and shrugs off junk without failing", async () => {
    await meta({ date: "2026-09-01", spend: 5, results: [res("actions:landing_page_view", "4")] });
    await meta({ date: "2026-09-02", spend: 5, results: [res("actions:omni_landing_page_view", "6")] });
    await meta({ date: "2026-09-03", spend: 5, results: [res("actions:omni_landing_page_view", "lots")] });
    await meta({ date: "2026-09-04", spend: 5, results: [{ values: [{ value: "9" }] }, "nonsense", 7] });
    const [total] = await bq.getPlatformResults("meta", CLIENT_A, SEPT, "total");
    expect(byKey([total])).toEqual({ omni_landing_page_view: { count: 10, spend: 15 } });
  });

  it("names rows stored before results were requested, and still counts their spend", async () => {
    await meta({ date: "2026-09-01", spend: 40 }); // raw is null
    await meta({ date: "2026-09-02", spend: 60, results: { not: "an array" } });
    const [total] = await bq.getPlatformResults("meta", CLIENT_A, SEPT, "total");
    expect(total.rowsWithoutResults).toBe(2);
    expect(total.spend).toBe(100);
    expect(total.byType).toEqual([]);
  });

  it("splits by day and campaign, reads only its level, and only its client", async () => {
    await meta({ date: "2026-09-01", campaign: "a", name: "Old name", spend: 10, results: [res("actions:lead", "1")] });
    await meta({ date: "2026-09-03", campaign: "a", name: "Spring leads", spend: 10, results: [res("actions:lead", "2")] });
    await meta({ date: "2026-09-01", level: "ad", ad: "x", spend: 999, results: [res("actions:lead", "99")] });
    await meta({ date: "2026-09-01", client: CLIENT_B, spend: 999, results: [res("actions:lead", "99")] });

    const camps = await bq.getPlatformResults("meta", CLIENT_A, SEPT, "campaign");
    expect(camps).toHaveLength(1);
    expect(camps[0].label).toBe("Spring leads");
    expect(byKey(camps)).toEqual({ lead: { count: 3, spend: 20 } });

    const days = await bq.getPlatformResults("meta", CLIENT_A, SEPT, "day");
    expect(days.map((d) => d.key).sort()).toEqual(["2026-09-01", "2026-09-03"]);

    const ads = await bq.getPlatformResults("meta", CLIENT_A, SEPT, "ad");
    expect(ads).toHaveLength(1);
    expect(ads[0].parent).toBeNull();
    expect(byKey(ads)).toEqual({ lead: { count: 99, spend: 999 } });
  });
});

describe("Google results", () => {
  it("are the Conversions column, fractions kept, one type", async () => {
    await harness.db.execute(sql`
      INSERT INTO google_daily_metrics (client_id, date, google_campaign_id, campaign_name, spend, conversions)
      VALUES (${CLIENT_A}, '2026-09-01', 'g1', 'Search', 30, 1.5),
             (${CLIENT_A}, '2026-09-02', 'g1', 'Search', 20, 2.25)
    `);
    const [total] = await bq.getPlatformResults("google", CLIENT_A, SEPT, "total");
    expect(byKey([total])).toEqual({ "google:conversions": { count: 3.75, spend: 50 } });
    expect(await bq.getPlatformResults("google", CLIENT_A, SEPT, "ad")).toEqual([]);
  });
});

describe("TikTok results", () => {
  it("read the per-campaign results the sync summed from the ad group report", async () => {
    const row = (date: string, spend: number, raw: unknown) => sql`
      INSERT INTO tiktok_daily_metrics (client_id, date, tiktok_campaign_id, campaign_name, spend, raw)
      VALUES (${CLIENT_A}, ${date}, 't1', 'Leads', ${spend}, ${JSON.stringify(raw)}::jsonb)`;
    await harness.db.execute(row("2026-09-01", 100, { metrics: { objective_type: "LEAD_GENERATION" }, results: { value: 48, objective: "LEAD_GENERATION" } }));
    await harness.db.execute(row("2026-09-02", 50, { metrics: { objective_type: "LEAD_GENERATION" }, results: { value: 0, objective: null } }));
    await harness.db.execute(row("2026-09-03", 25, { metrics: { conversion: "3" } })); // before results existed

    const [total] = await bq.getPlatformResults("tiktok", CLIENT_A, SEPT, "total");
    // The second day's null objective falls back to the campaign row's own.
    expect(byKey([total])).toEqual({ "tiktok:LEAD_GENERATION": { count: 48, spend: 150 } });
    expect(total.rowsWithoutResults).toBe(1);
    expect(total.spend).toBe(175);
  });
});

describe("Meta results per creative", () => {
  it("group ad rows by asset, and by (ad, asset) pair — Meta only", async () => {
    const adRow = (ad: string, key: string, date: string, value: string) => sql`
      INSERT INTO fb_daily_metrics (client_id, date, level, meta_campaign_id, meta_ad_id, ad_name, creative_key, spend, raw)
      VALUES (${CLIENT_A}, ${date}, 'ad', 'c1', ${ad}, ${"Ad " + ad}, ${key}, 10,
              ${JSON.stringify({ results: [res("actions:onsite_conversion.lead_grouped", value)] })}::jsonb)`;
    await harness.db.execute(adRow("a1", "vid", "2026-09-01", "2"));
    await harness.db.execute(adRow("a2", "vid", "2026-09-01", "3"));
    await harness.db.execute(adRow("a3", "img", "2026-09-02", "1"));
    // A campaign row of the same day: never counted per creative.
    await meta({ date: "2026-09-01", spend: 999, results: [res("actions:onsite_conversion.lead_grouped", "99")] });

    const byCreative = await bq.getPlatformResults("meta", CLIENT_A, SEPT, "creative");
    expect(Object.fromEntries(byCreative.map((r) => [r.key, r.byType[0]?.count]))).toEqual({ vid: 5, img: 1 });

    const byPair = await bq.getPlatformResults("meta", CLIENT_A, SEPT, "ad_creative");
    expect(byPair.map((r) => r.key).sort()).toEqual(["a1|vid", "a2|vid", "a3|img"]);

    expect(await bq.getPlatformResults("google", CLIENT_A, SEPT, "creative")).toEqual([]);
    expect(await bq.getPlatformResults("tiktok", CLIENT_A, SEPT, "ad_creative")).toEqual([]);
  });
});
