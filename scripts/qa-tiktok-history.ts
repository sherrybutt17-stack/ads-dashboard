/** Where does this TikTok advertiser actually have delivery? */
import { neon } from "@neondatabase/serverless";
import { decrypt } from "../src/lib/crypto";

const BASE = "https://business-api.tiktok.com/open_api/v1.3";
const sql = neon(process.env.DATABASE_URL!);
const q = async (t: string) => {
  let e; for (let i = 0; i < 8; i++) {
    try { return (await sql.query(t)) as any[]; } catch (x) { e = x; await new Promise(r => setTimeout(r, 1100 * (i + 1))); }
  } throw e;
};
const call = async (path: string, token: string, params: Record<string, string | number>) => {
  const u = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  const r = await fetch(u, { headers: { "Access-Token": token }, cache: "no-store" });
  return (await r.json()) as any;
};

async function main() {
  const rows = await q(`
    SELECT c.slug, t.advertiser_id, t.advertiser_name, t.currency, t.timezone,
           t.token_encrypted, t.status::text, t.last_synced_at::text
      FROM tiktok_ad_accounts t JOIN clients c ON c.id = t.client_id`);
  console.log("attached TikTok advertisers:");
  rows.forEach((r: any) => console.log(`  ${r.slug} · ${r.advertiser_name} (${r.advertiser_id}) · ${r.currency} · ${r.timezone} · ${r.status} · last sync ${r.last_synced_at ?? "never"}`));
  if (!rows.length) return console.log("  (none attached)");

  const a = rows[0];
  const token = decrypt(a.token_encrypted);

  console.log(`\ncampaigns on ${a.advertiser_name}:`);
  const camp = await call("/campaign/get/", token, { advertiser_id: a.advertiser_id, page_size: 100 });
  console.log(`  code=${camp.code} ${camp.code ? JSON.stringify(camp.message).slice(0,140) : ""} count=${camp.data?.list?.length ?? 0}`);
  for (const c of (camp.data?.list ?? []).slice(0, 12)) {
    console.log(`   ${String(c.campaign_id).padEnd(20)} ${String(c.operation_status ?? c.status ?? "?").padEnd(10)} ${String(c.create_time ?? "").slice(0,10)}  ${String(c.campaign_name).slice(0,46)}`);
  }

  console.log("\ndelivery by month (report/integrated/get):");
  const years = ["2024", "2025", "2026"];
  for (const y of years) {
    for (let m = 1; m <= 12; m++) {
      const start = `${y}-${String(m).padStart(2, "0")}-01`;
      const end = new Date(Date.UTC(Number(y), m, 0)).toISOString().slice(0, 10);
      if (start > "2026-09-14") break;
      const r = await call("/report/integrated/get/", token, {
        advertiser_id: a.advertiser_id, report_type: "BASIC", service_type: "AUCTION",
        data_level: "AUCTION_CAMPAIGN",
        dimensions: JSON.stringify(["campaign_id", "stat_time_day"]),
        metrics: JSON.stringify(["campaign_name", "spend", "impressions", "clicks", "conversion"]),
        start_date: start, end_date: end, page_size: 1000, page: 1,
      });
      if (r.code !== 0) { console.log(`  ${y}-${String(m).padStart(2,"0")}  ERROR ${r.code} ${JSON.stringify(r.message).slice(0,90)}`); continue; }
      const list = r.data?.list ?? [];
      const spend = list.reduce((t: number, x: any) => t + Number(x.metrics?.spend ?? 0), 0);
      const impr = list.reduce((t: number, x: any) => t + Number(x.metrics?.impressions ?? 0), 0);
      const clicks = list.reduce((t: number, x: any) => t + Number(x.metrics?.clicks ?? 0), 0);
      const conv = list.reduce((t: number, x: any) => t + Number(x.metrics?.conversion ?? 0), 0);
      if (list.length) console.log(`  ${y}-${String(m).padStart(2,"0")}  rows=${String(list.length).padStart(4)}  spend=$${spend.toFixed(2).padStart(10)}  impr=${String(impr).padStart(9)}  clicks=${String(clicks).padStart(7)}  conv=${conv}`);
    }
  }
}
main();
