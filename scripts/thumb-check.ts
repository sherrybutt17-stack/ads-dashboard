import { neon } from "@neondatabase/serverless";
async function main() {
  const sql = neon(process.env.DATABASE_URL!);
  const rows = (await sql`
    SELECT c.slug, r.ad_name, r.creative_type, r.synced_at, r.thumbnail_url
      FROM meta_ad_creatives r JOIN clients c ON c.id = r.client_id
     WHERE r.thumbnail_url IS NOT NULL
     ORDER BY r.synced_at DESC LIMIT 6`) as any[];
  for (const r of rows) {
    const res = await fetch(r.thumbnail_url, { method: "GET", redirect: "follow" });
    const host = new URL(r.thumbnail_url).host;
    console.log(
      `${r.slug.padEnd(20)} ${String(r.ad_name).slice(0, 28).padEnd(30)} ${r.creative_type.padEnd(7)} ` +
      `updated ${new Date(r.synced_at).toISOString().slice(0, 16)} | ${host} -> HTTP ${res.status} ${res.headers.get("content-type") ?? ""}`);
    if (!res.ok) console.log("   url:", r.thumbnail_url.slice(0, 190));
  }
}
main();
