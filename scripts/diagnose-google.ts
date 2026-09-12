/**
 * Ask Google what is actually wrong, and print it verbatim.
 *
 * The account picker lists seven customers and cannot read any of them. Three
 * hypotheses have been wrong so far — a developer token at Test access, a
 * missing `login-customer-id`, the wrong `login-customer-id` — because the
 * error that would settle it was being swallowed. This runs the same calls the
 * app makes, against the refresh token the last sign-in left in `connect_stash`,
 * and prints Google's raw response for each header variant.
 *
 *   1. Click "Sign in with Google" on the client's setup page (the stash lives
 *      15 minutes).
 *   2. npx tsx --env-file=.env.local scripts/diagnose-google.ts
 *
 * Needs GOOGLE_ADS_DEVELOPER_TOKEN in .env.local — copy it from Vercel →
 * Settings → Environment Variables. Nothing is written; every call is a read.
 */
import { neon } from "@neondatabase/serverless";
import { decrypt } from "../src/lib/crypto";

const HOST = "https://googleads.googleapis.com";
const VERSION = process.env.GOOGLE_ADS_API_VERSION ?? "v22";

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set in .env.local`);
  return v;
}

async function accessToken(refreshToken: string): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: need("GOOGLE_ADS_CLIENT_ID"),
      client_secret: need("GOOGLE_ADS_CLIENT_SECRET"),
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`token exchange ${res.status}: ${JSON.stringify(body)}`);
  return body.access_token as string;
}

async function main() {
  const sql = neon(need("DATABASE_URL"));
  const rows = (await sql.query(
    `SELECT token_encrypted, expires_at FROM connect_stash
      WHERE provider = 'google' ORDER BY created_at DESC LIMIT 1`,
  )) as Array<{ token_encrypted: string; expires_at: string }>;

  if (!rows.length) {
    console.error(
      "No Google stash found. Click 'Sign in with Google' on the client's setup page, then run this within 15 minutes.",
    );
    process.exit(1);
  }

  const refreshToken = decrypt(rows[0].token_encrypted);
  const token = await accessToken(refreshToken);
  const devToken = need("GOOGLE_ADS_DEVELOPER_TOKEN");
  console.log(`API ${VERSION} · developer token ends …${devToken.slice(-4)}\n`);

  // 1 — the call that works today.
  const listRes = await fetch(`${HOST}/${VERSION}/customers:listAccessibleCustomers`, {
    headers: { Authorization: `Bearer ${token}`, "developer-token": devToken },
  });
  const listBody = await listRes.text();
  console.log(`listAccessibleCustomers → ${listRes.status}`);
  console.log(listBody.slice(0, 600), "\n");
  if (!listRes.ok) return;

  const ids: string[] = (JSON.parse(listBody).resourceNames ?? []).map((r: string) =>
    r.replace("customers/", ""),
  );
  console.log(`${ids.length} accessible: ${ids.join(", ")}\n`);

  // 2 — every account, against every header, so one run answers it all.
  for (const target of ids) {
    console.log(`\n──── customer ${target} ────`);
    const candidates = ["", target, ...ids.filter((i) => i !== target)];
    let solved = false;
    for (const login of candidates) {
    const res = await fetch(
      `${HOST}/${VERSION}/customers/${target}/googleAds:searchStream`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "developer-token": devToken,
          ...(login ? { "login-customer-id": login } : {}),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: "SELECT customer.descriptive_name, customer.manager FROM customer",
        }),
      },
    );
      const body = await res.text();
      const code =
        /"(?:authorizationError|authenticationError|internalError|quotaError)"\s*:\s*"([A-Z_]+)"/.exec(
          body,
        )?.[1] ??
        /"message"\s*:\s*"([^"]{0,140})"/.exec(body)?.[1];
      console.log(
        `  login-customer-id=${(login || "(none)").padEnd(12)} → ${res.status} ${
          res.ok ? "✅ WORKS" : (code ?? body.replace(/\s+/g, " ").slice(0, 120))
        }`,
      );
      if (res.ok) {
        console.log(`  ✅ ${target} is readable through ${login || "no manager"}`);
        solved = true;
        break;
      }
    }
    if (!solved) console.log(`  ❌ ${target} unreadable through any header`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
