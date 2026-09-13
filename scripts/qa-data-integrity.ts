/** Duplicate / orphan / corruption audit against the live database (§57). */
import { neon } from "@neondatabase/serverless";
const sql = neon(process.env.DATABASE_URL!);

const checks: Array<[string, string, (n: number) => boolean]> = [
  ["duplicate stage_transitions (same dedupe_key)",
   `SELECT COUNT(*)::int n FROM (SELECT dedupe_key FROM stage_transitions GROUP BY dedupe_key HAVING COUNT(*)>1) x`, n=>n===0],
  ["duplicate opportunities (client + ghl id)",
   `SELECT COUNT(*)::int n FROM (SELECT client_id, ghl_opportunity_id FROM opportunities GROUP BY 1,2 HAVING COUNT(*)>1) x`, n=>n===0],
  ["duplicate contacts (client + ghl id)",
   `SELECT COUNT(*)::int n FROM (SELECT client_id, ghl_contact_id FROM contacts GROUP BY 1,2 HAVING COUNT(*)>1) x`, n=>n===0],
  ["duplicate fb_daily_metrics (client+date+level+campaign)",
   `SELECT COUNT(*)::int n FROM (SELECT client_id,date,level,meta_campaign_id,COALESCE(meta_ad_id,'') FROM fb_daily_metrics GROUP BY 1,2,3,4,5 HAVING COUNT(*)>1) x`, n=>n===0],
  ["transitions whose opportunity is gone (orphan)",
   `SELECT COUNT(*)::int n FROM stage_transitions st LEFT JOIN opportunities o ON o.id=st.opportunity_id WHERE o.id IS NULL`, n=>n===0],
  ["transitions whose client is gone (orphan)",
   `SELECT COUNT(*)::int n FROM stage_transitions st LEFT JOIN clients c ON c.id=st.client_id WHERE c.id IS NULL`, n=>n===0],
  ["contacts whose client is gone (orphan)",
   `SELECT COUNT(*)::int n FROM contacts ct LEFT JOIN clients c ON c.id=ct.client_id WHERE c.id IS NULL`, n=>n===0],
  ["fb_daily_metrics with negative spend",
   `SELECT COUNT(*)::int n FROM fb_daily_metrics WHERE spend < 0`, n=>n===0],
  ["fb_daily_metrics with impressions < link_clicks (impossible)",
   `SELECT COUNT(*)::int n FROM fb_daily_metrics WHERE link_clicks > impressions`, n=>n===0],
  ["fb_daily_metrics rows with spend>0 but impressions=0",
   `SELECT COUNT(*)::int n FROM fb_daily_metrics WHERE spend > 0 AND impressions = 0`, n=>n===0],
  ["stage_transitions with to_canonical set but no mapping row",
   `SELECT COUNT(*)::int n FROM stage_transitions st WHERE st.to_canonical IS NOT NULL AND st.to_stage_id IS NULL`, n=>n===0],
  ["sync_runs stuck in 'running' over 2h",
   `SELECT COUNT(*)::int n FROM sync_runs WHERE status='running' AND started_at < now() - interval '2 hours'`, n=>n===0],
  ["clients with no webhook_token (webhook unreachable)",
   `SELECT COUNT(*)::int n FROM clients WHERE webhook_token IS NULL OR webhook_token=''`, n=>n===0],
  ["duplicate webhook_token across clients (routing collision)",
   `SELECT COUNT(*)::int n FROM (SELECT webhook_token FROM clients GROUP BY 1 HAVING COUNT(*)>1) x`, n=>n===0],
];

async function main() {
  let bad = 0;
  for (const [label, q, ok] of checks) {
    let n = -1, err = "";
    for (let i = 0; i < 5 && n < 0; i++) {
      try { n = Number(((await sql.query(q)) as any[])[0].n); }
      catch (e: any) { err = e.message?.slice(0, 80) ?? "?"; await new Promise(r => setTimeout(r, 700 * (i + 1))); }
    }
    if (n < 0) { console.log(`  ⚠️  ${label}: query failed — ${err}`); continue; }
    const good = ok(n);
    if (!good) bad++;
    console.log(`  ${good ? "✅" : "❌"} ${label}: ${n}`);
  }
  console.log(`\n${bad === 0 ? "no integrity violations" : bad + " CHECKS FAILED"}`);
}
main();
