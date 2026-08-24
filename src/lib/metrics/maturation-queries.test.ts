import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, CLIENT_A, CLIENT_B, type TestDb } from "./__testdb__/harness";
import { windowFromKeys } from "@/lib/dates";

/**
 * The cohort query, against a real Postgres.
 *
 * It inverts the semantics the rest of the query layer is built on — the cohort
 * is the arrival month and conversions are followed forward out of it — so the
 * failure modes are the mirror image of the usual ones:
 *
 *   · bound conversions to their own month → the exact reading this module
 *     exists to correct, computed with extra steps
 *   · MAX instead of MIN                   → a re-entered lead's age measured to
 *     the last time it reached the stage
 *   · month keyed in UTC                   → a lead arriving at 5pm on the 31st
 *     lands in the following month's cohort
 */

let harness: { db: TestDb; close: () => Promise<void> };

vi.mock("@/db", () => ({
  get db() {
    return harness.db;
  },
  schema: {},
}));

let q: typeof import("./queries");

const TZ = "America/Los_Angeles";

/** June, July and August 2026 as the loader builds them. */
const MONTHS = [
  { monthKey: "2026-06", ...windowFromKeys("2026-06-01", "2026-06-30", TZ) },
  { monthKey: "2026-07", ...windowFromKeys("2026-07-01", "2026-07-31", TZ) },
  { monthKey: "2026-08", ...windowFromKeys("2026-08-01", "2026-08-31", TZ) },
];

beforeAll(async () => {
  harness = await createTestDb();
  q = await import("./queries");
  await seed(harness.db);
});

afterAll(async () => {
  await harness?.close();
});

const C = {
  juneClose: "aaaa5000-0000-0000-0000-000000000001",
  juneBoundary: "aaaa5000-0000-0000-0000-000000000002",
  julyRebook: "aaaa5000-0000-0000-0000-000000000003",
  julyOrganic: "aaaa5000-0000-0000-0000-000000000004",
  julyPreLead: "aaaa5000-0000-0000-0000-000000000005",
  bClient: "bbbb5000-0000-0000-0000-000000000001",
  mayOld: "aaaa5000-0000-0000-0000-000000000006",
};
const O = {
  juneClose: "aaaa6000-0000-0000-0000-000000000001",
  juneBoundary: "aaaa6000-0000-0000-0000-000000000002",
  julyRebook: "aaaa6000-0000-0000-0000-000000000003",
  julyOrganic: "aaaa6000-0000-0000-0000-000000000004",
  julyPreLead: "aaaa6000-0000-0000-0000-000000000005",
  mayOld: "aaaa6000-0000-0000-0000-000000000006",
};

async function seed(db: TestDb) {
  const run = (s: string) => db.execute(sql.raw(s));

  await run(`
    INSERT INTO contacts (id, client_id, ghl_contact_id, meta_campaign_id, ghl_created_at) VALUES
      ('${C.juneClose}',    '${CLIENT_A}', 'a1', 'camp_1', '2026-06-05T17:00:00Z'),
      /* 🔴 5pm on 31 July in Los Angeles — but 1 AUGUST in UTC. A July lead. */
      ('${C.juneBoundary}', '${CLIENT_A}', 'a2', 'camp_1', '2026-08-01T00:30:00Z'),
      ('${C.julyRebook}',   '${CLIENT_A}', 'a3', 'camp_1', '2026-07-05T17:00:00Z'),
      ('${C.julyOrganic}',  '${CLIENT_A}', 'a4', NULL,     '2026-07-06T17:00:00Z'),
      ('${C.julyPreLead}',  '${CLIENT_A}', 'a5', 'camp_1', '2026-07-07T17:00:00Z'),
      ('${C.bClient}',      '${CLIENT_B}', 'b1', 'camp_1', '2026-07-05T17:00:00Z'),
      /* Older than the oldest month in the list — outside every cohort. */
      ('${C.mayOld}',       '${CLIENT_A}', 'a6', 'camp_1', '2026-05-10T17:00:00Z')
  `);

  await run(`
    INSERT INTO opportunities (id, client_id, ghl_opportunity_id, contact_id) VALUES
      ('${O.juneClose}',    '${CLIENT_A}', 'o1', '${C.juneClose}'),
      ('${O.juneBoundary}', '${CLIENT_A}', 'o2', '${C.juneBoundary}'),
      ('${O.julyRebook}',   '${CLIENT_A}', 'o3', '${C.julyRebook}'),
      ('${O.julyOrganic}',  '${CLIENT_A}', 'o4', '${C.julyOrganic}'),
      ('${O.julyPreLead}',  '${CLIENT_A}', 'o5', '${C.julyPreLead}'),
      ('${O.mayOld}',       '${CLIENT_A}', 'o6', '${C.mayOld}')
  `);

  const t = (opp: string, contact: string, stage: string, at: string, client = CLIENT_A) =>
    `('${client}', '${opp}', '${contact}', '${stage}', '${at}')`;

  await run(`
    INSERT INTO stage_transitions (client_id, opportunity_id, contact_id, to_canonical, changed_at) VALUES
      ${[
        /*
         * 🔴 A June lead that closed on 20 SEPTEMBER — 107 days later, three
         * months outside its own cohort. It belongs to June and the engine
         * needs its age, because that tail is exactly what makes a recent month
         * look weak.
         */
        t(O.juneClose, C.juneClose, "appointment_booked", "2026-06-20T17:00:00Z"),
        t(O.juneClose, C.juneClose, "closed_won", "2026-09-20T17:00:00Z"),

        // Booked, fell back, booked again: measured to the FIRST time.
        t(O.julyRebook, C.julyRebook, "appointment_booked", "2026-07-10T17:00:00Z"),
        t(O.julyRebook, C.julyRebook, "appointment_booked", "2026-08-20T17:00:00Z"),

        // Not a paid lead — must not appear at all.
        t(O.julyOrganic, C.julyOrganic, "appointment_booked", "2026-07-12T17:00:00Z"),

        // Stamped before its own contact existed. Not an outcome of it.
        t(O.julyPreLead, C.julyPreLead, "appointment_booked", "2026-07-01T17:00:00Z"),

        // Another tenant's ledger row against this tenant's contact.
        t(O.juneClose, C.juneClose, "showed", "2026-06-25T17:00:00Z", CLIENT_B),

        /*
         * Funnel steps that are NOT outcomes. Every lead has a new_lead row and
         * most have a contacted row, so a widened stage filter would multiply
         * the conversion set several-fold — and a "closes" curve built partly
         * from same-day new_lead rows would say closes land instantly.
         */
        t(O.juneClose, C.juneClose, "new_lead", "2026-06-05T17:00:00Z"),
        t(O.juneClose, C.juneClose, "contacted", "2026-06-06T17:00:00Z"),
        t(O.julyRebook, C.julyRebook, "new_lead", "2026-07-05T17:00:00Z"),
        t(O.julyRebook, C.julyRebook, "lost", "2026-07-30T17:00:00Z"),

        // A May lead's booking. May is outside the requested months entirely.
        t(O.mayOld, C.mayOld, "appointment_booked", "2026-05-20T17:00:00Z"),
      ].join(",\n      ")}
  `);
}

const load = () => q.getCohortMaturation(CLIENT_A, MONTHS, TZ);

describe("monthly lead cohorts", () => {
  it("counts leads into the month they arrived, in the client's timezone", async () => {
    const { leadsByMonth } = await load();
    expect(leadsByMonth.get("2026-06")).toBe(1);
    expect(leadsByMonth.get("2026-07")).toBe(3);
  });

  it("🔴 puts a lead that arrived at 5pm on the 31st in the right month", async () => {
    /*
     * 2026-08-01T00:30Z is 5:30pm on 31 July in Los Angeles. Keyed in UTC it
     * would open August's cohort with a lead that belongs to July — and since
     * the newest cohort is the one the whole comparison hangs on, a single
     * misfiled lead at a month boundary shifts the verdict.
     */
    const { leadsByMonth } = await load();
    expect(leadsByMonth.get("2026-08") ?? 0).toBe(0);
    expect(leadsByMonth.get("2026-07")).toBe(3);
  });

  it("applies the paid-lead filter", async () => {
    const all = await q.getCohortMaturation(CLIENT_A, MONTHS, TZ, { mode: "all", tag: "" });
    expect(all.leadsByMonth.get("2026-07")).toBe(4);
  });

  it("returns nothing for an empty month list rather than scanning everything", async () => {
    const r = await q.getCohortMaturation(CLIENT_A, [], TZ);
    expect(r.leadsByMonth.size).toBe(0);
    expect(r.conversions).toEqual([]);
  });
});

describe("conversions the cohort went on to produce", () => {
  it("🔴 follows a cohort forward out of its own month", async () => {
    // A June lead closing in September. Bounded to June it would vanish, and
    // June would read as a month that produced nothing.
    const { conversions } = await load();
    const close = conversions.find((c) => c.stage === "closed_won")!;
    expect(close.month).toBe("2026-06");
    expect(close.days).toBeCloseTo(107, 0);
  });

  it("🔴 measures to the FIRST time a stage was reached", async () => {
    const { conversions } = await load();
    const booked = conversions.filter(
      (c) => c.month === "2026-07" && c.stage === "appointment_booked",
    );
    expect(booked).toHaveLength(1);
    expect(booked[0].days).toBeCloseTo(5, 0); // not 46
  });

  it("ignores a transition stamped before its own lead", async () => {
    const { conversions } = await load();
    expect(conversions.every((c) => c.days >= 0)).toBe(true);
    expect(conversions).toHaveLength(3); // booked+closed for June, booked for July
  });

  it("applies the paid-lead filter to conversions too", async () => {
    const { conversions } = await load();
    expect(conversions.filter((c) => c.month === "2026-07")).toHaveLength(1);
    const all = await q.getCohortMaturation(CLIENT_A, MONTHS, TZ, { mode: "all", tag: "" });
    expect(all.conversions.filter((c) => c.month === "2026-07")).toHaveLength(2);
  });

  it("does not read another tenant's ledger", async () => {
    const { conversions } = await load();
    expect(conversions.some((c) => c.stage === "showed")).toBe(false);
  });

  it("🔴 keeps only the three outcome stages", async () => {
    /*
     * Every lead has a new_lead transition and most have a contacted one, so a
     * widened filter multiplies the set several times over — and since a lead's
     * new_lead row lands the same day it arrived, the fill-in curve would
     * report that conversions happen instantly. That reads as "every month is
     * fully matured", which switches the whole correction off.
     */
    const { conversions } = await load();
    expect(
      conversions.every((c) =>
        ["appointment_booked", "showed", "closed_won"].includes(c.stage),
      ),
    ).toBe(true);
    expect(conversions).toHaveLength(3);
  });

  it("🔴 leaves out a cohort older than the months requested", async () => {
    // Without the lower bound, a client's entire history joins every render —
    // and lands in `leadsByMonth` under months nobody asked for.
    const { leadsByMonth, conversions } = await load();
    expect(leadsByMonth.get("2026-05")).toBeUndefined();
    expect(conversions.some((c) => c.month === "2026-05")).toBe(false);
  });
});
