/**
 * Does every TikTok call we make actually match TikTok's contract?
 *
 * Written after `/advertiser/info/` was found rejecting `advertiser_name` —
 * a field-name mismatch fails the WHOLE call, and our code catches it as
 * "unavailable", so the fault renders as missing data rather than as an error.
 * Anything else built the same way would fail the same silent way.
 */
import { neon } from "@neondatabase/serverless";
import { decrypt } from "../src/lib/crypto";

const BASE = "https://business-api.tiktok.com/open_api/v1.3";
const sql = neon(process.env.DATABASE_URL!);
const q = async (t: string) => {
  for (let i = 0; i < 6; i++) {
    try { return (await sql.query(t)) as any[]; }
    catch { await new Promise(r => setTimeout(r, 900 * (i + 1))); }
  }
  throw new Error("db unavailable");
};
const call = async (path: string, token: string, params: Record<string, string | number>) => {
  const u = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  const r = await fetch(u, { headers: { "Access-Token": token }, cache: "no-store" });
  return (await r.json()) as any;
};
const verdict = (r: any) => (r.code === 0 ? "✅ code=0" : `❌ code=${r.code} ${JSON.stringify(r.message).slice(0, 220)}`);

async function main() {
  const [row] = await q(
    `SELECT token_encrypted, payload FROM connect_stash WHERE provider='tiktok' ORDER BY created_at DESC LIMIT 1`);
  if (!row) throw new Error("no tiktok stash");
  const token = decrypt(row.token_encrypted);

  // An advertiser that actually has delivery, so an empty result means "no data"
  // rather than hiding a rejected request.
  const info = await call("/advertiser/info/", token, {
    advertiser_ids: JSON.stringify((row.payload?.advertiserIds ?? []).slice(0, 50)),
    fields: JSON.stringify(["advertiser_id", "name", "currency", "timezone"]),
  });
  const advertisers = (info.data?.list ?? []).map((a: any) => String(a.advertiser_id));
  console.log(`advertisers resolved: ${advertisers.length}\n`);

  console.log("1. /advertiser/info/ (the fixed call)");
  console.log("   " + verdict(info));

  console.log("\n2. /report/integrated/get/ — exactly the fields sync.ts sends");
  let withData: string | null = null;
  for (const adv of advertisers.slice(0, 6)) {
    const r = await call("/report/integrated/get/", token, {
      advertiser_id: adv,
      report_type: "BASIC",
      service_type: "AUCTION",
      data_level: "AUCTION_CAMPAIGN",
      dimensions: JSON.stringify(["campaign_id", "stat_time_day"]),
      metrics: JSON.stringify(["campaign_name", "spend", "impressions", "clicks", "conversion"]),
      start_date: "2026-08-01",
      end_date: "2026-08-31",
      page_size: 1000,
      page: 1,
    });
    const n = r.data?.list?.length ?? 0;
    console.log(`   ${adv}  ${verdict(r)}  rows=${n}`);
    if (r.code === 0 && n > 0 && !withData) withData = adv;
    if (r.code !== 0) break;
  }

  if (withData) {
    console.log(`\n3. a real row from ${withData} — are the metric keys what sync.ts reads?`);
    const r = await call("/report/integrated/get/", token, {
      advertiser_id: withData, report_type: "BASIC", service_type: "AUCTION",
      data_level: "AUCTION_CAMPAIGN",
      dimensions: JSON.stringify(["campaign_id", "stat_time_day"]),
      metrics: JSON.stringify(["campaign_name", "spend", "impressions", "clicks", "conversion"]),
      start_date: "2026-08-01", end_date: "2026-08-31", page_size: 10, page: 1,
    });
    const row0 = r.data?.list?.[0];
    console.log("   dimensions:", JSON.stringify(row0?.dimensions));
    console.log("   metrics   :", JSON.stringify(row0?.metrics));
    console.log("   page_info :", JSON.stringify(r.data?.page_info));
  } else {
    console.log("\n3. no advertiser returned rows for Aug 2026 — trying a wider window");
    const r = await call("/report/integrated/get/", token, {
      advertiser_id: advertisers[0], report_type: "BASIC", service_type: "AUCTION",
      data_level: "AUCTION_CAMPAIGN",
      dimensions: JSON.stringify(["campaign_id", "stat_time_day"]),
      metrics: JSON.stringify(["campaign_name", "spend", "impressions", "clicks", "conversion"]),
      start_date: "2025-01-01", end_date: "2025-12-31", page_size: 10, page: 1,
    });
    console.log("   " + verdict(r) + `  rows=${r.data?.list?.length ?? 0}`);
    if (r.data?.list?.[0]) console.log("   sample:", JSON.stringify(r.data.list[0]));
  }
}
main();
