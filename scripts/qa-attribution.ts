/** How much of the real lead population is actually attributable? (§14–15) */
import { neon } from "@neondatabase/serverless";
const sql = neon(process.env.DATABASE_URL!);
const q = async (text: string) => {
  for (let i = 0; i < 5; i++) {
    try { return (await sql.query(text)) as any[]; }
    catch { await new Promise(r => setTimeout(r, 700 * (i + 1))); }
  }
  throw new Error("db unavailable");
};

async function main() {
  console.log("=== contacts by platform attribution (gg-ads) ===");
  console.table(await q(`
    SELECT
      COUNT(*)::int AS contacts,
      COUNT(meta_campaign_id)::int AS meta_campaign,
      COUNT(meta_adset_id)::int  AS meta_adset,
      COUNT(meta_ad_id)::int     AS meta_ad,
      COUNT(google_campaign_id)::int AS google_campaign,
      COUNT(tiktok_campaign_id)::int AS tiktok_campaign,
      COUNT(fbclid)::int AS fbclid, COUNT(gclid)::int AS gclid, COUNT(ttclid)::int AS ttclid
    FROM contacts c JOIN clients cl ON cl.id=c.client_id WHERE cl.slug='gg-ads'`));

  console.log("=== UTM coverage ===");
  console.table(await q(`
    SELECT COUNT(*)::int total,
           COUNT(utm_source)::int src, COUNT(utm_medium)::int med,
           COUNT(utm_campaign)::int camp, COUNT(utm_content)::int content, COUNT(utm_term)::int term
    FROM contacts c JOIN clients cl ON cl.id=c.client_id WHERE cl.slug='gg-ads'`));

  console.log("=== CROSS-PLATFORM CONTAMINATION (must all be 0) ===");
  console.table(await q(`
    SELECT
      COUNT(*) FILTER (WHERE meta_campaign_id IS NOT NULL AND google_campaign_id IS NOT NULL)::int AS meta_and_google,
      COUNT(*) FILTER (WHERE meta_campaign_id IS NOT NULL AND tiktok_campaign_id IS NOT NULL)::int AS meta_and_tiktok,
      COUNT(*) FILTER (WHERE google_campaign_id IS NOT NULL AND tiktok_campaign_id IS NOT NULL)::int AS google_and_tiktok,
      COUNT(*) FILTER (WHERE gclid IS NOT NULL AND meta_campaign_id IS NOT NULL)::int AS gclid_on_meta_lead
    FROM contacts`));

  console.log("=== do attributed campaign ids EXIST in the ad tables? (dangling attribution) ===");
  console.table(await q(`
    SELECT c.meta_campaign_id,
           COUNT(*)::int AS contacts,
           (SELECT COUNT(*)::int FROM fb_daily_metrics m
             WHERE m.meta_campaign_id = c.meta_campaign_id AND m.client_id = c.client_id) AS metric_rows
      FROM contacts c JOIN clients cl ON cl.id=c.client_id
     WHERE cl.slug='gg-ads' AND c.meta_campaign_id IS NOT NULL
     GROUP BY c.meta_campaign_id, c.client_id ORDER BY contacts DESC LIMIT 10`));

  console.log("=== funnel vs Meta-reported leads (different concepts — §66) ===");
  console.table(await q(`
    SELECT
      (SELECT COUNT(DISTINCT st.opportunity_id)::int FROM stage_transitions st
         JOIN contacts c ON c.id=st.contact_id JOIN clients cl ON cl.id=st.client_id
        WHERE cl.slug='gg-ads' AND st.to_canonical='new_lead'
          AND st.changed_at >= '2026-08-01' AND st.changed_at < '2026-09-01'
          AND (c.meta_campaign_id IS NOT NULL OR c.tags @> ARRAY['facebook-lead']::text[])) AS ghl_attributed_leads,
      (SELECT COALESCE(SUM(leads_total),0)::int FROM fb_daily_metrics m JOIN clients cl ON cl.id=m.client_id
        WHERE cl.slug='gg-ads' AND m.level='campaign' AND m.date >= '2026-08-01' AND m.date <= '2026-08-31') AS meta_reported_leads`));
}
main();
