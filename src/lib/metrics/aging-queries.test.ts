import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, CLIENT_A, CLIENT_B, type TestDb } from "./__testdb__/harness";

/**
 * The two queries behind the aging panel, against a real Postgres.
 *
 * The dwell query is the risky one, and the risk is specific to how this
 * product maps stages. GG's pipeline binds eight different GHL stages to
 * `new_lead` and six to `appointment_booked`, so an opportunity shuffled
 * between two of them writes two ledger rows without ever leaving the canonical
 * stage. Measured per transition, each shuffle becomes a completed stay of a
 * few hours, the 90th percentile collapses toward zero, and every lead in the
 * pipeline is reported as overdue.
 *
 *   · runs not collapsed        → thresholds collapse, the panel flags everyone
 *   · in-progress stay counted  → a zero-day stay per opportunity, same effect
 *   · dwell keyed to the wrong  → Contacted judged against how long people wait
 *     end of the gap              for an appointment
 *   · status ignored            → won and lost deals listed as neglected leads
 */

let harness: { db: TestDb; close: () => Promise<void> };

vi.mock("@/db", () => ({
  get db() {
    return harness.db;
  },
  schema: {},
}));

let q: typeof import("./queries");

beforeAll(async () => {
  harness = await createTestDb();
  q = await import("./queries");
  await seed(harness.db);
});

afterAll(async () => {
  await harness?.close();
});

const daysSince = (iso: string) => (Date.now() - Date.parse(iso)) / 86_400_000;

/* ------------------------------------------------------------------ *
 * Fixture
 * ------------------------------------------------------------------ */

const C = {
  paid: "aaaa2000-0000-0000-0000-000000000001",
  organic: "aaaa2000-0000-0000-0000-000000000002",
  preTrack: "aaaa2000-0000-0000-0000-000000000003",
  uncalled: "aaaa2000-0000-0000-0000-000000000004",
  bClient: "bbbb2000-0000-0000-0000-000000000001",
};

const O = {
  shuffled: "aaaa3000-0000-0000-0000-000000000001",
  reEntered: "aaaa3000-0000-0000-0000-000000000002",
  sitting: "aaaa3000-0000-0000-0000-000000000003",
  won: "aaaa3000-0000-0000-0000-000000000004",
  abandoned: "aaaa3000-0000-0000-0000-000000000005",
  noStatus: "aaaa3000-0000-0000-0000-000000000006",
  unmapped: "aaaa3000-0000-0000-0000-000000000007",
  undated: "aaaa3000-0000-0000-0000-000000000008",
  ledgerOnly: "aaaa3000-0000-0000-0000-000000000009",
  organic: "aaaa3000-0000-0000-0000-00000000000a",
  neverCalled: "aaaa3000-0000-0000-0000-00000000000b",
  preTrack: "aaaa3000-0000-0000-0000-00000000000c",
};

const S = {
  newA: "aaaa4000-0000-0000-0000-000000000001",
  newB: "aaaa4000-0000-0000-0000-000000000002",
  contacted: "aaaa4000-0000-0000-0000-000000000003",
  unmapped: "aaaa4000-0000-0000-0000-000000000004",
};

const TRACKING_START = "2026-07-01T00:00:00Z";

async function seed(db: TestDb) {
  const run = (s: string) => db.execute(sql.raw(s));

  await run(`
    INSERT INTO webhook_events (client_id, event_type, received_at) VALUES
      ('${CLIENT_A}', 'OutboundMessage', '${TRACKING_START}')
  `);

  await run(`
    INSERT INTO pipeline_stages (id, client_id, ghl_pipeline_id, ghl_stage_id, ghl_stage_name, canonical_stage) VALUES
      -- 🔴 TWO GHL stages bound to the same canonical stage, which is the shape
      -- that makes run-collapsing necessary rather than tidy.
      ('${S.newA}',      '${CLIENT_A}', 'p1', 's1', 'New Lead',     'new_lead'),
      ('${S.newB}',      '${CLIENT_A}', 'p1', 's2', 'FB Leads',     'new_lead'),
      ('${S.contacted}', '${CLIENT_A}', 'p1', 's3', 'Contacted',    'contacted'),
      ('${S.unmapped}',  '${CLIENT_A}', 'p1', 's4', 'Long Term Nurture', NULL)
  `);

  await run(`
    INSERT INTO contacts (id, client_id, ghl_contact_id, first_name, meta_campaign_id, ghl_created_at, first_call_at) VALUES
      ('${C.paid}',     '${CLIENT_A}', 'a1', 'Paid',    'camp_1', '2026-07-10T12:00:00Z', '2026-07-10T13:00:00Z'),
      ('${C.organic}',  '${CLIENT_A}', 'a2', 'Organic', NULL,     '2026-07-10T12:00:00Z', '2026-07-10T13:00:00Z'),
      -- Arrived before call tracking: whether anyone called is unknowable.
      ('${C.preTrack}', '${CLIENT_A}', 'a3', 'Early',   'camp_1', '2026-06-01T12:00:00Z', NULL),
      ('${C.uncalled}', '${CLIENT_A}', 'a4', 'Uncalled','camp_1', '2026-07-20T12:00:00Z', NULL),
      ('${C.bClient}',  '${CLIENT_B}', 'b1', 'Other',   'camp_1', '2026-07-10T12:00:00Z', NULL)
  `);

  const opp = (
    id: string,
    contact: string | null,
    stageId: string | null,
    status: string | null,
    lastChange: string | null,
    client = CLIENT_A,
  ) =>
    `('${id}', '${client}', '${id.slice(-4)}', ${contact ? `'${contact}'` : "NULL"}, ` +
    `${stageId ? `'${stageId}'` : "NULL"}, ${status ? `'${status}'` : "NULL"}, ` +
    `${lastChange ? `'${lastChange}'` : "NULL"})`;

  await run(`
    INSERT INTO opportunities (id, client_id, ghl_opportunity_id, contact_id, current_stage_id, status, last_stage_change_at) VALUES
      ${[
        opp(O.shuffled, C.paid, S.contacted, "open", "2026-07-20T00:00:00Z"),
        opp(O.reEntered, C.paid, S.contacted, "open", "2026-07-25T00:00:00Z"),
        opp(O.sitting, C.paid, S.newA, "open", "2026-06-15T00:00:00Z"),
        opp(O.won, C.paid, S.contacted, "won", "2026-06-15T00:00:00Z"),
        opp(O.abandoned, C.paid, S.contacted, "abandoned", "2026-06-15T00:00:00Z"),
        // GHL does not always send a status. Null must be treated as open.
        opp(O.noStatus, C.paid, S.contacted, null, "2026-06-15T00:00:00Z"),
        opp(O.unmapped, C.paid, S.unmapped, "open", "2026-06-15T00:00:00Z"),
        // No stage-change date and no ledger row: age is unknown, not zero.
        opp(O.undated, C.paid, S.contacted, "open", null),
        // No stage-change date, but the ledger knows when it last moved.
        opp(O.ledgerOnly, C.paid, S.contacted, "open", null),
        opp(O.organic, C.organic, S.contacted, "open", "2026-06-15T00:00:00Z"),
        opp(O.neverCalled, C.uncalled, S.contacted, "open", "2026-06-15T00:00:00Z"),
        opp(O.preTrack, C.preTrack, S.contacted, "open", "2026-06-15T00:00:00Z"),
        opp("bbbb3000-0000-0000-0000-000000000001", C.bClient, null, "open", "2026-06-15T00:00:00Z", CLIENT_B),
      ].join(",\n      ")}
  `);

  const t = (opp: string, contact: string, stage: string, at: string, client = CLIENT_A) =>
    `('${client}', '${opp}', '${contact}', '${stage}', '${at}')`;

  await run(`
    INSERT INTO stage_transitions (client_id, opportunity_id, contact_id, to_canonical, changed_at) VALUES
      ${[
        /*
         * 🔴 Shuffled between two GHL stages that BOTH mean new_lead, then
         * moved on for real after ten days. One stay of ten days, not three
         * stays of two, four and four.
         */
        t(O.shuffled, C.paid, "new_lead", "2026-07-10T00:00:00Z"),
        t(O.shuffled, C.paid, "new_lead", "2026-07-12T00:00:00Z"),
        t(O.shuffled, C.paid, "new_lead", "2026-07-16T00:00:00Z"),
        t(O.shuffled, C.paid, "contacted", "2026-07-20T00:00:00Z"),

        // Went cold and came back: two separate stays in new_lead, of two days
        // and one day, because it genuinely left and returned.
        t(O.reEntered, C.paid, "new_lead", "2026-07-10T00:00:00Z"),
        t(O.reEntered, C.paid, "contacted", "2026-07-12T00:00:00Z"),
        t(O.reEntered, C.paid, "new_lead", "2026-07-24T00:00:00Z"),
        t(O.reEntered, C.paid, "contacted", "2026-07-25T00:00:00Z"),

        // Still sitting where it landed — an in-progress stay, not a completed
        // one, and counting it as zero days would drag every threshold down.
        t(O.sitting, C.paid, "new_lead", "2026-06-15T00:00:00Z"),

        // No last_stage_change_at on the opportunity; the ledger supplies it.
        t(O.ledgerOnly, C.paid, "contacted", "2026-06-20T00:00:00Z"),

        // Another tenant's ledger row pointing at this tenant's contact.
        t("bbbb3000-0000-0000-0000-000000000001", C.paid, "new_lead", "2026-01-01T00:00:00Z", CLIENT_B),
        t("bbbb3000-0000-0000-0000-000000000001", C.paid, "contacted", "2026-06-01T00:00:00Z", CLIENT_B),

        /*
         * 🔴 A ledger row attributed to the WRONG TENANT but carrying this
         * tenant's opportunity. Not hypothetical: `stage_transitions.client_id`
         * is written from the webhook token at ingest, so a token routed to the
         * wrong client produces exactly this. The undated opportunity is the
         * one it would silently supply a date for.
         */
        t(O.undated, C.paid, "contacted", "2026-05-01T00:00:00Z", CLIENT_B),
      ].join(",\n      ")}
  `);
}

const load = () => q.getStageAging(CLIENT_A);
const find = async (id: string) =>
  (await load()).sitting.find((s) => s.opportunityId === id)!;

/* ------------------------------------------------------------------ *
 * Completed stays
 * ------------------------------------------------------------------ */

describe("how long stays lasted", () => {
  it("🔴 counts a shuffle between two stages meaning the same thing as ONE stay", async () => {
    /*
     * Asserted as the exact multiset, because the discriminating detail is
     * what is ABSENT. Collapsed, the three fixtures give one ten-day stay
     * (shuffled) plus a two-day and a one-day (re-entered): [1, 2, 10].
     * Per-transition they give 2, 4 and 4 from the shuffle instead of the ten:
     * [1, 2, 2, 4, 4] — five stays, none longer than four days, from a lead
     * that actually sat there a fortnight.
     */
    const { dwells } = await load();
    const newLead = dwells
      .filter((d) => d.stage === "new_lead")
      .map((d) => d.days)
      .sort((a, b) => a - b);
    expect(newLead).toEqual([1, 2, 10]);
  });

  it("🔴 does not count the stay still in progress", async () => {
    // The last run of every opportunity has no next entry. Recorded as a
    // completed stay it would be a zero, once per opportunity, and the 90th
    // percentile of a pile of zeros flags the entire pipeline.
    const { dwells } = await load();
    expect(dwells.every((d) => d.days > 0)).toBe(true);
    // `sitting` has exactly one transition and has never moved on.
    expect(dwells.filter((d) => d.stage === "new_lead")).toHaveLength(3);
  });

  it("records a re-entered stage as two separate stays", async () => {
    const { dwells } = await load();
    const newLead = dwells
      .filter((d) => d.stage === "new_lead")
      .map((d) => d.days)
      .sort((a, b) => a - b);
    expect(newLead).toEqual([1, 2, 10]);
  });

  it("🔴 keys the gap to the stage it was SPENT in, not the one it moved to", async () => {
    // Contacted must be judged against how long people sit in Contacted. Keyed
    // to the far end of the gap, it would be judged against new_lead's timings.
    const { dwells } = await load();
    const contacted = dwells.filter((d) => d.stage === "contacted").map((d) => d.days);
    expect(contacted).toEqual([12]); // 12 Jul → 24 Jul, then it re-entered new_lead
  });

  it("does not read another tenant's ledger", async () => {
    // CLIENT_B has a five-month gap on a contact belonging to CLIENT_A.
    const { dwells } = await load();
    expect(dwells.every((d) => d.days < 100)).toBe(true);
  });

  it("applies the paid-lead filter to the history too", async () => {
    const all = await q.getStageAging(CLIENT_A, { mode: "all", tag: "" });
    const paid = await load();
    expect(all.dwells.length).toBeGreaterThanOrEqual(paid.dwells.length);
  });
});

/* ------------------------------------------------------------------ *
 * What is sitting right now
 * ------------------------------------------------------------------ */

describe("open opportunities", () => {
  it("🔴 leaves out won, lost and abandoned opportunities", async () => {
    const { sitting } = await load();
    const ids = sitting.map((s) => s.opportunityId);
    expect(ids).not.toContain(O.won);
    expect(ids).not.toContain(O.abandoned);
  });

  it("🔴 treats a missing status as open", async () => {
    // GHL does not always send one, and the safe direction is showing a lead
    // that turns out to be closed rather than hiding one that is rotting.
    const { sitting } = await load();
    expect(sitting.map((s) => s.opportunityId)).toContain(O.noStatus);
  });

  it("dates the stay from last_stage_change_at", async () => {
    const row = await find(O.sitting);
    expect(row.daysInStage).toBeCloseTo(daysSince("2026-06-15T00:00:00Z"), 1);
  });

  it("🔴 falls back to the ledger when that column is null", async () => {
    // A null there is "we were not told", not "entered the stage today".
    const row = await find(O.ledgerOnly);
    expect(row.daysInStage).toBeCloseTo(daysSince("2026-06-20T00:00:00Z"), 1);
  });

  it("🔴 reports an undatable stay as null rather than as brand new", async () => {
    const row = await find(O.undated);
    expect(row.daysInStage).toBeNull();
  });

  it("🔴 will not take that fallback date from another tenant's ledger row", async () => {
    /*
     * The join is on `opportunity_id`, a uuid primary key, so an opportunity
     * belongs to one client and the join cannot cross tenants by accident. The
     * client filter is defence against a ledger row attributed to the WRONG
     * tenant — which `stage_transitions.client_id` being written from the
     * webhook token makes a real possibility rather than a theoretical one.
     * Without it, this opportunity picks up a date it has no claim to.
     */
    expect((await find(O.undated)).daysInStage).toBeNull();
    const [row] = await harness.db
      .execute<{ n: number }>(
        sql`SELECT COUNT(*)::int AS n FROM stage_transitions
            WHERE opportunity_id = ${O.undated}::uuid AND client_id = ${CLIENT_B}::uuid`,
      )
      .then((r) => (r as unknown as { rows: { n: number }[] }).rows ?? (r as unknown as { n: number }[]));
    expect(Number(row.n)).toBe(1); // the mis-attributed row really is there
  });

  it("carries a null canonical stage through for an unmapped GHL stage", async () => {
    const row = await find(O.unmapped);
    expect(row.stage).toBeNull();
    expect(row.ghlStageName).toBe("Long Term Nurture");
  });

  it("applies the paid-lead filter", async () => {
    expect((await load()).sitting.map((s) => s.opportunityId)).not.toContain(O.organic);
    const all = await q.getStageAging(CLIENT_A, { mode: "all", tag: "" });
    expect(all.sitting.map((s) => s.opportunityId)).toContain(O.organic);
  });

  it("does not leak another client's opportunities", async () => {
    const { sitting } = await load();
    expect(sitting.every((s) => !s.opportunityId.startsWith("bbbb"))).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Whether anyone ever called
 * ------------------------------------------------------------------ */

describe("call status", () => {
  it("says true when a call is on record", async () => {
    expect((await find(O.shuffled)).everCalled).toBe(true);
  });

  it("🔴 says false only for a lead we were watching", async () => {
    // This lead arrived after tracking went live and has no call. That is a
    // genuine miss, and the most actionable row on the panel.
    expect((await find(O.neverCalled)).everCalled).toBe(false);
  });

  it("🔴 says nothing for a lead that predates call tracking", async () => {
    /*
     * Unknowable, not a miss. Reported as `false` it would put every
     * historical lead at the top of the call list on a fact we do not have —
     * the same mislabelling the speed-to-lead widget exists to avoid.
     */
    expect((await find(O.preTrack)).everCalled).toBeNull();
  });

  it("says nothing at all for a client with no call events", async () => {
    const r = await q.getStageAging(CLIENT_B, { mode: "all", tag: "" });
    expect(r.sitting.every((s) => s.everCalled === null)).toBe(true);
  });
});
