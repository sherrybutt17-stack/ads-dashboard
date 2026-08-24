import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, CLIENT_A, CLIENT_B, type TestDb } from "./__testdb__/harness";
import { windowFromKeys } from "@/lib/dates";

/**
 * The split query, against a real Postgres.
 *
 * It is the only query in the layer that returns BOTH sides of the paid filter
 * rather than filtering to one, so the failure modes are new:
 *
 *   · predicate used as a filter, not a split → the other side vanishes and the
 *     panel reports a pipeline made entirely of ads
 *   · COUNT(*) on transitions                 → a bounced lead books twice and
 *     this panel disagrees with the funnel about the same month
 *   · spend defaulted to zero                 → "no ad data for March" becomes
 *     "nothing was spent in March", which moves the pre-advertising baseline
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
  paidCampaign: "aaaa7000-0000-0000-0000-000000000001",
  paidTagged: "aaaa7000-0000-0000-0000-000000000002",
  other: "aaaa7000-0000-0000-0000-000000000003",
  bounced: "aaaa7000-0000-0000-0000-000000000004",
  boundary: "aaaa7000-0000-0000-0000-000000000005",
  bClient: "bbbb7000-0000-0000-0000-000000000001",
};
const O = {
  paidCampaign: "aaaa8000-0000-0000-0000-000000000001",
  other: "aaaa8000-0000-0000-0000-000000000003",
  bounced: "aaaa8000-0000-0000-0000-000000000004",
  /** Belongs to CLIENT_B but carries CLIENT_A's contact — see the tenancy test. */
  crossed: "bbbb8000-0000-0000-0000-000000000001",
};

async function seed(db: TestDb) {
  const run = (s: string) => db.execute(sql.raw(s));

  await run(`
    INSERT INTO contacts (id, client_id, ghl_contact_id, meta_campaign_id, tags, ghl_created_at) VALUES
      ('${C.paidCampaign}', '${CLIENT_A}', 'a1', 'camp_1', ARRAY[]::text[],        '2026-07-05T17:00:00Z'),
      /* Tagged but with no campaign id — an Instant Form lead. Still paid. */
      ('${C.paidTagged}',   '${CLIENT_A}', 'a2', NULL,     ARRAY['facebook-lead'], '2026-07-06T17:00:00Z'),
      ('${C.other}',        '${CLIENT_A}', 'a3', NULL,     ARRAY[]::text[],        '2026-07-07T17:00:00Z'),
      ('${C.bounced}',      '${CLIENT_A}', 'a4', 'camp_1', ARRAY[]::text[],        '2026-07-08T17:00:00Z'),
      /* 5:30pm on 31 July in Los Angeles — 1 August in UTC. A July lead. */
      ('${C.boundary}',     '${CLIENT_A}', 'a5', 'camp_1', ARRAY[]::text[],        '2026-08-01T00:30:00Z'),
      ('${C.bClient}',      '${CLIENT_B}', 'b1', 'camp_1', ARRAY[]::text[],        '2026-07-05T17:00:00Z')
  `);

  await run(`
    INSERT INTO opportunities (id, client_id, ghl_opportunity_id, contact_id) VALUES
      ('${O.paidCampaign}', '${CLIENT_A}', 'o1', '${C.paidCampaign}'),
      ('${O.other}',        '${CLIENT_A}', 'o3', '${C.other}'),
      ('${O.bounced}',      '${CLIENT_A}', 'o4', '${C.bounced}'),
      ('${O.crossed}',      '${CLIENT_B}', 'bo1', '${C.paidCampaign}')
  `);

  const t = (opp: string, contact: string, stage: string, at: string, client = CLIENT_A) =>
    `('${client}', '${opp}', '${contact}', '${stage}', '${at}')`;

  await run(`
    INSERT INTO stage_transitions (client_id, opportunity_id, contact_id, to_canonical, changed_at) VALUES
      ${[
        t(O.paidCampaign, C.paidCampaign, "appointment_booked", "2026-07-10T17:00:00Z"),
        t(O.paidCampaign, C.paidCampaign, "closed_won", "2026-07-20T17:00:00Z"),
        t(O.other, C.other, "appointment_booked", "2026-07-12T17:00:00Z"),
        // 🔴 Bounced out and re-booked in the same month. ONE appointment.
        t(O.bounced, C.bounced, "appointment_booked", "2026-07-11T17:00:00Z"),
        t(O.bounced, C.bounced, "appointment_booked", "2026-07-25T17:00:00Z"),
        // Not an outcome stage — must not be counted as either.
        t(O.other, C.other, "contacted", "2026-07-09T17:00:00Z"),
        /*
         * 🔴 Another tenant's ledger row, on its OWN opportunity, pointing at
         * this tenant's contact — the shape a mis-routed webhook token
         * produces. It must reference a different opportunity than anything of
         * CLIENT_A's, or COUNT(DISTINCT opportunity_id) collapses the leak and
         * hides it.
         */
        t(O.crossed, C.paidCampaign, "closed_won", "2026-07-22T17:00:00Z", CLIENT_B),
      ].join(",\n      ")}
  `);

  await run(`
    INSERT INTO fb_daily_metrics (client_id, date, level, meta_campaign_id, spend, leads_total) VALUES
      ('${CLIENT_A}', '2026-07-05', 'campaign', 'camp_1', 900,  10),
      ('${CLIENT_A}', '2026-07-20', 'campaign', 'camp_1', 1251, 6),
      /* An ad-level row for the same day: it must not double the month's spend. */
      ('${CLIENT_A}', '2026-07-05', 'ad',       'camp_1', 900,  10),
      /* August: the account is connected and reporting a real zero. */
      ('${CLIENT_A}', '2026-08-04', 'campaign', 'camp_1', 0,    0)
  `);
}

const load = () => q.getChannelMix(CLIENT_A, MONTHS, TZ);
const july = async () => (await load()).rows.find((r) => r.month === "2026-07")!;

describe("splitting the pipeline", () => {
  it("🔴 returns BOTH sides, not just the paid one", () => {
    // Every other query in the layer filters to paid leads. Reused as a filter
    // here, the other side would vanish and the panel would report a pipeline
    // made entirely of advertising.
    return july().then((r) => {
      // campaign id, tag, the bounced one, and the month-boundary one
      expect(r.paidLeads).toBe(4);
      expect(r.otherLeads).toBe(1);
    });
  });

  it("counts a tagged lead with no campaign id as paid", async () => {
    // Instant Form leads carry no UTMs at all, so the tag is the only signal —
    // and dropping them would inflate the "everything else" side by exactly the
    // leads the panel is warning about elsewhere.
    const r = await july();
    expect(r.paidLeads).toBe(4);
  });

  it("🔴 puts a lead that arrived at 5:30pm on the 31st in July", async () => {
    const rows = (await load()).rows;
    expect(rows.find((r) => r.month === "2026-08")?.paidLeads ?? 0).toBe(0);
    expect((await july()).paidLeads).toBe(4);
  });

  it("does not leak another client's leads", async () => {
    const r = await july();
    expect(r.paidLeads + r.otherLeads).toBe(5);
  });

  it("returns nothing when every lead counts as paid", async () => {
    /*
     * Mode `all` is a legitimate setting that makes this comparison meaningless
     * rather than lopsided. Rendering a 100/0 split would be a configuration
     * artefact presented as a result.
     */
    const r = await q.getChannelMix(CLIENT_A, MONTHS, TZ, { mode: "all", tag: "" });
    expect(r.splitDefinable).toBe(false);
    expect(r.rows).toEqual([]);
  });
});

describe("funnel counts per side", () => {
  it("🔴 counts a bounced lead's appointment once", async () => {
    // COUNT(*) here would halve the reported cost per appointment on one side
    // and put this panel at odds with the funnel about the same month.
    const r = await july();
    expect(r.paidAppointments).toBe(2); // one each from paidCampaign and bounced
    expect(r.otherAppointments).toBe(1);
  });

  it("keeps closes on the right side", async () => {
    const r = await july();
    expect(r.paidWon).toBe(1);
    expect(r.otherWon).toBe(0);
  });

  it("ignores stages that are not outcomes", async () => {
    const r = await july();
    expect(r.otherAppointments).toBe(1); // the `contacted` row is not counted
  });

  it("🔴 does not read another tenant's ledger", async () => {
    // CLIENT_B has its own opportunity carrying CLIENT_A's contact. Without the
    // client filter this client is handed a closed deal that is not theirs.
    const r = await july();
    expect(r.paidWon).toBe(1);
  });
});

describe("spend and the platform's own lead count", () => {
  it("sums campaign-level rows only", async () => {
    // The ad-level row duplicates the same day's spend. Counted, July would
    // read $3,051 against a real $2,151.
    const r = await july();
    expect(r.spend).toBeCloseTo(2151, 6);
    expect(r.platformLeads).toBe(16);
  });

  it("🔴 leaves a month with no ad data null, not zero", async () => {
    /*
     * "We have no data for June" is not "nothing was spent in June", and the
     * pre-advertising baseline downstream is computed entirely from that
     * distinction — defaulting to zero would silently move the boundary.
     */
    const june = (await load()).rows.find((r) => r.month === "2026-06")!;
    expect(june.spend).toBeNull();
    expect(june.platformLeads).toBeNull();
  });

  it("keeps a genuine zero as a zero", async () => {
    // The account is connected and reported no spend: a real, knowable zero.
    const aug = (await load()).rows.find((r) => r.month === "2026-08")!;
    expect(aug.spend).toBe(0);
    expect(aug.platformLeads).toBe(0);
  });

  it("returns a row for every requested month, even the silent ones", async () => {
    const rows = await load();
    expect(rows.rows.map((r) => r.month).sort()).toEqual(["2026-06", "2026-07", "2026-08"]);
  });
});
