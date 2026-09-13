/**
 * Can a client-role user reach another client's data? (§37/§39, P0)
 *
 * Creates a throwaway client-role account granted ONE client, drives real HTTP
 * against the running app, and deletes the account afterwards. Nothing is
 * asserted from the session payload — every check is a live response code.
 */
import { neon } from "@neondatabase/serverless";
import { hashPassword } from "../src/lib/crypto";

const BASE = process.env.QA_BASE ?? "http://localhost:3001";
const sql = neon(process.env.DATABASE_URL!);

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail: string) => {
  if (ok) { pass++; console.log(`  ✅ ${label} — ${detail}`); }
  else { fail++; console.log(`  ❌ ${label} — ${detail}`); }
};

async function main() {
  const email = `qa-isolation-${Date.now()}@example.invalid`;
  const password = "QaProbe!" + Math.random().toString(36).slice(2, 10) + "A1";
  const [granted] = (await sql`SELECT id, slug, agency_id FROM clients WHERE slug='testing' LIMIT 1`) as any[];
  const [forbidden] = (await sql`SELECT id, slug FROM clients WHERE slug='gg-ads' LIMIT 1`) as any[];
  if (!granted || !forbidden) throw new Error("need both 'testing' and 'gg-ads'");

  const hash = hashPassword(password);
  const [user] = (await sql`
    INSERT INTO users (email, password_hash, role, name, status, agency_id, email_verified_at)
    VALUES (${email}, ${hash}, 'client', 'QA Isolation Probe', 'active', ${granted.agency_id}, now())
    RETURNING id`) as any[];
  await sql`INSERT INTO user_clients (user_id, client_id) VALUES (${user.id}, ${granted.id})`;
  console.log(`client-role user granted ONLY '${granted.slug}'; probing against '${forbidden.slug}'\n`);

  try {
    const login = await fetch(`${BASE}/api/auth`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
    check("login as client-role user", login.status === 200 && Boolean(cookie), `HTTP ${login.status}`);

    const get = async (p: string) => {
      const r = await fetch(`${BASE}${p}`, { headers: { cookie }, redirect: "manual" });
      return r.status;
    };

    console.log("\n  — their OWN client (must work) —");
    check("own dashboard page", [200, 307].includes(await get(`/c/${granted.slug}`)), `HTTP ${await get(`/c/${granted.slug}`)}`);
    check("own branding asset", (await get(`/api/c/${granted.slug}/branding/logo`)) !== 403, `HTTP ${await get(`/api/c/${granted.slug}/branding/logo`)}`);

    console.log("\n  — ANOTHER client (must be refused) —");
    for (const p of [
      `/c/${forbidden.slug}`,
      `/api/c/${forbidden.slug}/branding`,
      `/api/c/${forbidden.slug}/branding/logo`,
      `/api/c/${forbidden.slug}/export`,
      `/api/c/${forbidden.slug}/layout`,
      `/api/c/${forbidden.slug}/creative/123/thumb`,
    ]) {
      const s = await get(p);
      check(p, s !== 200, `HTTP ${s}${s === 200 ? "  ← LEAK" : ""}`);
    }

    console.log("\n  — agency-only surfaces (must be refused) —");
    for (const p of ["/api/clients", `/api/clients/${forbidden.id}`, `/api/clients/${forbidden.id}/health`,
                     `/api/clients/${granted.id}/health`, "/api/users", "/api/agency/settings", "/users", "/settings"]) {
      const s = await get(p);
      check(p, s !== 200, `HTTP ${s}${s === 200 ? "  ← LEAK" : ""}`);
    }

    console.log(`\n${pass} passed, ${fail} failed`);
  } finally {
    await sql`DELETE FROM user_clients WHERE user_id=${user.id}`;
    await sql`DELETE FROM users WHERE id=${user.id}`;
    const [left] = (await sql`SELECT COUNT(*)::int n FROM users`) as any[];
    console.log(`\ncleanup: probe account deleted; ${left.n} users remain (was 0)`);
  }
  if (fail) process.exitCode = 1;
}
main();
