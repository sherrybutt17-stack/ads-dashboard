import { neon } from "@neondatabase/serverless";
async function main() {
  const sql = neon(process.env.DATABASE_URL!);
  const rows = (await sql`
    SELECT DISTINCT ON (host) host, thumbnail_url FROM (
      SELECT split_part(split_part(thumbnail_url,'://',2),'/',1) AS host, thumbnail_url
        FROM meta_ad_creatives WHERE thumbnail_url IS NOT NULL) t`) as any[];
  for (const r of rows) {
    const res = await fetch(r.thumbnail_url, {
      headers: { "User-Agent": "Mozilla/5.0 Chrome/128.0", Referer: "https://dash.growthguild.us/" },
    });
    console.log(`\n${r.host} -> HTTP ${res.status}`);
    for (const k of ["content-type", "cross-origin-resource-policy", "access-control-allow-origin",
                     "x-frame-options", "cache-control", "set-cookie", "location", "vary"]) {
      const v = res.headers.get(k);
      if (v) console.log(`   ${k}: ${v.slice(0, 120)}`);
    }
  }
}
main();
