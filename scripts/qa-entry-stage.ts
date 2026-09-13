/** Where do new opportunities FIRST appear in the funnel? */
import { neon } from "@neondatabase/serverless";
const sql = neon(process.env.DATABASE_URL!);
const q = async (t: string) => {
  let last: unknown;
  for (let i = 0; i < 8; i++) {
    try { return (await sql.query(t)) as any[]; }
    catch (e) { last = e; await new Promise(r => setTimeout(r, 1200 * (i + 1))); }
  }
  throw last;
};
const CTE = `
  WITH firsts AS (
    SELECT st.opportunity_id, MIN(st.changed_at) AS first_at
      FROM stage_transitions st JOIN clients c ON c.id=st.client_id
     WHERE c.slug='gg-ads' GROUP BY 1
  )`;
async function main() {
  console.log("=== ALL opportunities first seen in the last 30d — which stage did they enter at? ===");
  console.table(await q(`${CTE}
    SELECT COALESCE(st.to_canonical::text,'(unmapped)') AS entered_at, COUNT(*)::int n
      FROM firsts f
      JOIN stage_transitions st ON st.opportunity_id=f.opportunity_id AND st.changed_at=f.first_at
     WHERE f.first_at >= now() - interval '30 days'
     GROUP BY 1 ORDER BY 2 DESC`));

  console.log("=== PAID (attributed) only ===");
  console.table(await q(`${CTE}
    SELECT COALESCE(st.to_canonical::text,'(unmapped)') AS entered_at, COUNT(*)::int n
      FROM firsts f
      JOIN stage_transitions st ON st.opportunity_id=f.opportunity_id AND st.changed_at=f.first_at
      JOIN contacts ct ON ct.id=st.contact_id
      JOIN clients cl ON cl.id=st.client_id
     WHERE f.first_at >= now() - interval '30 days'
       AND (ct.meta_campaign_id IS NOT NULL OR ct.tags @> ARRAY[cl.paid_lead_tag]::text[])
     GROUP BY 1 ORDER BY 2 DESC`));
}
main();
