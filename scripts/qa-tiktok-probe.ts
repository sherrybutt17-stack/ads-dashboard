/**
 * Ask TikTok directly why /advertiser/info/ is being refused.
 *
 * Uses the token from the most recent connect stash — the same one the picker
 * is holding — so this is the exact call the picker made, with TikTok's raw
 * answer instead of our summarised one.
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

async function call(path: string, token: string, params: Record<string, string>) {
  const u = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await fetch(u, { headers: { "Access-Token": token }, cache: "no-store" });
  return (await r.json()) as any;
}

async function main() {
  const rows = await q(
    `SELECT id, client_id, token_encrypted, payload, created_at
       FROM connect_stash WHERE provider='tiktok' ORDER BY created_at DESC LIMIT 1`,
  );
  if (!rows.length) throw new Error("no tiktok stash row — re-run the connect flow first");
  const token = decrypt(rows[0].token_encrypted);
  const ids: string[] = rows[0].payload?.advertiserIds ?? [];
  console.log(`stash ${rows[0].id} · ${new Date(rows[0].created_at).toISOString()} · ${ids.length} advertiser ids from the grant\n`);

  console.log("--- 1. /oauth2/advertiser/get/  (the call that WORKS) ---");
  const list = await call("/oauth2/advertiser/get/", token, {
    app_id: process.env.TIKTOK_APP_ID!,
    secret: process.env.TIKTOK_APP_SECRET!,
  });
  console.log(`code=${list.code} message=${JSON.stringify(list.message)} advertisers=${list.data?.list?.length ?? 0}`);

  const listed: string[] = (list.data?.list ?? []).map((a: any) => String(a.advertiser_id));
  const probeIds = listed.length ? listed : ids;

  console.log("\n--- 2. /advertiser/info/  with the SAME ids the picker sent ---");
  const info = await call("/advertiser/info/", token, {
    advertiser_ids: JSON.stringify(probeIds.slice(0, 50)),
    fields: JSON.stringify(["advertiser_id", "advertiser_name", "currency", "timezone"]),
  });
  console.log(`code=${info.code}`);
  console.log(`message=${JSON.stringify(info.message)}`);
  console.log(`returned=${info.data?.list?.length ?? 0} of ${Math.min(probeIds.length, 50)} requested`);
  if (info.data?.list?.length) console.log("sample:", JSON.stringify(info.data.list[0]));

  console.log("\n--- 3. one id at a time, to see if it is ALL of them or SOME ---");
  for (const id of probeIds.slice(0, 4)) {
    const one = await call("/advertiser/info/", token, {
      advertiser_ids: JSON.stringify([id]),
      fields: JSON.stringify(["advertiser_id", "advertiser_name", "currency", "timezone"]),
    });
    const got = one.data?.list?.[0];
    console.log(`  ${id}  code=${one.code}  ${got ? `${got.currency} / ${got.timezone}` : JSON.stringify(one.message).slice(0, 90)}`);
  }

  console.log("\n--- 4. THE FIX: fields with `name` instead of `advertiser_name` ---");
  const fixed = await call("/advertiser/info/", token, {
    advertiser_ids: JSON.stringify(probeIds.slice(0, 50)),
    fields: JSON.stringify(["advertiser_id", "name", "currency", "timezone"]),
  });
  console.log(`code=${fixed.code} message=${JSON.stringify(fixed.message)}`);
  console.log(`returned=${fixed.data?.list?.length ?? 0} of ${Math.min(probeIds.length, 50)} requested`);
  for (const r of (fixed.data?.list ?? []).slice(0, 5)) {
    console.log(`   ${r.advertiser_id}  ${String(r.name).slice(0,28).padEnd(30)} ${r.currency} / ${r.timezone}`);
  }

  console.log("\n--- 5. without the `fields` param (control) ---");
  const nofields = await call("/advertiser/info/", token, {
    advertiser_ids: JSON.stringify(probeIds.slice(0, 2)),
  });
  console.log(`code=${nofields.code} message=${JSON.stringify(nofields.message)} returned=${nofields.data?.list?.length ?? 0}`);
  if (nofields.data?.list?.[0]) console.log("keys:", Object.keys(nofields.data.list[0]).join(", "));
}
main();
