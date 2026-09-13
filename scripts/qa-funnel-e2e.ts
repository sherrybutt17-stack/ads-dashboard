import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";

/**
 * Serial, retrying database access.
 *
 * Measured, not guessed: from this network the Neon HTTP endpoint completes
 * 11 of 12 SERIAL statements but only 2 of 12 issued in PARALLEL, the rest
 * failing with `UND_ERR_CONNECT_TIMEOUT`. The driver opens one TLS connection
 * per statement, so a burst exhausts the outbound path. That is a property of
 * this machine, not of the application — production runs the pooled WebSocket
 * driver on Vercel — but it will silently turn a passing assertion into a
 * crashed run, so every statement here goes through one retrying gate.
 */
const BASE = process.env.QA_BASE ?? "http://localhost:3001";
const raw = neon(process.env.DATABASE_URL!);

let chain: Promise<unknown> = Promise.resolve();
const sql = ((strings: TemplateStringsArray, ...vals: unknown[]) => {
  const run = async () => {
    let last: unknown;
    for (let i = 0; i < 6; i++) {
      try {
        return await (raw as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>)(strings, ...vals);
      } catch (e) {
        last = e;
        if (!/fetch failed|Connect Timeout/i.test(String((e as Error)?.message))) throw e;
        await new Promise((r) => setTimeout(r, 800 * (i + 1)));
      }
    }
    throw last;
  };
  // Serialise: overlapping statements are what the measurement above rules out.
  const next = chain.then(run, run);
  chain = next.catch(() => undefined);
  return next as Promise<any[]>;
}) as unknown as typeof raw;

const AGENCY = "00000000-0000-0000-0000-000000000001";

const PIPE = "QAPIPE" + Math.random().toString(36).slice(2, 10);
const STAGES = {
  new_lead: "qa-stage-new",
  contacted: "qa-stage-conv",
  appointment_booked: "qa-stage-appt",
  showed: "qa-stage-show",
  no_show: "qa-stage-noshow",
  closed_won: "qa-stage-won",
  lost: "qa-stage-lost",
} as const;

let pass = 0, fail = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ✅ ${label}: ${a}`); }
  else { fail++; console.log(`  ❌ ${label}\n       expected ${e}\n       actual   ${a}`); }
}

async function funnel(clientId: string) {
  const rows = (await sql`
    SELECT to_canonical stage, COUNT(DISTINCT opportunity_id)::int n
      FROM stage_transitions WHERE client_id=${clientId} AND to_canonical IS NOT NULL
     GROUP BY 1`) as any[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.stage] = Number(r.n);
  return out;
}

async function post(token: string, body: unknown) {
  const r = await fetch(`${BASE}/api/webhooks/crm/${token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.text() };
}

async function main() {
  const token = "qa" + randomUUID().replace(/-/g, "");
  const slug = "qa-funnel-probe-" + Math.random().toString(36).slice(2, 7);
  const [client] = (await sql`
    INSERT INTO clients (name, slug, webhook_token, agency_id, timezone, status)
    VALUES (${"QA FUNNEL PROBE — DELETE ME"}, ${slug}, ${token}, ${AGENCY}, 'America/New_York', 'active')
    RETURNING id`) as any[];
  console.log(`client ${slug} (${client.id})\nwebhook token ${token.slice(0, 10)}…\n`);

  try {
    for (const [canonical, ghlId] of Object.entries(STAGES)) {
      await sql`INSERT INTO pipeline_stages (client_id, ghl_pipeline_id, ghl_stage_id, ghl_stage_name, canonical_stage)
                VALUES (${client.id}, ${PIPE}, ${ghlId}, ${canonical}, ${canonical})`;
    }

    const oppId = "QAOPP" + Math.random().toString(36).slice(2, 12);
    const contactId = "QACON" + Math.random().toString(36).slice(2, 12);
    const evt = (stage: string, at: string) => ({
      type: "OpportunityStageUpdate",
      id: oppId, opportunityId: oppId, contactId,
      pipelineId: PIPE, pipelineStageId: stage,
      name: "QA TEST — DO NOT CONTACT",
      lastStageChangeAt: at,
      locationId: "QA_LOCATION",
    });

    console.log("§17 STAGE PROGRESSION — each step must RETAIN the earlier ones");
    const t0 = Date.parse("2026-09-13T10:00:00Z");
    const iso = (m: number) => new Date(t0 + m * 60000).toISOString();

    let r = await post(token, evt(STAGES.new_lead, iso(0)));
    check("webhook accepted (HTTP)", r.status, 200);
    check("after New Lead", await funnel(client.id), { new_lead: 1 });

    await post(token, evt(STAGES.contacted, iso(10)));
    check("after → Conversation (new_lead RETAINED)", await funnel(client.id), { new_lead: 1, contacted: 1 });

    await post(token, evt(STAGES.appointment_booked, iso(20)));
    check("after → Appointment", await funnel(client.id), { new_lead: 1, contacted: 1, appointment_booked: 1 });

    await post(token, evt(STAGES.showed, iso(30)));
    check("after → Show", await funnel(client.id),
      { new_lead: 1, contacted: 1, appointment_booked: 1, showed: 1 });

    console.log("\n§58 WEBHOOK IDEMPOTENCY — same event delivered 3×");
    const dup = evt(STAGES.showed, iso(30));
    await post(token, dup); await post(token, dup);
    check("counts unchanged after duplicates", await funnel(client.id),
      { new_lead: 1, contacted: 1, appointment_booked: 1, showed: 1 });
    const [tc] = (await sql`SELECT COUNT(*)::int n FROM stage_transitions WHERE client_id=${client.id}`) as any[];
    check("stage_transitions rows (no duplicate ledger rows)", tc.n, 4);

    console.log("\n§20 BACKWARDS MOVEMENT — Show → Conversation must not erase history");
    await post(token, evt(STAGES.contacted, iso(40)));
    check("history retained after moving backwards", await funnel(client.id),
      { new_lead: 1, contacted: 1, appointment_booked: 1, showed: 1 });
    const [tc2] = (await sql`SELECT COUNT(*)::int n FROM stage_transitions WHERE client_id=${client.id}`) as any[];
    check("a 5th transition WAS appended (re-entry recorded)", tc2.n, 5);
    check("contacted still counts the opportunity ONCE (distinct)", (await funnel(client.id)).contacted, 1);

    console.log("\n§59 OUT-OF-ORDER DELIVERY — a stale event must not rewrite state");
    const before = await funnel(client.id);
    await post(token, evt(STAGES.new_lead, iso(5)));
    check("stale event did not change the funnel", await funnel(client.id), before);

    console.log("\n§21 UNMAPPED STAGE — must be recorded, never dropped");
    await post(token, evt("qa-stage-UNMAPPED", iso(50)));
    const [um] = (await sql`
      SELECT COUNT(*)::int n FROM stage_transitions
       WHERE client_id=${client.id} AND to_stage_ghl_id='qa-stage-UNMAPPED'`) as any[];
    check("unmapped transition still written to the ledger", um.n, 1);
    const [umc] = (await sql`
      SELECT COUNT(*)::int n FROM stage_transitions
       WHERE client_id=${client.id} AND to_stage_ghl_id='qa-stage-UNMAPPED' AND to_canonical IS NULL`) as any[];
    check("…and is left uncounted (to_canonical NULL) rather than guessed", umc.n, 1);

    console.log("\n§39 TENANT ISOLATION — another client's token must not reach this data");
    const bogus = await post("qa" + randomUUID().replace(/-/g, ""), evt(STAGES.new_lead, iso(60)));
    check("unknown token rejected", bogus.status, 404);
    const [leak] = (await sql`
      SELECT COUNT(*)::int n FROM stage_transitions WHERE client_id=${client.id}`) as any[];
    check("no rows leaked into this client from the unknown token", leak.n, 6);

    console.log(`\n${pass} passed, ${fail} failed`);
  } finally {
    await sql`DELETE FROM clients WHERE id=${client.id}`;
    const [left] = (await sql`SELECT COUNT(*)::int n FROM stage_transitions WHERE client_id=${client.id}`) as any[];
    console.log(`\ncleanup: client deleted, ${left.n} orphan transitions remain (must be 0)`);
  }
  if (fail) process.exitCode = 1;
}
main();
