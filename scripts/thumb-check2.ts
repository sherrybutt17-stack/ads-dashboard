import { neon } from "@neondatabase/serverless";
async function main() {
  const sql = neon(process.env.DATABASE_URL!);
  console.log("--- gg-ads creative sync ages ---");
  console.table(await sql`
    SELECT date_trunc('hour', r.synced_at) AS synced, count(*) n,
           count(*) FILTER (WHERE r.thumbnail_url IS NULL) AS no_url
      FROM meta_ad_creatives r JOIN clients c ON c.id=r.client_id
     WHERE c.slug='gg-ads' GROUP BY 1 ORDER BY 1 DESC LIMIT 10`);

  const rows = (await sql`
    SELECT r.ad_name, r.creative_type, r.status, r.synced_at, r.thumbnail_url
      FROM meta_ad_creatives r JOIN clients c ON c.id=r.client_id
     WHERE c.slug='gg-ads' AND r.thumbnail_url IS NOT NULL
     ORDER BY r.synced_at ASC LIMIT 8`) as any[];
  console.log("--- oldest gg-ads thumbs, live fetch ---");
  for (const r of rows) {
    const res = await fetch(r.thumbnail_url, { redirect: "follow" });
    console.log(`${String(r.ad_name).slice(0,34).padEnd(36)} ${r.creative_type.padEnd(7)} ${r.status ?? "?"} synced ${new Date(r.synced_at).toISOString().slice(0,16)} -> HTTP ${res.status}`);
  }
}
main();
