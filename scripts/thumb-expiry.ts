import { neon } from "@neondatabase/serverless";
async function main() {
  const sql = neon(process.env.DATABASE_URL!);
  const rows = (await sql`
    SELECT r.ad_name, r.title, r.creative_type, r.thumbnail_url
      FROM meta_ad_creatives r JOIN clients c ON c.id=r.client_id
     WHERE c.slug='gg-ads' AND r.thumbnail_url IS NOT NULL LIMIT 5`) as any[];
  for (const r of rows) {
    const u = new URL(r.thumbnail_url);
    const oe = u.searchParams.get("oe");
    const exp = oe ? new Date(parseInt(oe, 16) * 1000) : null;
    console.log(`${String(r.title ?? r.ad_name).slice(0,40).padEnd(42)} host=${u.host}`);
    console.log(`   oe=${oe} -> ${exp ? exp.toISOString() : "none"} ${exp ? (exp > new Date() ? "VALID" : "EXPIRED") : ""}`);
    const res = await fetch(r.thumbnail_url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      },
    });
    console.log(`   browser-UA fetch -> HTTP ${res.status}`);
  }
}
main();
