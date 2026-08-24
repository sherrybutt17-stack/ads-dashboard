import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, CLIENT_A, CLIENT_B, type TestDb } from "./__testdb__/harness";
import { windowFromKeys } from "@/lib/dates";
import { EMPTY_ADS, derive } from "./compute";

/**
 * The query layer, tested against a real Postgres.
 *
 * These assertions are about JOIN cardinality and GROUP BY scope — the rules
 * that decide whether a number is right, and the only rules in this codebase
 * that neither the typechecker nor a pure unit test can see. Every one of them
 * corresponds to a way a plausible-looking query silently produces a wrong
 * figure:
 *
 *   · group by ad id  → one creative's spend split N ways, CPL reads N× too low
 *   · fan out by ad   → one deal's revenue multiplied N times
 *   · forget `level`  → campaign rows swept into a creative aggregate
 *   · forget client   → one tenant's money in another tenant's dashboard
 *
 * The real `getCreativePerformance` / `getCreativeRevenue` run here, not a copy
 * of their SQL, so the test cannot drift away from the code it protects.
 */

let harness: { db: TestDb; close: () => Promise<void> };

// `@/db` reads DATABASE_URL at import time and opens a network pool. Swap it for
// the in-process Postgres BEFORE the query module is imported.
vi.mock("@/db", () => ({
  get db() {
    return harness.db;
  },
  schema: {},
}));

let q: typeof import("./queries");

const TZ = "America/Los_Angeles";
const range = () => windowFromKeys("2026-08-01", "2026-08-31", TZ);

beforeAll(async () => {
  harness = await createTestDb();
  q = await import("./queries");
  await seed(harness.db);
});

afterAll(async () => {
  await harness?.close();
});

/* ------------------------------------------------------------------ *
 * Fixture
 * ------------------------------------------------------------------ *
 *
 * ONE video (vid_a) running as THREE ads (ad1, ad2, ad3) across TWO ad sets,
 * plus an image (img_b), a Dynamic Creative ad with no single identity, a row
 * outside the range, a campaign-level row, and a second tenant.
 */
async function seed(db: TestDb) {
  const metric = (o: Record<string, unknown>) => ({
    client_id: CLIENT_A,
    date: "2026-08-01",
    level: "ad",
    meta_campaign_id: "c1",
    campaign_name: "Camp One",
    meta_adset_id: "as1",
    meta_ad_id: "ad1",
    creative_key: "vid_a",
    creative_type: "video",
    impressions: 0,
    video_3s_views: 0,
    video_plays: 0,
    thru_plays: 0,
    link_clicks: 0,
    landing_page_views: 0,
    outbound_clicks: 0,
    clicks_all: 0,
    spend: "0",
    leads_total: 0,
    ...o,
  });

  const rows = [
    metric({ meta_ad_id: "ad1", impressions: 1000, video_3s_views: 300, video_plays: 990, thru_plays: 100, link_clicks: 40, landing_page_views: 25, spend: "10.00", leads_total: 2, quality_ranking: "average" }),
    metric({ meta_ad_id: "ad2", date: "2026-08-02", impressions: 1200, video_3s_views: 400, video_plays: 1180, thru_plays: 140, link_clicks: 50, landing_page_views: 31, spend: "12.00", leads_total: 3, quality_ranking: "above_average" }),
    metric({ meta_ad_id: "ad3", date: "2026-08-02", meta_adset_id: "as2", campaign_name: "Camp Two", impressions: 800, video_3s_views: 210, video_plays: 780, thru_plays: 70, link_clicks: 30, spend: "8.00", leads_total: 1 }),
    metric({ meta_ad_id: "ad4", creative_key: "img_b", creative_type: "image", impressions: 500, link_clicks: 22, landing_page_views: 15, spend: "5.00", leads_total: 1, quality_ranking: "unknown" }),
    // Dynamic Creative — no single asset served the spend.
    metric({ meta_ad_id: "ad5", meta_adset_id: "as3", creative_key: "", creative_type: "carousel", impressions: 900, link_clicks: 30, spend: "9.00", leads_total: 2 }),
    // Outside the window.
    metric({ meta_ad_id: "ad1", date: "2026-07-01", impressions: 9999, video_3s_views: 9999, spend: "999.00", leads_total: 99 }),
    // Campaign-level row: the same money, reported at a different level.
    metric({ level: "campaign", meta_adset_id: "", meta_ad_id: "", creative_key: "", creative_type: "unknown", impressions: 4400, spend: "44.00", leads_total: 9 }),
    /*
     * An AD-SET-level row that carries a creative key.
     *
     * Today's sync writes only campaign and ad levels, and campaign rows carry
     * an empty key — so without this row `level = 'ad'` and `creative_key <> ''`
     * exclude exactly the same rows and neither filter is separately provable.
     * One of them is semantic (only ad rows describe a single asset), the other
     * incidental. Ad-set level is the realistic way that stops being true, since
     * `insight_level` already has the value and an ad set carrying one creative
     * would populate the key. This row is what fails first if it lands.
     */
    metric({ level: "adset", date: "2026-08-03", meta_ad_id: "", creative_key: "vid_a", impressions: 5000, link_clicks: 500, spend: "50.00", leads_total: 5 }),
    // A different tenant, same creative key — must never appear in A's numbers.
    metric({ client_id: CLIENT_B, meta_ad_id: "b_ad", impressions: 7777, spend: "777.00", leads_total: 77 }),
  ];

  for (const r of rows) {
    const cols = Object.keys(r);
    await db.execute(
      sql.raw(
        `INSERT INTO fb_daily_metrics (${cols.join(",")}) VALUES (${cols
          .map((c) => literal((r as Record<string, unknown>)[c]))
          .join(",")})`,
      ),
    );
  }

  const creatives = [
    { meta_ad_id: "ad1", ad_name: "Ad 1", creative_key: "vid_a", title: "Old headline", body: "Old body", thumbnail_url: "https://cdn/old.jpg", video_length_seconds: "22.5", learning_stage: "SUCCESS", status: "ACTIVE", synced_at: "2026-08-10T00:00:00Z" },
    { meta_ad_id: "ad2", ad_name: "Ad 2", creative_key: "vid_a", title: "New headline", body: null, thumbnail_url: "https://cdn/new.jpg", video_length_seconds: "22.5", learning_stage: "LEARNING", status: "ACTIVE", synced_at: "2026-08-12T00:00:00Z" },
    { meta_ad_id: "ad3", ad_name: "Ad 3", creative_key: "vid_a", title: null, body: null, thumbnail_url: null, video_length_seconds: "22.5", learning_stage: "LEARNING_LIMITED", status: "PAUSED", synced_at: "2026-08-11T00:00:00Z" },
    { meta_ad_id: "ad4", ad_name: "Ad 4", creative_key: "img_b", title: "Image ad", body: "Image body", thumbnail_url: "https://cdn/img.jpg", video_length_seconds: null, learning_stage: "SUCCESS", status: "ACTIVE", synced_at: "2026-08-12T00:00:00Z" },
  ];
  for (const c of creatives) {
    const r = { client_id: CLIENT_A, creative_type: "video", ...c };
    const cols = Object.keys(r);
    await db.execute(
      sql.raw(
        `INSERT INTO meta_ad_creatives (${cols.join(",")}) VALUES (${cols
          .map((k) => literal((r as Record<string, unknown>)[k]))
          .join(",")})`,
      ),
    );
  }
}

function literal(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

/* ------------------------------------------------------------------ */

describe("getCreativePerformance", () => {
  it("collapses one asset running in many ads into ONE row", async () => {
    const rows = await q.getCreativePerformance(CLIENT_A, range());
    const vid = rows.find((r) => r.creativeKey === "vid_a")!;

    expect(vid).toBeDefined();
    expect(vid.adCount).toBe(3);
    expect(vid.adsetCount).toBe(2);
    /*
     * THE assertion. Grouping by ad id would give three rows at $10, $12 and $8,
     * each with a third of the leads — the ratio survives, every absolute figure
     * is wrong, and the creative never reaches the top of a leaderboard sorted
     * by spend because its budget was divided three ways.
     */
    expect(vid.totals.spend).toBeCloseTo(30);
    expect(vid.totals.leads).toBe(6);
    expect(vid.totals.video3sViews).toBe(910);
  });

  it("excludes rows outside the window", async () => {
    // The July row carries $999 and 99 leads; if the range filter were wrong it
    // would dominate every figure above.
    const rows = await q.getCreativePerformance(CLIENT_A, range());
    expect(rows.find((r) => r.creativeKey === "vid_a")!.totals.spend).toBeCloseTo(30);
  });

  it("never sweeps campaign-level rows into a creative aggregate", async () => {
    // The campaign row reports the SAME $44 as its ads, at a different level.
    // Counting both would double the account's spend.
    const rows = await q.getCreativePerformance(CLIENT_A, range());
    const unresolved = rows.find((r) => r.creativeKey === "")!;
    expect(unresolved.totals.impressions).toBe(900); // the carousel ad only
    expect(unresolved.totals.spend).toBeCloseTo(9);

    // The `level` filter proved on its own: a campaign row carrying a creative
    // key would otherwise add $50 and 500 clicks to this asset.
    expect(rows.find((r) => r.creativeKey === "vid_a")!.totals.spend).toBeCloseTo(30);
    expect(rows.find((r) => r.creativeKey === "vid_a")!.totals.linkClicks).toBe(120);
  });

  it("keeps the unresolved bucket instead of dropping it", async () => {
    // Dropping it would make the grid's spend silently fail to reconcile with
    // the campaign table.
    const rows = await q.getCreativePerformance(CLIENT_A, range());
    expect(rows.some((r) => r.creativeKey === "")).toBe(true);
  });

  it("does not leak another tenant's spend", async () => {
    const rows = await q.getCreativePerformance(CLIENT_A, range());
    const total = rows.reduce((s, r) => s + r.totals.spend, 0);
    expect(total).toBeCloseTo(30 + 5 + 9); // never 777 more
  });

  it("takes the most recent delivery ranking, and drops 'unknown'", async () => {
    const rows = await q.getCreativePerformance(CLIENT_A, range());
    const vid = rows.find((r) => r.creativeKey === "vid_a")!;
    const img = rows.find((r) => r.creativeKey === "img_b")!;
    // Aug 2 said above_average; Aug 1 said average. A percentile is not averageable.
    expect(vid.qualityRanking).toBe("above_average");
    // 'unknown' means "not enough delivery to judge", not "average".
    expect(img.qualityRanking).toBeNull();
  });

  it("prefers the newest creative metadata but never lets a newer NULL blank it", async () => {
    const rows = await q.getCreativePerformance(CLIENT_A, range());
    const vid = rows.find((r) => r.creativeKey === "vid_a")!;
    expect(vid.title).toBe("New headline"); // ad2, newest
    expect(vid.body).toBe("Old body"); // ad1 — ad2's body is NULL
    expect(vid.thumbnailUrl).toBe("https://cdn/new.jpg");
    expect(vid.videoLengthSeconds).toBeCloseTo(22.5);
  });

  it("rolls learning state up pessimistically across every ad using the asset", async () => {
    // One ad set still learning is enough to make the asset's cost per result
    // unrepresentative, so the flag must survive the rollup.
    const rows = await q.getCreativePerformance(CLIENT_A, range());
    const vid = rows.find((r) => r.creativeKey === "vid_a")!;
    expect(vid.learning).toBe(true);
    expect(vid.learningLimited).toBe(true);
    expect(vid.active).toBe(true);
  });

  it("sorts by spend, biggest first", async () => {
    const rows = await q.getCreativePerformance(CLIENT_A, range());
    expect(rows.map((r) => r.creativeKey)).toEqual(["vid_a", "", "img_b"]);
  });
});

/* ------------------------------------------------------------------ *
 * §1e — revenue, appointments and sales cycle per creative
 * ------------------------------------------------------------------ */

/**
 * CRM fixture, seeded lazily so the performance tests above run against a
 * pipeline-free database (proving they don't depend on it).
 *
 *   ad1 (vid_a) → contact 1 → deal $1,000, booked + showed, 10-day cycle
 *   ad2 (vid_a) → contact 2 → deal $3,000, booked + showed, 20-day cycle
 *   ad4 (img_b) → contact 3 → booked, NEVER closed
 *   no ad id    → contact 4 → deal $9,999  (unattributable — the coverage gap)
 */
async function seedCrm(db: TestDb) {
  const mk = async (
    n: number,
    adId: string | null,
    opts: { value?: number; leadAt: string; booked?: string; showed?: string; wonAt?: string },
  ) => {
    const cid = `aaaaaaaa-0000-0000-0000-00000000000${n}`;
    const oid = `bbbbbbbb-0000-0000-0000-00000000000${n}`;
    await db.execute(
      sql.raw(
        `INSERT INTO contacts (id, client_id, ghl_contact_id, meta_ad_id, meta_campaign_id, created_at)
         VALUES ('${cid}','${CLIENT_A}','ghl${n}',${literal(adId)},'c1', now() - interval '5 days')`,
      ),
    );
    await db.execute(
      sql.raw(
        `INSERT INTO opportunities (id, client_id, ghl_opportunity_id, contact_id, status, monetary_value)
         VALUES ('${oid}','${CLIENT_A}','opp${n}','${cid}','${opts.wonAt ? "won" : "open"}',${
           opts.value != null ? opts.value : "NULL"
         })`,
      ),
    );
    const t = async (stage: string, at: string) =>
      db.execute(
        sql.raw(
          `INSERT INTO stage_transitions (client_id, opportunity_id, contact_id, to_canonical, changed_at, source)
           VALUES ('${CLIENT_A}','${oid}','${cid}','${stage}','${at}','webhook')`,
        ),
      );
    await t("new_lead", opts.leadAt);
    if (opts.booked) await t("appointment_booked", opts.booked);
    if (opts.showed) await t("showed", opts.showed);
    if (opts.wonAt) await t("closed_won", opts.wonAt);
  };

  await mk(1, "ad1", {
    value: 1000,
    leadAt: "2026-08-05T12:00:00Z",
    booked: "2026-08-07T12:00:00Z",
    showed: "2026-08-10T12:00:00Z",
    wonAt: "2026-08-15T12:00:00Z",
  });
  await mk(2, "ad2", {
    value: 3000,
    leadAt: "2026-08-01T12:00:00Z",
    booked: "2026-08-04T12:00:00Z",
    showed: "2026-08-09T12:00:00Z",
    wonAt: "2026-08-21T12:00:00Z",
  });
  await mk(3, "ad4", { leadAt: "2026-08-06T12:00:00Z", booked: "2026-08-09T12:00:00Z" });
  await mk(4, null, { value: 9999, leadAt: "2026-08-02T12:00:00Z", wonAt: "2026-08-12T12:00:00Z" });
}

describe("getCreativeFatigueInput", () => {
  it("returns one row per ASSET per day, not per ad", async () => {
    const rows = await q.getCreativeFatigueInput(CLIENT_A, range());
    const vid = rows.find((r) => r.creativeKey === "vid_a")!;

    expect(vid.days.map((d) => d.dateKey)).toEqual(["2026-08-01", "2026-08-02"]);
    /*
     * Aug 2 ran ad2 AND ad3. Per-ad rows would give the engine two 1,000-ish
     * impression days where one 2,000 day happened, and a creative moved
     * between ad sets would read as a collapse followed by a new creative.
     */
    const aug2 = vid.days[1];
    expect(aug2.impressions).toBe(2000);
    expect(aug2.linkClicks).toBe(80);
    expect(aug2.spend).toBeCloseTo(20);
    expect(aug2.adCount).toBe(2);
    expect(vid.days[0].adCount).toBe(1);
  });

  it("🔴 carries the ad count so frequency can refuse to be computed", async () => {
    // Reach is deduplicated people; two ads' reach on one day is not the number
    // of people who saw the asset. The engine needs to know that happened.
    const rows = await q.getCreativeFatigueInput(CLIENT_A, range());
    const vid = rows.find((r) => r.creativeKey === "vid_a")!;
    expect(vid.days.some((d) => d.adCount > 1)).toBe(true);
  });

  it("🔴 excludes the unresolved bucket, unlike the leaderboard", async () => {
    /*
     * `getCreativePerformance` keeps `creative_key = ''` so the grid's spend
     * reconciles with the campaign table. Here it would be wrong: that bucket
     * pools Dynamic Creative and unreadable assets, its composition changes day
     * to day, and a fall in its CTR is a different mix of ads rather than an
     * audience tiring of anything. There is nothing to reshoot.
     */
    const rows = await q.getCreativeFatigueInput(CLIENT_A, range());
    expect(rows.map((r) => r.creativeKey).sort()).toEqual(["img_b", "vid_a"]);
  });

  it("🔴 never sweeps a row from above ad level in", async () => {
    const rows = await q.getCreativeFatigueInput(CLIENT_A, range());
    const total = rows.flatMap((r) => r.days).reduce((s, d) => s + d.spend, 0);
    expect(total).toBeCloseTo(30 + 5); // never + 44, never + 50

    // And specifically: the campaign row carrying `vid_a` on Aug 3 must not
    // appear as a third day for that asset. It is the same money already
    // counted by its ads, and as a day it is roughly twice their size — so it
    // would land in the baseline as a phantom high point and make every real
    // day afterwards look like decline.
    const vid = rows.find((r) => r.creativeKey === "vid_a")!;
    expect(vid.days.map((d) => d.dateKey)).not.toContain("2026-08-03");
  });

  it("respects the window", async () => {
    // The July row carries 9,999 impressions; leaking it would hand the engine
    // a baseline day thirty times the size of a real one.
    const rows = await q.getCreativeFatigueInput(CLIENT_A, range());
    const vid = rows.find((r) => r.creativeKey === "vid_a")!;
    expect(vid.days).toHaveLength(2);
    expect(vid.days.every((d) => d.impressions < 9999)).toBe(true);
  });

  it("attaches identity, preferring the newest non-null", async () => {
    const rows = await q.getCreativeFatigueInput(CLIENT_A, range());
    const vid = rows.find((r) => r.creativeKey === "vid_a")!;
    expect(vid.name).toBe("New headline");
    expect(vid.thumbnailUrl).toBe("https://cdn/new.jpg");
    expect(vid.type).toBe("video");
    expect(vid.active).toBe(true);
    expect(vid.learning).toBe(true); // ad2 is still learning
  });

  it("reads the creative type from the metrics row, per asset", async () => {
    const rows = await q.getCreativeFatigueInput(CLIENT_A, range());
    expect(rows.find((r) => r.creativeKey === "img_b")!.type).toBe("image");
  });

  it("🔴 treats an asset with no creative row as not running", async () => {
    /*
     * Client B has metrics for `vid_a` and no `meta_ad_creatives` row for it —
     * the shape left behind when an ad is deleted in Ads Manager. Defaulting
     * `active` to true would put a deleted asset at the top of a "refresh
     * this" list, which is advice about an ad that no longer exists.
     *
     * Doubles as the tenancy assertion: B's row uses the same creative key as
     * A's, so any client-scoping mistake shows up here as A's identity.
     */
    const rows = await q.getCreativeFatigueInput(CLIENT_B, range());
    expect(rows).toHaveLength(1);
    expect(rows[0].creativeKey).toBe("vid_a");
    expect(rows[0].active).toBe(false);
    expect(rows[0].name).toBe("vid_a"); // falls back to the key, not A's headline
    expect(rows[0].days[0].impressions).toBe(7777);
  });

  it("does not leak one tenant's days into another's", async () => {
    const rows = await q.getCreativeFatigueInput(CLIENT_A, range());
    const vid = rows.find((r) => r.creativeKey === "vid_a")!;
    expect(vid.days.every((d) => d.impressions !== 7777)).toBe(true);
  });
});

describe("getCreativeRevenue", () => {
  beforeAll(async () => {
    await seedCrm(harness.db);
  });

  it("attributes a deal to the CREATIVE, not to the ad that carried it", async () => {
    const { byCreative } = await q.getCreativeRevenue(CLIENT_A, range(), {
      mode: "attributed",
      tag: "",
    });
    const vid = byCreative.get("vid_a")!;
    expect(vid).toBeDefined();
    expect(vid.deals).toBe(2); // ad1 and ad2 both run vid_a
    expect(vid.revenue).toBeCloseTo(4000);
  });

  /*
   * THE fan-out test. `vid_a` is carried by THREE ads. Joining creative_key →
   * its ad ids and then summing would replay each deal once per ad and report
   * $12,000 of revenue that does not exist. Caught during review; this is what
   * keeps it caught.
   */
  it("does not multiply a deal by the number of ads sharing its creative", async () => {
    const { byCreative } = await q.getCreativeRevenue(CLIENT_A, range(), {
      mode: "attributed",
      tag: "",
    });
    const vid = byCreative.get("vid_a")!;
    expect(vid.revenue).toBeCloseTo(4000); // never 12000
    expect(vid.deals).toBe(2); // never 6
  });

  it("keeps a creative that books appointments but never closes", async () => {
    /*
     * The signal the whole section exists for: plenty of bookings, zero
     * revenue. An inner join between deals and stages would delete this row
     * entirely and the creative would look like it simply had no activity.
     */
    const { byCreative } = await q.getCreativeRevenue(CLIENT_A, range(), {
      mode: "attributed",
      tag: "",
    });
    const img = byCreative.get("img_b")!;
    expect(img).toBeDefined();
    expect(img.appointments).toBe(1);
    expect(img.deals).toBe(0);
    expect(img.revenue).toBe(0);
  });

  it("counts shows per creative", async () => {
    const { byCreative } = await q.getCreativeRevenue(CLIENT_A, range(), {
      mode: "attributed",
      tag: "",
    });
    expect(byCreative.get("vid_a")!.showed).toBe(2);
    expect(byCreative.get("img_b")!.showed).toBe(0);
  });

  it("measures the sales cycle from lead-in, not from the window start", async () => {
    // 10 days and 20 days → median 15. A deal that entered the pipeline before
    // the window still has its full cycle measured.
    const { byCreative } = await q.getCreativeRevenue(CLIENT_A, range(), {
      mode: "attributed",
      tag: "",
    });
    expect(byCreative.get("vid_a")!.medianDaysToClose).toBeCloseTo(15, 1);
  });

  it("withholds a median built from a single deal", async () => {
    // A "median" of one is that one deal, and reads as a sales cycle.
    const { byCreative } = await q.getCreativeRevenue(CLIENT_A, range(), {
      mode: "attributed",
      tag: "",
    });
    expect(byCreative.get("img_b")!.medianDaysToClose).toBeNull();
  });

  /*
   * The reason this whole feature ships dark. Coverage is the headline, not a
   * footnote: a caller that renders the map without it publishes "no creative
   * produced a customer", which is a false claim about the ADS rather than a
   * true one about the DATA.
   */
  it("reports how many deals could not be traced to an ad at all", async () => {
    const { coverage } = await q.getCreativeRevenue(CLIENT_A, range(), {
      mode: "attributed",
      tag: "",
    });
    expect(coverage.totalDeals).toBe(3); // contacts 1, 2 and 4 closed
    expect(coverage.attributedDeals).toBe(2); // contact 4 has no ad id
    expect(coverage.attributedDeals).toBeLessThan(coverage.totalDeals);
  });

  it("counts recent contacts carrying an ad id, to show whether the pipe is live now", async () => {
    const { coverage } = await q.getCreativeRevenue(CLIENT_A, range(), {
      mode: "attributed",
      tag: "",
    });
    expect(coverage.recentContacts).toBe(4);
    expect(coverage.recentContactsWithAdId).toBe(3);
  });
});

/* ------------------------------------------------------------------ *
 * §1f — audience breakdowns
 * ------------------------------------------------------------------ */

/**
 * Account spend for August is $30 + $5 + $9 = $44 at ad level, and the
 * campaign-level row says $44 too — `getAdTotals` reads the campaign level, so
 * the yardstick is $44.
 *
 * The age segments below deliberately sum to $38, leaving a $6 gap. That gap is
 * Meta's privacy suppression and it is the single most important thing this
 * section has to communicate.
 */
async function seedBreakdowns(db: TestDb) {
  const row = (
    key: string,
    value: string,
    date: string,
    spend: string,
    leads: number,
    reach: number,
    client = CLIENT_A,
  ) =>
    db.execute(
      sql.raw(
        `INSERT INTO fb_breakdown_metrics
           (client_id, date_start, date_end, level, breakdown_key, segment_value,
            impressions, link_clicks, spend, leads_total, reach)
         VALUES ('${client}','${date}','${date}','account','${key}','${value}',
                 1000, 20, '${spend}', ${leads}, ${reach})`,
      ),
    );

  // age: two days, two brackets — tests that daily rows aggregate to a range.
  await row("age", "25-34", "2026-08-01", "10.00", 3, 500);
  await row("age", "25-34", "2026-08-02", "12.00", 2, 600);
  await row("age", "35-44", "2026-08-01", "16.00", 1, 400);
  // → 25-34 = $22, 35-44 = $16, segmented total $38 against a $44 account.

  await row("gender", "female", "2026-08-01", "30.00", 5, 900);
  await row("gender", "male", "2026-08-01", "14.00", 1, 300);
  // → sums to exactly $44: no gap.

  await row("region", "California", "2026-08-01", "25.00", 5, 700);
  await row("region", "Nevada", "2026-08-01", "9.00", 0, 200);

  /*
   * `device` is sized for the CP-Lead benchmark rather than for the account
   * gap: one segment cheap enough and large enough to call, one dear enough,
   * and one that spent real money for nothing. The lead counts matter as much
   * as the ratios — each has to clear its own noise floor, which is what stops
   * the marker firing on a two-lead row.
   *
   * It deliberately outruns the $44 account total, which incidentally exercises
   * the clamp that keeps `unsegmentedSpend` from going negative.
   */
  await row("device", "mobile", "2026-08-01", "200.00", 25, 3000); // $8 each
  await row("device", "desktop", "2026-08-01", "120.00", 4, 800); // $30 each
  await row("device", "tablet", "2026-08-01", "60.00", 0, 400); // nothing at all

  // Another tenant, same segment values.
  await row("age", "25-34", "2026-08-01", "999.00", 99, 9999, CLIENT_B);
}

describe("getBreakdowns", () => {
  beforeAll(async () => {
    await seedBreakdowns(harness.db);
  });

  it("aggregates daily segment rows across the selected range", async () => {
    // Period-granularity storage would make any range but the exact synced one
    // unreadable, leaving the date picker inert for this whole section.
    const b = await q.getBreakdowns(CLIENT_A, range());
    const age = b.groups.find((g) => g.key === "age")!;
    expect(age.segments.find((s) => s.value === "25-34")!.spend).toBeCloseTo(22);
    expect(age.segments.find((s) => s.value === "35-44")!.spend).toBeCloseTo(16);
  });

  /*
   * THE assertion for this section. Meta suppresses segments below its privacy
   * threshold, so segment rows do not sum to account spend and never will. A
   * reader who adds up the rows, finds them short, and concludes the dashboard
   * is broken is the failure this number exists to prevent.
   */
  it("reports the spend Meta did not break out, rather than hiding it", async () => {
    const b = await q.getBreakdowns(CLIENT_A, range());
    const age = b.groups.find((g) => g.key === "age")!;
    expect(b.totalSpend).toBeCloseTo(44);
    expect(age.segmentedSpend).toBeCloseTo(38);
    expect(age.unsegmentedSpend).toBeCloseTo(6);
  });

  it("reports no gap when the segments do reconcile", async () => {
    const b = await q.getBreakdowns(CLIENT_A, range());
    const gender = b.groups.find((g) => g.key === "gender")!;
    expect(gender.segmentedSpend).toBeCloseTo(44);
    expect(gender.unsegmentedSpend).toBe(0);
  });

  it("never reports a negative gap from Meta's per-row rounding", async () => {
    // Segment sums can very slightly exceed the account total through
    // independent rounding. A negative "unsegmented" figure reads as a bug.
    const b = await q.getBreakdowns(CLIENT_A, range());
    for (const g of b.groups) expect(g.unsegmentedSpend).toBeGreaterThanOrEqual(0);
  });

  /*
   * Reach counts distinct PEOPLE inside one queried window. Summing a segment's
   * daily reach counts a returning viewer once per day; summing across segments
   * counts one person once per placement they saw the ad on. Both overstate,
   * typically 2–5×, so an aggregate declines rather than guesses.
   */
  it("refuses to report reach across a multi-day range", async () => {
    const b = await q.getBreakdowns(CLIENT_A, range());
    const age = b.groups.find((g) => g.key === "age")!;
    expect(b.singleDay).toBe(false);
    expect(age.segments.every((s) => s.reach === null)).toBe(true);
  });

  it("does report reach for a single day, where it is meaningful", async () => {
    const oneDay = windowFromKeys("2026-08-01", "2026-08-01", TZ);
    const b = await q.getBreakdowns(CLIENT_A, oneDay);
    const age = b.groups.find((g) => g.key === "age")!;
    expect(b.singleDay).toBe(true);
    expect(age.segments.find((s) => s.value === "35-44")!.reach).toBe(400);
  });

  it("sorts segments by spend and shares them against the SEGMENTED total", async () => {
    const b = await q.getBreakdowns(CLIENT_A, range());
    const age = b.groups.find((g) => g.key === "age")!;
    expect(age.segments.map((s) => s.value)).toEqual(["25-34", "35-44"]);
    // 22/38, not 22/44 — a share of what was broken out, not of account spend,
    // or the percentages would silently fail to reach 100%.
    expect(age.segments[0].shareOfSegmented).toBeCloseTo(22 / 38);
  });

  it("marks a breakdown Meta never returned as missing, not as zero", async () => {
    const b = await q.getBreakdowns(CLIENT_A, range());
    expect(b.groups.find((g) => g.key === "placement")!.missing).toBe(true);
    expect(b.groups.find((g) => g.key === "age")!.missing).toBe(false);
  });

  it("puts region first — the segment a local business loses most money to", async () => {
    const b = await q.getBreakdowns(CLIENT_A, range());
    expect(b.groups[0].key).toBe("region");
  });

  it("does not leak another tenant's segments", async () => {
    const b = await q.getBreakdowns(CLIENT_A, range());
    const age = b.groups.find((g) => g.key === "age")!;
    expect(age.segments.every((s) => s.spend < 100)).toBe(true);
  });

  it("computes cost per lead per segment, and declines where there are none", async () => {
    const b = await q.getBreakdowns(CLIENT_A, range());
    const region = b.groups.find((g) => g.key === "region")!;
    expect(region.segments.find((s) => s.value === "California")!.cpLead).toBeCloseTo(5);
    // $9 spent in Nevada, zero leads — the silent waste this panel exists to show.
    expect(region.segments.find((s) => s.value === "Nevada")!.cpLead).toBeNull();
  });

  /*
   * The panel average, and the marker measured against it.
   *
   * The column of per-segment cost-per-lead figures was left for the reader to
   * compare by eye, which is the wrong job to hand a person: the rows have
   * wildly different lead counts behind them, so the worst-looking number is
   * very often just the smallest sample.
   */
  it("averages cost per lead across the PANEL, not across the account", async () => {
    /*
     * 🔴 Not `totalSpend / total leads`. Meta withholds segments below its
     * privacy threshold and withholds a different share in each panel — age is
     * $6 short here while gender reconciles exactly — so an account-wide
     * yardstick would judge the same segment differently depending on which
     * panel it appeared in, and could leave every visible row on one side of
     * an average none of them contributed to.
     */
    const b = await q.getBreakdowns(CLIENT_A, range());
    const device = b.groups.find((g) => g.key === "device")!;
    expect(device.segmentedSpend).toBeCloseTo(380);
    expect(device.segmentedLeads).toBe(29);
    expect(device.cpLead).toBeCloseTo(380 / 29);
    // The account figure it is emphatically not.
    expect(b.totalSpend).toBeCloseTo(44);
  });

  it("marks the segments that are genuinely dearer and cheaper than the panel", async () => {
    const b = await q.getBreakdowns(CLIENT_A, range());
    const device = b.groups.find((g) => g.key === "device")!;
    const at = (v: string) => device.segments.find((s) => s.value === v)!;

    expect(at("desktop").benchmark.verdict).toBe("costlier");
    expect(at("mobile").benchmark.verdict).toBe("cheaper");
  });

  it("🔴 calls out spend that bought nothing, where the cost per lead is blank", async () => {
    // The row that most deserves attention is the one whose CP-Lead cell is
    // empty: dividing by zero leaves a dash exactly where the panel's worst
    // number belongs, so pure waste renders as "no data".
    const b = await q.getBreakdowns(CLIENT_A, range());
    const tablet = b.groups
      .find((g) => g.key === "device")!
      .segments.find((s) => s.value === "tablet")!;

    expect(tablet.cpLead).toBeNull();
    expect(tablet.benchmark.verdict).toBe("no_leads");
  });

  it("🔴 stays silent on segments too small to call, rather than judging noise", async () => {
    /*
     * The real risk in adding this marker. A breakdown splits tens of leads a
     * month across up to dozens of rows, so most segments hold one or two
     * leads and their cost per lead is mostly chance. Every region and gender
     * row here sits within its own noise — including Nevada's $9 with nothing
     * to show for it, which expects barely one lead at the panel average — and
     * a marker on any of them would send someone to switch off a segment for a
     * reason that does not exist.
     */
    const b = await q.getBreakdowns(CLIENT_A, range());
    for (const key of ["region", "gender"] as const) {
      const g = b.groups.find((x) => x.key === key)!;
      expect(
        g.segments.filter((s) => s.benchmark.verdict !== "none").map((s) => s.value),
        `${key} marked a segment its lead counts cannot support`,
      ).toEqual([]);
    }
  });

  it("still speaks up on a one-lead segment when the gap is large enough", async () => {
    // The counterweight to the test above: the gate suppresses noise, it does
    // not suppress findings. One lead at $16 against a $6.33 panel is 2.5× the
    // average, which clears even a single arrival's worth of uncertainty.
    const b = await q.getBreakdowns(CLIENT_A, range());
    const age = b.groups.find((g) => g.key === "age")!;
    expect(age.segments.find((s) => s.value === "35-44")!.benchmark.verdict).toBe(
      "costlier",
    );
  });
});

/* ------------------------------------------------------------------ *
 * §5b — disqualified leads and qualified cost per lead
 * ------------------------------------------------------------------ */

describe("qualified leads", () => {
  const CLIENT_D = "44444444-4444-4444-4444-444444444444";

  beforeAll(async () => {
    const db = harness.db;
    const mk = async (
      n: number,
      transitions: Array<[stage: string, at: string]>,
    ) => {
      const cid = `cccccccc-0000-0000-0000-0000000000${String(n).padStart(2, "0")}`;
      const oid = `dddddddd-0000-0000-0000-0000000000${String(n).padStart(2, "0")}`;
      await db.execute(
        sql.raw(
          `INSERT INTO contacts (id, client_id, ghl_contact_id, meta_campaign_id)
           VALUES ('${cid}','${CLIENT_D}','d${n}','c1')`,
        ),
      );
      await db.execute(
        sql.raw(
          `INSERT INTO opportunities (id, client_id, ghl_opportunity_id, contact_id, status)
           VALUES ('${oid}','${CLIENT_D}','dopp${n}','${cid}','open')`,
        ),
      );
      for (const [stage, at] of transitions) {
        await db.execute(
          sql.raw(
            `INSERT INTO stage_transitions (client_id, opportunity_id, contact_id, to_canonical, changed_at, source)
             VALUES ('${CLIENT_D}','${oid}','${cid}','${stage}','${at}','webhook')`,
          ),
        );
      }
    };

    // Four leads arrive in August; two are junk.
    await mk(1, [["new_lead", "2026-08-03T10:00:00Z"]]);
    await mk(2, [["new_lead", "2026-08-04T10:00:00Z"]]);
    await mk(3, [
      ["new_lead", "2026-08-05T10:00:00Z"],
      ["disqualified", "2026-08-06T10:00:00Z"],
    ]);
    await mk(4, [
      ["new_lead", "2026-08-07T10:00:00Z"],
      ["disqualified", "2026-08-08T10:00:00Z"],
    ]);
    /*
     * THE case a subtraction gets wrong: a JULY lead marked junk in AUGUST. It
     * was never in August's lead count, so it must not be removed from it.
     */
    await mk(5, [
      ["new_lead", "2026-07-10T10:00:00Z"],
      ["disqualified", "2026-08-09T10:00:00Z"],
    ]);
  });

  it("counts leads that were real prospects, as its own query", async () => {
    const f = await q.getFunnelCounts(CLIENT_D, range(), undefined, {
      mode: "attributed",
      tag: "",
    });
    expect(f.new_lead).toBe(4); // leads 1–4 arrived in August
    expect(f.disqualified).toBe(3); // leads 3, 4 and the July one were marked
    /*
     * 4 − 3 = 1, which is WRONG. Two August leads were genuine; the third
     * disqualification belongs to a lead that arrived in July and was never part
     * of August's count. A subtraction would understate qualified leads by a
     * third here, and on a quieter month can go negative outright.
     */
    expect(f.new_lead_qualified).toBe(2);
  });

  it("is always a subset of new_lead, so qualified CPL can only be higher", async () => {
    const f = await q.getFunnelCounts(CLIENT_D, range(), undefined, {
      mode: "attributed",
      tag: "",
    });
    expect(f.new_lead_qualified).toBeLessThanOrEqual(f.new_lead);

    const ads = { ...EMPTY_ADS, spend: 100 };
    const d = derive({ ...f }, ads);
    expect(d.cpLead).toBeCloseTo(25); // 100 / 4
    expect(d.cpLeadQualified).toBeCloseTo(50); // 100 / 2 — the honest number
    expect(d.cpLeadQualified!).toBeGreaterThan(d.cpLead!);
  });

  it("falls back to new_lead, and reports no qualified CPL, when nothing is marked", async () => {
    // Every client not using a junk stage. The second number must not appear at
    // all rather than duplicating the first, which would imply a distinction
    // that was never drawn.
    const f = await q.getFunnelCounts(CLIENT_A, range(), undefined, {
      mode: "attributed",
      tag: "",
    });
    expect(f.disqualified).toBe(0);
    expect(f.new_lead_qualified).toBe(f.new_lead);
    expect(derive(f, { ...EMPTY_ADS, spend: 50 }).cpLeadQualified).toBeNull();
  });

  it("keeps disqualified OUT of lost, so close rate is not dragged down", async () => {
    /*
     * The reason for a separate stage rather than reusing `lost`. `lost` means
     * "a real prospect we could not close" and belongs in the close-rate
     * denominator; a wrong number was never winnable. Folding them together
     * makes the sales team look worse and hides the actual signal — that the
     * ads are reaching the wrong people, which is a targeting problem.
     */
    const f = await q.getFunnelCounts(CLIENT_D, range(), undefined, {
      mode: "attributed",
      tag: "",
    });
    expect(f.disqualified).toBe(3);
    expect(f.lost).toBe(0);
  });
});

describe("hasAdLevelData", () => {
  it("distinguishes 'no ads ran' from 'ad-level was never synced'", async () => {
    expect(await q.hasAdLevelData(CLIENT_A)).toBe(true);
    expect(await q.hasAdLevelData("33333333-3333-3333-3333-333333333333")).toBe(false);
  });
});
