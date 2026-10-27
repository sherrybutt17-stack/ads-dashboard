import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, CLIENT_A, CLIENT_B, type TestDb } from "./__testdb__/harness";

/**
 * The campaign table's ad sets, against a real Postgres: spend summed from the
 * ad-level rows, and the funnel grouped by the ad set each lead carries.
 */

let harness: { db: TestDb; close: () => Promise<void> };

vi.mock("@/db", () => ({
  get db() {
    return harness.db;
  },
  schema: {},
}));

let q: typeof import("./queries");

const OCTOBER = {
  startKey: "2026-10-01",
  endKey: "2026-10-31",
  startUtc: new Date("2026-10-01T00:00:00Z"),
  endUtc: new Date("2026-11-01T00:00:00Z"),
};

const run = async (text: string) =>
  (await harness.db.execute(sql.raw(text))) as unknown as { rows: Record<string, unknown>[] };
const lit = (v: string | null) => (v === null ? "NULL" : `'${v}'`);

/** One lead: a contact carrying these ids, entering each stage in October. */
async function lead(n: number, clientId: string, campaign: string | null, adset: string | null, stages = ["new_lead"]) {
  const contact = (
    await run(
      `INSERT INTO contacts (client_id, ghl_contact_id, meta_campaign_id, meta_adset_id)
       VALUES ('${clientId}', 'ct-${n}', ${lit(campaign)}, ${lit(adset)}) RETURNING id`,
    )
  ).rows[0].id;
  const opp = (
    await run(`INSERT INTO opportunities (client_id, ghl_opportunity_id) VALUES ('${clientId}', 'opp-${n}') RETURNING id`)
  ).rows[0].id;
  for (const stage of stages) {
    await run(
      `INSERT INTO stage_transitions (client_id, opportunity_id, contact_id, to_canonical, changed_at)
       VALUES ('${clientId}', '${opp}', '${contact}', '${stage}', '2026-10-05T12:00:00Z')`,
    );
  }
}

beforeAll(async () => {
  harness = await createTestDb();
  q = await import("./queries");
  await run(`
    INSERT INTO fb_daily_metrics (client_id, date, level, meta_campaign_id, meta_adset_id, meta_ad_id, adset_name, spend) VALUES
      ('${CLIENT_A}', '2026-09-20', 'ad', 'c1', 'a1', 'ad1', 'Broad', 10),
      ('${CLIENT_A}', '2026-10-02', 'ad', 'c1', 'a1', 'ad1', 'Broad', 100),
      ('${CLIENT_A}', '2026-10-03', 'ad', 'c1', 'a1', 'ad2', 'Broad', 50),
      ('${CLIENT_A}', '2026-10-03', 'ad', 'c1', 'a2', 'ad3', 'Lookalike', 25),
      ('${CLIENT_A}', '2026-10-03', 'campaign', 'c1', '', '', NULL, 175),
      ('${CLIENT_B}', '2026-10-03', 'ad', 'c9', 'a9', 'ad9', 'Not ours', 999);
  `);
  await lead(1, CLIENT_A, "c1", "a1", ["new_lead", "appointment_booked"]);
  await lead(2, CLIENT_A, "c1", "a1");
  await lead(3, CLIENT_A, "c1", "a2");
  await lead(4, CLIENT_A, "c1", null); // campaign known, ad set not recorded
  await lead(5, CLIENT_B, "c9", "a9");
});

afterAll(async () => {
  await harness.close();
});

describe("getAdsetBreakdown", () => {
  it("sums each ad set's ads in the window — this client, ad rows only", async () => {
    const { rows, adLevelSince } = await q.getAdsetBreakdown(CLIENT_A, OCTOBER);
    expect([...rows].sort((a, b) => a.adsetId.localeCompare(b.adsetId))).toEqual([
      { campaignId: "c1", adsetId: "a1", adsetName: "Broad", spend: 150 },
      { campaignId: "c1", adsetId: "a2", adsetName: "Lookalike", spend: 25 },
    ]);
    // The first ad-level day at all, not the window's — it explains a gap.
    expect(adLevelSince).toBe("2026-09-20");
  });

  it("knows when a client has no ad-level history", async () => {
    const empty = await q.getAdsetBreakdown("55555555-5555-5555-5555-555555555555", OCTOBER);
    expect(empty).toEqual({ rows: [], adLevelSince: null });
  });
});

describe("getFunnelByAdset", () => {
  it("counts distinct leads per campaign and ad set, leaving out leads with no ad set", async () => {
    const f = await q.getFunnelByAdset(CLIENT_A, OCTOBER);
    expect([...f.keys()]).toEqual(["c1"]);
    expect(Object.fromEntries(f.get("c1")!)).toEqual({
      a1: { new_lead: 2, appointment_booked: 1 },
      a2: { new_lead: 1 },
    });
  });
});
