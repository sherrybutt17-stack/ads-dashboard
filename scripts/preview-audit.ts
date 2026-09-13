/**
 * Would the preview proxy return a real image for every creative card?
 *
 * Written after a bug where 42 of 44 gg-ads cards read "Preview expired" while
 * every one of those URLs returned `200 image/jpeg` to the server: Meta hands
 * back `www.facebook.com/ads/image/?d=…` for some creatives instead of an
 * `fbcdn.net` link, and content blockers drop that host and path outright. The
 * host histogram below is what makes that visible — a run that is all
 * `www.facebook.com` and all "would serve" is the signature of a preview
 * problem that only exists in the browser.
 *
 * Run: npx tsx --env-file=.env.local scripts/preview-audit.ts <slug>
 */
import { neon } from "@neondatabase/serverless";

async function main() {
  const slug = process.argv[2] ?? "gg-ads";
  const sql = neon(process.env.DATABASE_URL!);
  const rows = (await sql`
    SELECT DISTINCT ON (r.creative_key)
           r.creative_key, r.creative_type, r.title, r.ad_name, r.thumbnail_url
      FROM meta_ad_creatives r JOIN clients c ON c.id = r.client_id
     WHERE c.slug = ${slug} AND r.creative_key <> ''
     ORDER BY r.creative_key, r.synced_at DESC`) as any[];

  let ok = 0, bad = 0, none = 0;
  const hosts = new Map<string, number>();
  for (const r of rows) {
    if (!r.thumbnail_url) { none++; continue; }
    const host = new URL(r.thumbnail_url).host;
    hosts.set(host, (hosts.get(host) ?? 0) + 1);
    try {
      const res = await fetch(r.thumbnail_url, { redirect: "follow" });
      const ct = res.headers.get("content-type") ?? "";
      if (res.ok && ct.startsWith("image/")) ok++;
      else { bad++; console.log(`  DEAD ${host} ${res.status} ${ct} — ${String(r.title ?? r.ad_name).slice(0,40)}`); }
    } catch (e) {
      bad++; console.log(`  ERR  ${host} — ${String(r.title ?? r.ad_name).slice(0,40)}`);
    }
  }
  console.log(`\n${slug}: ${rows.length} creative cards`);
  console.log(`  proxy would serve an image : ${ok}`);
  console.log(`  stored URL dead (proxy re-resolves from Meta): ${bad}`);
  console.log(`  no URL stored at all       : ${none}`);
  console.log("  hosts:", [...hosts].map(([h, n]) => `${h}=${n}`).join("  "));
}
main();
