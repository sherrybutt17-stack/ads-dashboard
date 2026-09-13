/** Where does every Meta connection actually stand right now? */
import { neon } from "@neondatabase/serverless";

async function main() {
  const sql = neon(process.env.DATABASE_URL!);

  console.log("=== ad accounts ===");
  for (const r of (await sql`
    SELECT c.slug, c.status AS client_status, a.ad_account_id, a.account_name,
           a.currency, a.status, a.is_primary,
           (a.token_encrypted IS NOT NULL) AS own_token,
           a.token_expires_at, a.last_synced_at
      FROM meta_ad_accounts a JOIN clients c ON c.id = a.client_id
     ORDER BY c.slug`) as any[]) {
    const exp = r.token_expires_at
      ? `expires ${new Date(r.token_expires_at).toISOString().slice(0, 10)} (${Math.round(
          (new Date(r.token_expires_at).getTime() - Date.now()) / 86400000)}d)`
      : "system-user (never expires)";
    console.log(
      `${r.slug.padEnd(22)} act_${r.ad_account_id.padEnd(18)} ${String(r.account_name).padEnd(24)} ` +
      `${r.status}/${r.client_status} ${r.is_primary ? "primary" : "secondary"} | ${r.own_token ? "own token" : "shared"} ${exp} | last sync ${r.last_synced_at ?? "never"}`);
  }

  console.log("\n=== fb_daily_metrics coverage per client ===");
  for (const r of (await sql`
    SELECT c.slug, count(*) AS rows, min(m.date) AS first, max(m.date) AS last,
           round(sum(m.spend)::numeric, 2) AS spend
      FROM fb_daily_metrics m JOIN clients c ON c.id = m.client_id
     GROUP BY c.slug ORDER BY c.slug`) as any[]) {
    console.log(`${r.slug.padEnd(22)} ${String(r.rows).padStart(6)} rows  ${r.first} → ${r.last}  $${r.spend}`);
  }

  console.log("\n=== last 12 meta sync runs ===");
  for (const r of (await sql`
    SELECT c.slug, s.kind, s.status, s.rows_written, s.started_at, s.error
      FROM sync_runs s LEFT JOIN clients c ON c.id = s.client_id
     WHERE s.kind::text LIKE 'meta%' ORDER BY s.started_at DESC LIMIT 12`) as any[]) {
    console.log(`${new Date(r.started_at).toISOString().slice(0,16)} ${String(r.slug).padEnd(22)} ${r.kind.padEnd(14)} ${r.status.padEnd(8)} ${r.rows_written ?? "-"} rows ${r.error ? "ERR: " + String(r.error).slice(0,90) : ""}`);
  }
}
main();
