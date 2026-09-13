/**
 * Independent reconciliation: ask Meta directly, ask our database, compare.
 *
 * Deliberately does NOT reuse src/lib/meta/sync.ts — a bug shared by the
 * ingest path and the checker would cancel out and read as agreement.
 */
import { createHmac } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { decrypt } from "../src/lib/crypto";

const V = process.env.META_API_VERSION || "v25.0";

async function main() {
  const slug = process.argv[2] ?? "gg-ads";
  const since = process.argv[3] ?? "2026-08-01";
  const until = process.argv[4] ?? "2026-08-31";
  const sql = neon(process.env.DATABASE_URL!);

  const [acct] = (await sql`
    SELECT a.ad_account_id, a.token_encrypted, a.timezone, a.currency, c.id AS client_id, c.timezone AS client_tz
      FROM meta_ad_accounts a JOIN clients c ON c.id = a.client_id
     WHERE c.slug = ${slug} AND a.status = 'active' LIMIT 1`) as any[];
  if (!acct) throw new Error(`no active meta account for ${slug}`);

  const token = acct.token_encrypted ? decrypt(acct.token_encrypted) : process.env.META_SYSTEM_USER_TOKEN!;
  const proof = createHmac("sha256", process.env.META_APP_SECRET!).update(token).digest("hex");

  const call = async (params: Record<string, string>) => {
    const u = new URL(`https://graph.facebook.com/${V}/act_${acct.ad_account_id}/insights`);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    u.searchParams.set("access_token", token);
    u.searchParams.set("appsecret_proof", proof);
    const r = await fetch(u, { cache: "no-store" });
    const j: any = await r.json();
    if (j.error) throw new Error(j.error.message);
    return j.data ?? [];
  };

  const num = (s: any) => (s == null ? 0 : Number(s));
  const actionOf = (row: any, type: string) =>
    num((row.actions ?? []).find((a: any) => a.action_type === type)?.value);

  // --- Meta, account level, whole period in ONE call (its own aggregation) ---
  const [live] = await call({
    level: "account",
    time_range: JSON.stringify({ since, until }),
    fields: "spend,impressions,reach,clicks,inline_link_clicks,actions",
    use_unified_attribution_setting: "true",
  });

  // --- our database ---
  const [db] = (await sql`
    SELECT COALESCE(SUM(spend),0) spend, COALESCE(SUM(impressions),0) impressions,
           COALESCE(SUM(clicks_all),0) clicks_all, COALESCE(SUM(link_clicks),0) link_clicks,
           COALESCE(SUM(leads_total),0) leads_total, COUNT(*) rows
      FROM fb_daily_metrics
     WHERE client_id = ${acct.client_id} AND level='campaign'
       AND date >= ${since} AND date <= ${until}`) as any[];

  const rows: Array<[string, number, number]> = [
    ["spend", num(live?.spend), Number(db.spend)],
    ["impressions", num(live?.impressions), Number(db.impressions)],
    ["clicks (all)", num(live?.clicks), Number(db.clicks_all)],
    ["link_clicks", actionOf(live, "link_click"), Number(db.link_clicks)],
    ["leads", actionOf(live, "lead"), Number(db.leads_total)],
  ];

  console.log(`\n${slug}  act_${acct.ad_account_id}  ${since} → ${until}  (acct tz ${acct.timezone}, ${acct.currency})`);
  console.log(`db rows: ${db.rows}\n`);
  console.log("metric          META (live)        OUR DB        delta      delta%");
  let worst = 0;
  for (const [name, m, d] of rows) {
    const delta = d - m;
    const pct = m === 0 ? (d === 0 ? 0 : Infinity) : (delta / m) * 100;
    if (Number.isFinite(pct)) worst = Math.max(worst, Math.abs(pct));
    console.log(
      `${name.padEnd(14)} ${m.toFixed(2).padStart(14)} ${d.toFixed(2).padStart(13)} ${delta.toFixed(2).padStart(11)} ${(Number.isFinite(pct) ? pct.toFixed(3) + "%" : "n/a").padStart(11)}`,
    );
  }

  // --- reach: must NOT match the sum of daily reach ---
  const dailyReachSum = (await call({
    level: "account", time_range: JSON.stringify({ since, until }),
    time_increment: "1", fields: "reach",
  })).reduce((t: number, r: any) => t + num(r.reach), 0);
  console.log(`\nreach (period query) : ${num(live?.reach)}`);
  console.log(`reach (sum of days)  : ${dailyReachSum}  <- summing is WRONG by ${(((dailyReachSum / Math.max(num(live?.reach),1)) - 1) * 100).toFixed(1)}%`);

  console.log(`\nworst delta: ${worst.toFixed(3)}%`);
}
main();
