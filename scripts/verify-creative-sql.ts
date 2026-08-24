/**
 * Validates the creative-leaderboard SQL against a real Postgres.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 NEVER POINT THIS AT THE PRODUCTION DATABASE, and never at a pooled Neon
 * endpoint (`...-pooler.<region>.aws.neon.tech`).
 *
 * The first version of this script used `CREATE TEMP TABLE fb_daily_metrics`,
 * on the reasoning that temp tables are session-scoped and therefore invisible
 * to everyone else. That reasoning is wrong behind a connection pooler. Neon's
 * pooler multiplexes clients onto a small set of long-lived BACKEND sessions and
 * hands those sessions to whoever asks next, so the temp tables outlived the
 * script, stayed resident in backend pid 2410, and — because `pg_temp` sits
 * ahead of `public` in the search_path — SHADOWED the real `fb_daily_metrics`
 * for every later query that happened to land on that session. Live dashboard
 * loads started failing with `column "clicks_all" does not exist`, intermittently,
 * depending on which session they drew. They had to be dropped by explicit
 * `DROP TABLE "pg_temp_8"."fb_daily_metrics"`; `DISCARD TEMP` did not clear them.
 *
 * Hence the two rules now enforced below:
 *   1. Runs only against `VERIFY_DATABASE_URL`, never `DATABASE_URL`.
 *   2. Refuses a pooled endpoint outright.
 * And the tables are given a `zz_verify_` prefix, so even a leak cannot shadow
 * anything real.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * What it proves — the properties that make the leaderboard correct, none of
 * which a typechecker can see:
 *   · one asset running in three ads across two ad sets collapses to ONE row
 *     with the spend summed, not three rows at a third each
 *   · campaign-level rows never contaminate a creative aggregate
 *   · `unknown` delivery rankings are dropped, not shown as "average"
 *   · the most RECENT ranking wins, rather than an average of percentiles
 *   · a newer ad with a blank headline does not blank out an older real one
 *   · learning state rolls up pessimistically across every ad using the asset
 */
import { Pool } from "@neondatabase/serverless";

const CLIENT = "11111111-1111-1111-1111-111111111111";
const METRICS = "zz_verify_fb_daily_metrics";
const CREATIVES = "zz_verify_meta_ad_creatives";

function connectionString(): string {
  const url = process.env.VERIFY_DATABASE_URL;
  if (!url) {
    console.error(
      "VERIFY_DATABASE_URL is not set.\n\n" +
        "This script creates and drops tables, so it refuses to read DATABASE_URL.\n" +
        "Point it at a scratch database:\n\n" +
        "  VERIFY_DATABASE_URL=postgres://… npx tsx scripts/verify-creative-sql.ts\n",
    );
    process.exit(2);
  }
  if (/-pooler\./i.test(url)) {
    console.error(
      "VERIFY_DATABASE_URL is a POOLED endpoint. Refusing.\n\n" +
        "Session-scoped state survives in a pooler's reused backend sessions and\n" +
        "leaks to other clients. Use the direct (non-pooler) endpoint.\n",
    );
    process.exit(2);
  }
  return url;
}

async function main() {
  const pool = new Pool({ connectionString: connectionString() });
  const c = await pool.connect();

  try {
    await c.query(`DROP TABLE IF EXISTS ${METRICS}, ${CREATIVES}`);
    await c.query(`
      CREATE TABLE ${METRICS} (
        client_id uuid, date date, level text,
        meta_campaign_id text, campaign_name text,
        meta_adset_id text, meta_ad_id text, ad_name text,
        creative_key text, creative_type text,
        impressions bigint, video_3s_views int, video_plays int, thru_plays int,
        video_p25 int, video_p50 int, video_p75 int, video_p95 int, video_p100 int,
        link_clicks int, landing_page_views int, outbound_clicks int,
        spend numeric, leads_total int,
        quality_ranking text, engagement_rate_ranking text, conversion_rate_ranking text
      )
    `);
    await c.query(`
      CREATE TABLE ${CREATIVES} (
        client_id uuid, meta_ad_id text, ad_name text, creative_key text,
        title text, body text, call_to_action_type text, link_url text,
        thumbnail_url text, video_length_seconds numeric,
        learning_stage text, status text, synced_at timestamptz
      )
    `);

    /*
     * THE fixture that matters: ONE video (vid_a) running as THREE ads across
     * TWO ad sets. Correct behaviour collapses it to a single row with $30 of
     * spend. Grouping by ad id instead yields three rows at $10 — the exact bug
     * the creative key exists to prevent.
     */
    const rows: unknown[][] = [
      [CLIENT, "2026-08-01", "ad", "c1", "Camp One", "as1", "ad1", "Ad 1", "vid_a", "video", 1000, 300, 990, 100, 200, 150, 100, 60, 50, 40, 25, 38, "10.00", 2, "average", "above_average", "average"],
      [CLIENT, "2026-08-02", "ad", "c1", "Camp One", "as1", "ad2", "Ad 2", "vid_a", "video", 1200, 400, 1180, 140, 260, 190, 130, 80, 70, 50, 31, 47, "12.00", 3, "above_average", "above_average", "average"],
      [CLIENT, "2026-08-02", "ad", "c1", "Camp Two", "as2", "ad3", "Ad 3", "vid_a", "video", 800, 210, 780, 70, 150, 100, 70, 40, 35, 30, 18, 28, "8.00", 1, null, null, null],
      [CLIENT, "2026-08-01", "ad", "c1", "Camp One", "as1", "ad4", "Ad 4", "img_b", "image", 500, 0, 0, 0, 0, 0, 0, 0, 0, 22, 15, 20, "5.00", 1, "unknown", "unknown", "unknown"],
      [CLIENT, "2026-08-01", "ad", "c1", "Camp One", "as3", "ad5", "Ad 5", "", "carousel", 900, 0, 0, 0, 0, 0, 0, 0, 0, 30, 20, 26, "9.00", 2, null, null, null],
      // Outside the range — must not be counted.
      [CLIENT, "2026-07-01", "ad", "c1", "Camp One", "as1", "ad1", "Ad 1", "vid_a", "video", 9999, 9999, 9999, 9999, 0, 0, 0, 0, 0, 999, 999, 999, "999.00", 99, null, null, null],
      // Campaign-level row — must NEVER be swept into a creative aggregate.
      [CLIENT, "2026-08-01", "campaign", "c1", "Camp One", "", "", null, "", "unknown", 4400, 0, 0, 0, 0, 0, 0, 0, 0, 122, 0, 0, "44.00", 9, null, null, null],
    ];
    for (const r of rows) {
      await c.query(
        `INSERT INTO ${METRICS} VALUES (${r.map((_, i) => `$${i + 1}`).join(",")})`,
        r,
      );
    }

    await c.query(
      `INSERT INTO ${CREATIVES} VALUES
        ($1,'ad1','Ad 1','vid_a','Old headline','Old body','LEARN_MORE','https://x.test/a','https://cdn/old.jpg',22.5,'SUCCESS','ACTIVE', now() - interval '2 days'),
        ($1,'ad2','Ad 2','vid_a','New headline',NULL,'BOOK_TRAVEL','https://x.test/a','https://cdn/new.jpg',22.5,'LEARNING','ACTIVE', now()),
        ($1,'ad3','Ad 3','vid_a',NULL,NULL,NULL,NULL,NULL,22.5,'LEARNING_LIMITED','PAUSED', now() - interval '1 day'),
        ($1,'ad4','Ad 4','img_b','Image ad','Image body','SIGN_UP','https://x.test/b','https://cdn/img.jpg',NULL,'SUCCESS','ACTIVE', now())`,
      [CLIENT],
    );

    // The queries under test, verbatim from `getCreativePerformance` apart from
    // the table names and $-placeholders.
    const metricsSql = `
      SELECT
        m.creative_key,
        MAX(m.creative_type::text)                       AS creative_type,
        COUNT(DISTINCT NULLIF(m.meta_ad_id, ''))::int    AS ad_count,
        COUNT(DISTINCT NULLIF(m.meta_adset_id, ''))::int AS adset_count,
        COALESCE(
          ARRAY_AGG(DISTINCT m.campaign_name) FILTER (WHERE m.campaign_name IS NOT NULL),
          '{}'
        )                                                AS campaign_names,
        COALESCE(SUM(m.impressions), 0)::bigint          AS impressions,
        COALESCE(SUM(m.video_3s_views), 0)::bigint       AS video_3s_views,
        COALESCE(SUM(m.thru_plays), 0)::bigint           AS thru_plays,
        COALESCE(SUM(m.spend), 0)                        AS spend,
        COALESCE(SUM(m.leads_total), 0)::bigint          AS leads,
        (ARRAY_AGG(m.quality_ranking::text ORDER BY m.date DESC)
           FILTER (WHERE m.quality_ranking IS NOT NULL
                     AND m.quality_ranking <> 'unknown'))[1] AS quality_ranking,
        (ARRAY_AGG(m.date::text ORDER BY m.date DESC)
           FILTER (WHERE m.quality_ranking IS NOT NULL
                     AND m.quality_ranking <> 'unknown'))[1] AS ranking_date
      FROM ${METRICS} m
      WHERE m.client_id = $1 AND m.level = 'ad'
        AND m.date >= $2 AND m.date <= $3
      GROUP BY m.creative_key
    `;

    const metaSql = `
      SELECT
        c.creative_key,
        (ARRAY_AGG(c.title ORDER BY (c.title IS NULL), c.synced_at DESC))[1] AS title,
        (ARRAY_AGG(c.body  ORDER BY (c.body  IS NULL), c.synced_at DESC))[1] AS body,
        (ARRAY_AGG(c.thumbnail_url
           ORDER BY (c.thumbnail_url IS NULL), c.synced_at DESC))[1]         AS thumbnail_url,
        MAX(c.video_length_seconds)                                          AS video_length_seconds,
        BOOL_OR(c.learning_stage = 'LEARNING')                               AS learning,
        BOOL_OR(c.learning_stage = 'LEARNING_LIMITED')                       AS learning_limited,
        BOOL_OR(c.status = 'ACTIVE')                                         AS active
      FROM ${CREATIVES} c
      WHERE c.client_id = $1 AND c.creative_key <> ''
      GROUP BY c.creative_key
    `;

    const { rows: metrics } = await c.query(metricsSql, [CLIENT, "2026-08-01", "2026-08-31"]);
    const { rows: meta } = await c.query(metaSql, [CLIENT]);

    const fail: string[] = [];
    const ok = (cond: boolean, msg: string) => {
      if (!cond) fail.push(msg);
    };

    const vid = metrics.find((r) => r.creative_key === "vid_a");
    const img = metrics.find((r) => r.creative_key === "img_b");
    const empty = metrics.find((r) => r.creative_key === "");
    const vidMeta = meta.find((r) => r.creative_key === "vid_a");

    ok(metrics.length === 3, `expected 3 creative groups, got ${metrics.length}`);
    ok(vid?.ad_count === 3, `vid_a ad_count ${vid?.ad_count} != 3`);
    ok(vid?.adset_count === 2, `vid_a adset_count ${vid?.adset_count} != 2`);
    ok(Number(vid?.spend) === 30, `vid_a spend ${vid?.spend} != 30 (out-of-range row leaked?)`);
    ok(Number(vid?.leads) === 6, `vid_a leads ${vid?.leads} != 6`);
    ok(Number(vid?.video_3s_views) === 910, `vid_a 3s views ${vid?.video_3s_views} != 910`);
    ok(vid?.campaign_names?.length === 2, `vid_a campaign_names ${JSON.stringify(vid?.campaign_names)}`);
    ok(vid?.quality_ranking === "above_average", `vid_a ranking ${vid?.quality_ranking} — should be the LATEST day that had one`);
    ok(vid?.ranking_date === "2026-08-02", `vid_a ranking_date ${vid?.ranking_date}`);
    ok(img?.quality_ranking === null, `img_b ranking ${img?.quality_ranking} — 'unknown' must be filtered`);
    ok(Number(empty?.spend) === 9, `empty-key bucket spend ${empty?.spend} != 9`);
    ok(Number(empty?.impressions) === 900, `empty-key impressions ${empty?.impressions} != 900 — campaign row leaked in`);
    ok(vidMeta?.title === "New headline", `title ${vidMeta?.title}`);
    ok(vidMeta?.body === "Old body", `body ${vidMeta?.body} — a newer NULL blanked a real value`);
    ok(vidMeta?.thumbnail_url === "https://cdn/new.jpg", `thumbnail ${vidMeta?.thumbnail_url}`);
    ok(vidMeta?.learning === true, "learning should roll up true (ad2)");
    ok(vidMeta?.learning_limited === true, "learning_limited should roll up true (ad3)");
    ok(Number(vidMeta?.video_length_seconds) === 22.5, `length ${vidMeta?.video_length_seconds}`);

    for (const f of fail) console.log("  ✗ " + f);
    console.log(fail.length ? `\n${fail.length} FAILED` : "  ✓ all assertions passed");
    if (fail.length) process.exitCode = 1;
  } finally {
    // Always, even on assertion failure — these are real tables now, not temp.
    await c.query(`DROP TABLE IF EXISTS ${METRICS}, ${CREATIVES}`);
    c.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(String(e?.stack ?? e).slice(0, 1200));
  process.exit(1);
});
