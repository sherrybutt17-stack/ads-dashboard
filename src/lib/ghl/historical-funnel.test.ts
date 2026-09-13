import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { sql } from "drizzle-orm";
import {
  createTestDb,
  CLIENT_A,
  type TestDb,
} from "@/lib/metrics/__testdb__/harness";
import { windowFromKeys } from "@/lib/dates";
import { costPer } from "@/lib/metrics/compute";
import type { Client } from "@/db/schema";

/**
 * The historical funnel, end to end: the webhook WRITER and the dashboard
 * READER asserted together, against a real Postgres.
 *
 * ── Why this file exists ──────────────────────────────────────────────
 *
 * This is the product's central claim, and nothing covered it. `process.test.ts`
 * proves the ledger rows are written correctly; `creative-queries.test.ts`
 * proves `getFunnelCounts` filters by paid lead correctly. Neither asserts the
 * property the whole dashboard is sold on:
 *
 *   when a lead moves New → Conversation → Appointment → Show,
 *   every earlier count STAYS.
 *
 * A current-stage pipeline count — which is what GoHighLevel itself shows, and
 * what any reasonable person would build first — reports `new_lead: 0` the
 * instant the lead is contacted, because the lead is no longer sitting in that
 * stage. Every cost-per-stage figure then divides by a denominator that empties
 * as the month succeeds, so the better the month goes, the worse cost per lead
 * looks. That failure is silent, directionally backwards, and invisible to a
 * typechecker, a lint rule and every test in this repository until now.
 *
 * The two halves are tested TOGETHER on purpose. Each is individually correct
 * today; what is untested is that they agree, and a regression in either one
 * produces the same wrong number on screen.
 */

let harness: { db: TestDb; close: () => Promise<void> };

vi.mock("@/db", () => ({
  get db() {
    return harness.db;
  },
  schema: {},
}));

vi.mock("@/lib/crypto", () => ({
  decryptNullable: (v: string | null) => v,
  encrypt: (v: string) => v,
  decrypt: (v: string) => v,
}));

/** The network. Everything below it is real Postgres. */
vi.mock("./client", () => ({
  GhlClient: class {
    async getOpportunity() {
      return null;
    }
    async getContact() {
      return null;
    }
  },
}));

let mod: typeof import("./process");
let q: typeof import("@/lib/metrics/queries");

const PIPELINE = "pip0000000000000001";
const STAGE: Record<string, string> = {
  new_lead: "aaaaaaaa-0000-4000-8000-000000000001",
  contacted: "aaaaaaaa-0000-4000-8000-000000000002",
  appointment_booked: "aaaaaaaa-0000-4000-8000-000000000003",
  showed: "aaaaaaaa-0000-4000-8000-000000000004",
  no_show: "aaaaaaaa-0000-4000-8000-000000000005",
  closed_won: "aaaaaaaa-0000-4000-8000-000000000006",
};

const client = (): Client =>
  ({
    id: CLIENT_A,
    name: "QA",
    slug: "qa",
    timezone: "America/New_York",
    ghlAuthMethod: "pit",
    ghlTokenEncrypted: "token",
  }) as Client;

async function run(query: string) {
  return (await harness.db.execute(sql.raw(query))) as unknown as {
    rows: Record<string, unknown>[];
  };
}

async function newEvent(): Promise<string> {
  const r = await run(
    `INSERT INTO webhook_events (client_id, payload) VALUES ('${CLIENT_A}', '{}'::jsonb) RETURNING id`,
  );
  return r.rows[0].id as string;
}

/** A Meta campaign id, so these leads pass the default paid-lead filter. */
const CAMPAIGN = "120000000000000001";

/**
 * Deliver one stage-change webhook exactly as the receiver would.
 *
 * The contact is stamped with a campaign id afterwards because the GHL client
 * is mocked out here, and `getFunnelCounts` runs under `DEFAULT_LEAD_FILTER`
 * (`either`) — which counts only leads carrying a Meta campaign id or the
 * client's paid tag. Without it every assertion below would read zero for the
 * right reason and prove nothing about stage accumulation. Attributing them
 * keeps these tests on the same code path the dashboard actually uses.
 */
async function move(opp: string, contact: string, stage: string, at: string) {
  const res = await mod.processWebhookEvent(await newEvent(), client(), {
    type: "OpportunityStageUpdate",
    id: opp,
    contactId: contact,
    pipelineId: PIPELINE,
    pipelineStageId: STAGE[stage] ?? stage,
    status: "open",
    /*
     * `timestamp` is the envelope field the normalizer reads, and with the GHL
     * REST client mocked out it is the ONLY thing that sets `changed_at`.
     * Passing `lastStageChangeAt` alone silently falls through to `new Date()`,
     * which makes every date-window assertion below pass for the wrong reason —
     * it did, until this line.
     */
    timestamp: at,
    lastStageChangeAt: at,
  });
  await run(
    `UPDATE contacts SET meta_campaign_id = '${CAMPAIGN}'
      WHERE client_id = '${CLIENT_A}' AND meta_campaign_id IS NULL`,
  );
  return res;
}

/** The exact window the dashboard uses for September 2026, client-local. */
const september = () =>
  windowFromKeys("2026-09-01", "2026-09-30", "America/New_York");

/** Only the stages that actually have a count, so assertions read clearly. */
async function funnel() {
  const f = await q.getFunnelCounts(CLIENT_A, september());
  return Object.fromEntries(
    Object.entries(f).filter(([, v]) => (v as number) > 0),
  );
}

beforeAll(async () => {
  harness = await createTestDb();
  mod = await import("./process");
  q = await import("@/lib/metrics/queries");
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await run(
    `TRUNCATE stage_transitions, opportunities, pipeline_stages, contacts,
              webhook_events, clients RESTART IDENTITY CASCADE`,
  );
  await run(
    `INSERT INTO clients (id, name, slug, timezone) VALUES ('${CLIENT_A}', 'QA', 'qa', 'America/New_York')`,
  );
  for (const [canonical, ghlId] of Object.entries(STAGE)) {
    await run(
      `INSERT INTO pipeline_stages (client_id, ghl_pipeline_id, ghl_stage_id, canonical_stage)
       VALUES ('${CLIENT_A}', '${PIPELINE}', '${ghlId}', '${canonical}')`,
    );
  }
});

describe("the historical funnel retains every stage a lead passed through", () => {
  it("🔴 counts do not move to the new stage — they accumulate", async () => {
    const [o, c] = ["opp0000000000000001", "cnt0000000000000001"];

    await move(o, c, "new_lead", "2026-09-05T10:00:00Z");
    expect(await funnel()).toEqual({ new_lead: 1, new_lead_qualified: 1 });

    /*
     * The assertion the entire product rests on. A current-stage count reports
     * `new_lead: 0` here, because the lead has left that stage.
     */
    await move(o, c, "contacted", "2026-09-06T10:00:00Z");
    expect(await funnel()).toEqual({
      new_lead: 1,
      new_lead_qualified: 1,
      contacted: 1,
    });

    await move(o, c, "appointment_booked", "2026-09-07T10:00:00Z");
    expect(await funnel()).toEqual({
      new_lead: 1,
      new_lead_qualified: 1,
      contacted: 1,
      appointment_booked: 1,
    });

    await move(o, c, "showed", "2026-09-08T10:00:00Z");
    expect(await funnel()).toEqual({
      new_lead: 1,
      new_lead_qualified: 1,
      contacted: 1,
      appointment_booked: 1,
      showed: 1,
    });
  });

  it("🔴 cost per stage stays finite as the lead advances", async () => {
    // The business consequence of the test above, stated in dollars: if the
    // denominators emptied, every one of these would flip to null mid-month and
    // the dashboard would report "-" for a campaign that was working.
    const [o, c] = ["opp0000000000000002", "cnt0000000000000002"];
    for (const [stage, at] of [
      ["new_lead", "2026-09-05T10:00:00Z"],
      ["contacted", "2026-09-06T10:00:00Z"],
      ["appointment_booked", "2026-09-07T10:00:00Z"],
      ["showed", "2026-09-08T10:00:00Z"],
    ] as const) {
      await move(o, c, stage, at);
    }
    const f = await q.getFunnelCounts(CLIENT_A, september());
    const spend = 400;
    expect(costPer(spend, f.new_lead)).toBe(400);
    expect(costPer(spend, f.contacted)).toBe(400);
    expect(costPer(spend, f.appointment_booked)).toBe(400);
    expect(costPer(spend, f.showed)).toBe(400);
  });

  it("counts an opportunity once per stage however often it re-enters", async () => {
    /*
     * A lead bounced back and forth must not inflate the funnel: the count is
     * DISTINCT opportunities that entered the stage, not raw transitions.
     * Otherwise an attentive salesperson dragging a card twice makes cost per
     * appointment look half what it is.
     */
    const [o, c] = ["opp0000000000000003", "cnt0000000000000003"];
    await move(o, c, "new_lead", "2026-09-05T10:00:00Z");
    await move(o, c, "contacted", "2026-09-06T10:00:00Z");
    await move(o, c, "appointment_booked", "2026-09-07T10:00:00Z");
    await move(o, c, "contacted", "2026-09-08T10:00:00Z");
    await move(o, c, "appointment_booked", "2026-09-09T10:00:00Z");

    expect(await funnel()).toEqual({
      new_lead: 1,
      new_lead_qualified: 1,
      contacted: 1,
      appointment_booked: 1,
    });

    // …while the ledger still holds every individual move, so the history is
    // not lost — only the counting is deduplicated.
    const rows = await run(
      `SELECT COUNT(*)::int AS n FROM stage_transitions WHERE client_id = '${CLIENT_A}'`,
    );
    expect(rows.rows[0].n).toBe(5);
  });

  it("🔴 moving backwards never removes a stage already reached", async () => {
    const [o, c] = ["opp0000000000000004", "cnt0000000000000004"];
    await move(o, c, "new_lead", "2026-09-05T10:00:00Z");
    await move(o, c, "appointment_booked", "2026-09-06T10:00:00Z");
    await move(o, c, "showed", "2026-09-07T10:00:00Z");
    const atPeak = await funnel();

    // The appointment did happen. A later correction in the CRM cannot unmake
    // it, and the month's cost per show must not change retroactively.
    await move(o, c, "contacted", "2026-09-08T10:00:00Z");
    expect(await funnel()).toEqual({ ...atPeak, contacted: 1 });
  });

  it("a no-show and a show are separate stages, not one another's absence", async () => {
    const a = ["opp0000000000000005", "cnt0000000000000005"] as const;
    const b = ["opp0000000000000006", "cnt0000000000000006"] as const;
    for (const [o, c] of [a, b]) {
      await move(o, c, "new_lead", "2026-09-05T10:00:00Z");
      await move(o, c, "appointment_booked", "2026-09-06T10:00:00Z");
    }
    await move(a[0], a[1], "showed", "2026-09-07T10:00:00Z");
    await move(b[0], b[1], "no_show", "2026-09-07T10:00:00Z");

    expect(await funnel()).toEqual({
      new_lead: 2,
      new_lead_qualified: 2,
      appointment_booked: 2,
      showed: 1,
      no_show: 1,
    });
  });

  it("🔴 a stage entered outside the window is not counted inside it", async () => {
    // The window is the client's OWN timezone, and the boundary is where a
    // month-on-month table silently double-counts if it is got wrong.
    const [o, c] = ["opp0000000000000007", "cnt0000000000000007"];
    // 2026-09-01 03:30 UTC is 2026-08-31 23:30 in New York — August, not
    // September.
    await move(o, c, "new_lead", "2026-09-01T03:30:00Z");
    expect(await funnel()).toEqual({});

    const august = windowFromKeys("2026-08-01", "2026-08-31", "America/New_York");
    const f = await q.getFunnelCounts(CLIENT_A, august);
    expect(f.new_lead).toBe(1);
  });

  it("an unmapped stage is held in the ledger but never counted as a guess", async () => {
    const [o, c] = ["opp0000000000000008", "cnt0000000000000008"];
    await move(o, c, "new_lead", "2026-09-05T10:00:00Z");
    await move(o, c, "aaaaaaaa-0000-4000-8000-0000000000ff", "2026-09-06T10:00:00Z");

    // Counted stages are unchanged…
    expect(await funnel()).toEqual({ new_lead: 1, new_lead_qualified: 1 });
    // …but the transition was still recorded, so mapping the stage later
    // recovers it. This is why the receiver must never drop an unknown stage.
    const rows = await run(
      `SELECT COUNT(*)::int AS n FROM stage_transitions
        WHERE client_id = '${CLIENT_A}' AND to_canonical IS NULL`,
    );
    expect(rows.rows[0].n).toBe(1);
  });

  it("🔴 a redelivered event cannot inflate any stage count", async () => {
    // GHL retries ~12 times with jitter. The funnel READ must be unaffected,
    // not merely the ledger write.
    const [o, c] = ["opp0000000000000009", "cnt0000000000000009"];
    await move(o, c, "new_lead", "2026-09-05T10:00:00Z");
    await move(o, c, "appointment_booked", "2026-09-06T10:00:00Z");
    const before = await funnel();

    for (let i = 0; i < 12; i++) {
      await move(o, c, "appointment_booked", "2026-09-06T10:00:00Z");
    }
    expect(await funnel()).toEqual(before);
  });
});
