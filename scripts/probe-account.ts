/**
 * What does one ad account actually hold?
 *
 * A sync that succeeds with zero rows is ambiguous — an empty account and a
 * permission problem look identical from our side. This asks Meta directly,
 * with the account's own stored token, and prints what comes back.
 */
import { createHmac } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { decrypt } from "../src/lib/crypto";

const V = process.env.META_API_VERSION || "v25.0";
const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} not set`);
  return v;
};

async function main() {
  const slug = process.argv[2] ?? "new-fb-ads-testing";
  const sql = neon(need("DATABASE_URL"));
  const rows = (await sql.query(
    `SELECT a.ad_account_id, a.account_name, a.token_encrypted
       FROM meta_ad_accounts a JOIN clients c ON c.id = a.client_id
      WHERE c.slug = $1 LIMIT 1`,
    [slug],
  )) as Array<{ ad_account_id: string; account_name: string; token_encrypted: string | null }>;
  if (!rows.length) throw new Error(`no ad account for ${slug}`);

  const { ad_account_id: act, account_name, token_encrypted } = rows[0];
  const token = token_encrypted ? decrypt(token_encrypted) : need("META_SYSTEM_USER_TOKEN");
  const proof = createHmac("sha256", need("META_APP_SECRET")).update(token).digest("hex");
  console.log(`${account_name} (act_${act}), token: ${token_encrypted ? "account's own" : "system user"}\n`);

  const get = async (path: string, params: Record<string, string>) => {
    const u = new URL(`https://graph.facebook.com/${V}/${path}`);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    u.searchParams.set("access_token", token);
    u.searchParams.set("appsecret_proof", proof);
    const r = await fetch(u, { cache: "no-store" });
    return { status: r.status, body: await r.json() };
  };

  const info = await get(`act_${act}`, {
    fields: "name,account_status,currency,timezone_name,amount_spent,created_time",
  });
  console.log("account:", info.status, JSON.stringify(info.body));

  const camps = await get(`act_${act}/campaigns`, {
    fields: "id,name,status,created_time",
    limit: "10",
  });
  console.log(
    "\ncampaigns:",
    camps.status,
    JSON.stringify(camps.body?.data ?? camps.body).slice(0, 600),
  );

  // Month-by-month across the account's whole plausible life, so a dormant
  // account can still be demoed on a range that has data in it.
  const hist = await get(`act_${act}/insights`, {
    level: "account",
    time_range: JSON.stringify({ since: "2024-06-01", until: "2025-12-31" }),
    time_increment: "monthly",
    fields: "spend,impressions,clicks",
  });
  const months = (hist.body?.data ?? []) as Array<Record<string, string>>;
  if (months.length) {
    console.log("\nmonthly history:");
    console.table(
      months.map((m) => ({
        month: m.date_start?.slice(0, 7),
        spend: m.spend,
        impressions: m.impressions,
        clicks: m.clicks,
      })),
    );
  } else {
    console.log("\nmonthly history: none in 2024-06 → 2025-12");
  }

  for (const days of [30, 90, 365]) {
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const until = new Date().toISOString().slice(0, 10);
    const ins = await get(`act_${act}/insights`, {
      level: "account",
      time_range: JSON.stringify({ since, until }),
      fields: "spend,impressions,clicks",
    });
    console.log(
      `\ninsights last ${days}d (${since}→${until}):`,
      ins.status,
      JSON.stringify(ins.body?.data ?? ins.body).slice(0, 400),
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
