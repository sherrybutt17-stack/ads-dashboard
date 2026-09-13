/** What is the stored per-account token actually good for? */
import { createHmac } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { decrypt } from "../src/lib/crypto";

async function main() {
  const V = process.env.META_API_VERSION || "v25.0";
  const sql = neon(process.env.DATABASE_URL!);
  const rows = (await sql`
    SELECT c.slug, a.account_name, a.token_encrypted
      FROM meta_ad_accounts a JOIN clients c ON c.id = a.client_id
     WHERE a.token_encrypted IS NOT NULL`) as any[];
  const appAt = `${process.env.META_APP_ID}|${process.env.META_APP_SECRET}`;
  for (const r of rows) {
    const tok = decrypt(r.token_encrypted);
    const res = await fetch(
      `https://graph.facebook.com/${V}/debug_token?input_token=${tok}&access_token=${appAt}`,
    ).then((x) => x.json());
    console.log(`--- ${r.slug} / ${r.account_name} ---`);
    console.log(JSON.stringify(res.data ?? res, null, 2).slice(0, 1600));

    const proof = createHmac("sha256", process.env.META_APP_SECRET!).update(tok).digest("hex");
    const me = await fetch(
      `https://graph.facebook.com/${V}/me?fields=id,name&access_token=${tok}&appsecret_proof=${proof}`,
    ).then((x) => x.json());
    console.log("granted to:", JSON.stringify(me));
  }
}
main();
