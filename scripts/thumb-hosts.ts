import { neon } from "@neondatabase/serverless";
async function main() {
  const sql = neon(process.env.DATABASE_URL!);
  const rows = (await sql`
    SELECT c.slug, r.title, r.ad_name, r.creative_type, r.thumbnail_url
      FROM meta_ad_creatives r JOIN clients c ON c.id=r.client_id
     WHERE r.thumbnail_url IS NOT NULL`) as any[];
  const byHost = new Map<string, number>();
  for (const r of rows) {
    const h = new URL(r.thumbnail_url).host;
    byHost.set(h, (byHost.get(h) ?? 0) + 1);
  }
  console.log("--- thumbnail hosts across all creatives ---");
  for (const [h, n] of [...byHost].sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(4)}  ${h}`);

  const fb = rows.find((r) => new URL(r.thumbnail_url).host === "www.facebook.com");
  if (fb) {
    console.log("\n--- what a www.facebook.com thumbnail actually returns ---");
    console.log("url:", fb.thumbnail_url.slice(0, 160));
    const res = await fetch(fb.thumbnail_url, { redirect: "follow" });
    console.log("HTTP", res.status, "| content-type:", res.headers.get("content-type"));
    console.log("first bytes:", (await res.text()).slice(0, 120).replace(/\s+/g, " "));
  }
}
main();
