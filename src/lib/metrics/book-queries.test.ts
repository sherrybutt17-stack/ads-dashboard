import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { sql } from "drizzle-orm";
import {
  createTestDb,
  CLIENT_A,
  CLIENT_B,
  CLIENT_C,
  CLIENT_D,
  type TestDb,
} from "./__testdb__/harness";
import { windowFromKeys } from "@/lib/dates";
import type { BookWindow } from "./queries";

/**
 * The book's SQL, against a real Postgres.
 *
 * `getBookAggregates` folds what were three queries per client into three
 * queries total, and the folding is where the risk is. Every assertion below
 * corresponds to a way a plausible-looking rewrite of it silently produces a
 * different number from the client's own dashboard — which is worse than being
 * wrong, because two screens then disagree and both look authoritative:
 *
 *   · one window for the book   → a client's month shifted by its timezone
 *   · two LEFT JOINs, one SELECT → Meta days × Google days, spend multiplied
 *   · forget `level`             → campaign and ad rows both counted
 *   · INNER JOIN contacts        → mode-`all` clients lose contactless rows
 *   · COUNT(*)                   → a bounced lead counted as two appointments
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

beforeAll(async () => {
  harness = await createTestDb();
  q = await import("./queries");
  await seed(harness.db);
});

afterAll(async () => {
  await harness?.close();
});

/* ------------------------------------------------------------------ *
 * Fixture
 * ------------------------------------------------------------------ *
 *
 * A — Meta + Google spend, `attributed` leads, one bounced opportunity, one won
 *     deal with a value and one without.
 * B — `all` leads, including a transition with no contact at all.
 * C — a Google-only client, whose leads carry a gclid rather than a campaign id.
 * D — a `tagged` client: one contact carries the tag, one carries a Meta
 *     campaign id and NOT the tag. The second is what separates `tagged` from
 *     `attributed`, and without it the two modes are indistinguishable.
 */
const CONTACT = {
  attributed: "aaaaaaa1-0000-0000-0000-000000000001",
  unattributed: "aaaaaaa1-0000-0000-0000-000000000002",
  bClient: "bbbbbbb1-0000-0000-0000-000000000001",
  google: "ccccccc1-0000-0000-0000-000000000001",
  dTagged: "ddddddd1-0000-0000-0000-000000000001",
  dCampaignOnly: "ddddddd1-0000-0000-0000-000000000002",
};

const OPP = {
  aBounced: "aaaaaaa2-0000-0000-0000-000000000001",
  aWonValued: "aaaaaaa2-0000-0000-0000-000000000002",
  aWonNoValue: "aaaaaaa2-0000-0000-0000-000000000003",
  aUnattributed: "aaaaaaa2-0000-0000-0000-000000000004",
  bOrphan: "bbbbbbb2-0000-0000-0000-000000000001",
  cGoogle: "ccccccc2-0000-0000-0000-000000000001",
  dTagged: "ddddddd2-0000-0000-0000-000000000001",
  dCampaignOnly: "ddddddd2-0000-0000-0000-000000000002",
  bBackfilled: "bbbbbbb2-0000-0000-0000-000000000002",
  bBack2: "bbbbbbb2-0000-0000-0000-000000000003",
  bBack3: "bbbbbbb2-0000-0000-0000-000000000004",
  bRealLead: "bbbbbbb2-0000-0000-0000-000000000005",
  bReal2: "bbbbbbb2-0000-0000-0000-000000000006",
  bReal3: "bbbbbbb2-0000-0000-0000-000000000007",
  bStalled: "bbbbbbb2-0000-0000-0000-000000000008",
  bOutOfOrder: "bbbbbbb2-0000-0000-0000-000000000009",
  bReEntered: "bbbbbbb2-0000-0000-0000-00000000000a",
};

async function seed(db: TestDb) {
  const run = (s: string) => db.execute(sql.raw(s));

  await run(`
    INSERT INTO contacts (id, client_id, ghl_contact_id, meta_campaign_id, google_campaign_id, gclid, tags) VALUES
      ('${CONTACT.attributed}',   '${CLIENT_A}', 'a1', 'camp_1', NULL, NULL, ARRAY['facebook-lead']),
      ('${CONTACT.unattributed}', '${CLIENT_A}', 'a2', NULL,     NULL, NULL, ARRAY[]::text[]),
      ('${CONTACT.bClient}',      '${CLIENT_B}', 'b1', NULL,     NULL, NULL, ARRAY[]::text[]),
      ('${CONTACT.google}',       '${CLIENT_C}', 'c1', NULL,     NULL, 'gcl_1', ARRAY[]::text[]),
      ('${CONTACT.dTagged}',      '${CLIENT_D}', 'd1', NULL,     NULL, NULL, ARRAY['facebook-lead']),
      ('${CONTACT.dCampaignOnly}','${CLIENT_D}', 'd2', 'camp_d', NULL, NULL, ARRAY[]::text[])
  `);

  await run(`
    INSERT INTO opportunities (id, client_id, ghl_opportunity_id, contact_id, monetary_value) VALUES
      ('${OPP.aBounced}',      '${CLIENT_A}', 'ao1', '${CONTACT.attributed}',   NULL),
      ('${OPP.aWonValued}',    '${CLIENT_A}', 'ao2', '${CONTACT.attributed}',   4000),
      ('${OPP.aWonNoValue}',   '${CLIENT_A}', 'ao3', '${CONTACT.attributed}',   NULL),
      ('${OPP.aUnattributed}', '${CLIENT_A}', 'ao4', '${CONTACT.unattributed}', 9999),
      ('${OPP.bOrphan}',       '${CLIENT_B}', 'bo1', NULL,                      NULL),
      ('${OPP.cGoogle}',       '${CLIENT_C}', 'co1', '${CONTACT.google}',       500),
      ('${OPP.dTagged}',       '${CLIENT_D}', 'do1', '${CONTACT.dTagged}',      NULL),
      ('${OPP.dCampaignOnly}', '${CLIENT_D}', 'do2', '${CONTACT.dCampaignOnly}', NULL),
      ('${OPP.bBackfilled}',   '${CLIENT_B}', 'bo2', NULL,                      NULL),
      ('${OPP.bBack2}',        '${CLIENT_B}', 'bo3', NULL,                      NULL),
      ('${OPP.bBack3}',        '${CLIENT_B}', 'bo4', NULL,                      NULL),
      ('${OPP.bRealLead}',     '${CLIENT_B}', 'bo5', NULL,                      NULL),
      ('${OPP.bReal2}',        '${CLIENT_B}', 'bo6', NULL,                      NULL),
      ('${OPP.bReal3}',        '${CLIENT_B}', 'bo7', NULL,                      NULL),
      ('${OPP.bStalled}',      '${CLIENT_B}', 'bo8', NULL,                      NULL),
      ('${OPP.bOutOfOrder}',   '${CLIENT_B}', 'bo9', NULL,                      NULL),
      ('${OPP.bReEntered}',    '${CLIENT_B}', 'bo10', NULL,                     NULL)
  `);

  const t = (
    client: string,
    opp: string,
    contact: string | null,
    stage: string,
    at: string,
    source = "webhook",
  ) =>
    `('${client}', '${opp}', ${contact ? `'${contact}'` : "NULL"}, '${stage}', '${at}', '${source}')`;

  await run(`
    INSERT INTO stage_transitions (client_id, opportunity_id, contact_id, to_canonical, changed_at, source) VALUES
      ${[
        // A, inside the current window (Aug 2026, LA time).
        t(CLIENT_A, OPP.aBounced, CONTACT.attributed, "new_lead", "2026-08-05T18:00:00Z"),
        // The SAME opportunity entering appointment_booked twice — bounced back
        // and re-booked. One appointment, not two.
        t(CLIENT_A, OPP.aBounced, CONTACT.attributed, "appointment_booked", "2026-08-06T18:00:00Z"),
        t(CLIENT_A, OPP.aBounced, CONTACT.attributed, "appointment_booked", "2026-08-09T18:00:00Z"),
        t(CLIENT_A, OPP.aWonValued, CONTACT.attributed, "new_lead", "2026-08-07T18:00:00Z"),
        t(CLIENT_A, OPP.aWonValued, CONTACT.attributed, "closed_won", "2026-08-10T18:00:00Z"),
        t(CLIENT_A, OPP.aWonNoValue, CONTACT.attributed, "closed_won", "2026-08-11T18:00:00Z"),
        // Re-won: this opportunity fell back and closed again inside the same
        // window. Its $4,000 must be counted once — see the DISTINCT test.
        t(CLIENT_A, OPP.aWonValued, CONTACT.attributed, "closed_won", "2026-08-13T18:00:00Z"),
        // Unattributed: must NOT count for A, whose mode is `attributed`.
        t(CLIENT_A, OPP.aUnattributed, CONTACT.unattributed, "new_lead", "2026-08-08T18:00:00Z"),
        t(CLIENT_A, OPP.aUnattributed, CONTACT.unattributed, "closed_won", "2026-08-12T18:00:00Z"),
        // A, in the PREVIOUS window (July).
        t(CLIENT_A, OPP.aWonValued, CONTACT.attributed, "new_lead", "2026-07-10T18:00:00Z"),

        // B counts every lead, and this transition has no contact at all —
        // a backfill snapshot. Mode `all` must still see it.
        t(CLIENT_B, OPP.bOrphan, null, "new_lead", "2026-08-05T18:00:00Z"),
        /*
         * A pre-existing opportunity whose only "lead" transition is the
         * backfill snapshot — its timestamp is `lastStageChangeAt`, not when
         * the lead actually arrived. Measuring a sales cycle from it is the
         * defect `getStageLag` exists to avoid.
         */
        t(CLIENT_B, OPP.bBackfilled, null, "new_lead", "2026-08-02T18:00:00Z", "backfill_snapshot"),
        t(CLIENT_B, OPP.bBackfilled, null, "appointment_booked", "2026-08-21T18:00:00Z"),
        // Two more of the same shape, so there are THREE backfill-dated gaps —
        // past the median's observation floor, which would otherwise mask
        // whether the exclusion is doing anything.
        t(CLIENT_B, OPP.bBack2, null, "new_lead", "2026-08-02T18:00:00Z", "backfill_snapshot"),
        t(CLIENT_B, OPP.bBack2, null, "appointment_booked", "2026-08-22T18:00:00Z"),
        t(CLIENT_B, OPP.bBack3, null, "new_lead", "2026-08-02T18:00:00Z", "backfill_snapshot"),
        t(CLIENT_B, OPP.bBack3, null, "appointment_booked", "2026-08-23T18:00:00Z"),
        /*
         * A genuine webhook lead whose BOOKING was backfilled. Its gap is real
         * — `lastStageChangeAt` is the true date the stage moved — so it must
         * be measured, not thrown away with the synthetic lead dates.
         */
        t(CLIENT_B, OPP.bRealLead, null, "new_lead", "2026-08-04T18:00:00Z"),
        t(CLIENT_B, OPP.bRealLead, null, "appointment_booked", "2026-08-14T18:00:00Z", "backfill_snapshot"),
        // Two more of the same shape, in September, so the wider window has
        // three real-lead observations and the median is computable.
        t(CLIENT_B, OPP.bReal2, null, "new_lead", "2026-09-01T18:00:00Z"),
        t(CLIENT_B, OPP.bReal2, null, "appointment_booked", "2026-09-06T18:00:00Z", "backfill_snapshot"),
        t(CLIENT_B, OPP.bReal3, null, "new_lead", "2026-09-02T18:00:00Z"),
        t(CLIENT_B, OPP.bReal3, null, "appointment_booked", "2026-09-09T18:00:00Z", "backfill_snapshot"),

        /*
         * One deal that sat for seven months before booking. Real, and exactly
         * why the lag is a MEDIAN: averaged in, this single opportunity would
         * quote the account a 55-day sales cycle when the typical one is ten.
         */
        t(CLIENT_B, OPP.bStalled, null, "new_lead", "2026-02-01T18:00:00Z"),
        t(CLIENT_B, OPP.bStalled, null, "appointment_booked", "2026-09-20T18:00:00Z"),

        /*
         * A booking recorded BEFORE the first lead transition. GHL's webhooks
         * are at-least-once and unordered, and the backfill can land a stage
         * the ledger has no lead for yet — so this is not hypothetical. Its gap
         * is negative and it must be dropped rather than pulling the median
         * down toward zero.
         */
        t(CLIENT_B, OPP.bOutOfOrder, null, "appointment_booked", "2026-09-05T18:00:00Z"),
        t(CLIENT_B, OPP.bOutOfOrder, null, "new_lead", "2026-09-12T18:00:00Z"),

        /*
         * A lead that went cold and re-entered the pipeline. The gap that
         * matters is from the FIRST arrival — that is when the spend that
         * bought this person happened — so `first_lead` takes MIN. Taking MAX
         * would report 5 days for someone acquired 24 days earlier.
         */
        t(CLIENT_B, OPP.bReEntered, null, "new_lead", "2026-09-01T18:00:00Z"),
        t(CLIENT_B, OPP.bReEntered, null, "new_lead", "2026-09-20T18:00:00Z"),
        t(CLIENT_B, OPP.bReEntered, null, "appointment_booked", "2026-09-25T18:00:00Z"),

        // C's lead is identified by a gclid, not a Meta campaign id.
        t(CLIENT_C, OPP.cGoogle, CONTACT.google, "new_lead", "2026-08-05T18:00:00Z"),
        t(CLIENT_C, OPP.cGoogle, CONTACT.google, "closed_won", "2026-08-06T18:00:00Z"),

        // D: one tagged lead, one carrying only a campaign id.
        t(CLIENT_D, OPP.dTagged, CONTACT.dTagged, "new_lead", "2026-08-05T18:00:00Z"),
        t(CLIENT_D, OPP.dCampaignOnly, CONTACT.dCampaignOnly, "new_lead", "2026-08-06T18:00:00Z"),
      ].join(",\n      ")}
  `);

  await run(`
    INSERT INTO pipeline_stages (client_id, ghl_pipeline_id, ghl_stage_id, ghl_stage_name, canonical_stage) VALUES
      ('${CLIENT_A}', 'p1', 's1', 'New Lead',    'new_lead'),
      ('${CLIENT_A}', 'p1', 's2', 'Booked',      'appointment_booked'),
      ('${CLIENT_A}', 'p1', 's3', 'Won',         'closed_won'),
      -- Present in GHL, bound to nothing. A zero against "showed" therefore
      -- describes the configuration rather than the clinic's attendance.
      ('${CLIENT_A}', 'p1', 's4', 'Walked In',    NULL)
  `);

  await run(`
    INSERT INTO fb_daily_metrics (client_id, date, level, meta_campaign_id, meta_ad_id, spend) VALUES
      ('${CLIENT_A}', '2026-08-05', 'campaign', 'camp_1', '',    '600.00'),
      ('${CLIENT_A}', '2026-08-06', 'campaign', 'camp_1', '',    '400.00'),
      -- The SAME money one level down. Counting both doubles the account.
      ('${CLIENT_A}', '2026-08-05', 'ad',       'camp_1', 'ad1', '600.00'),
      -- July, the previous window.
      ('${CLIENT_A}', '2026-07-15', 'campaign', 'camp_1', '',    '250.00'),
      ('${CLIENT_B}', '2026-08-05', 'campaign', 'camp_b', '',    '100.00')
  `);

  await run(`
    INSERT INTO google_daily_metrics (client_id, date, spend) VALUES
      ('${CLIENT_A}', '2026-08-05', '200.00'),
      ('${CLIENT_A}', '2026-08-06', '300.00'),
      ('${CLIENT_C}', '2026-08-05', '750.00')
  `);

  await run(`
    INSERT INTO google_ad_accounts (client_id, customer_id, currency, status) VALUES
      ('${CLIENT_A}', '1111111111', 'USD', 'active'),
      ('${CLIENT_C}', '3333333333', 'CAD', 'active'),
      ('${CLIENT_C}', '3333333334', 'EUR', 'removed')
  `);

  /*
   * TikTok spend for A, on the same days it already has Meta and Google spend.
   *
   * Deliberately stacked on the same dates rather than given its own client:
   * the bug this fixture guards against is a rewrite that joins the three
   * metric tables in one SELECT instead of UNION ALL, which multiplies days ×
   * days × days. Three platforms overlapping on two dates makes that explosion
   * unmissable, where a TikTok-only client would not exercise it at all.
   */
  await run(`
    INSERT INTO tiktok_daily_metrics (client_id, date, spend) VALUES
      ('${CLIENT_A}', '2026-08-05', '50.00'),
      ('${CLIENT_A}', '2026-08-06', '75.00'),
      ('${CLIENT_B}', '2026-08-05', '20.00')
  `);

  await run(`
    INSERT INTO tiktok_ad_accounts (client_id, advertiser_id, currency, status) VALUES
      ('${CLIENT_A}', '7000000000000000001', 'USD', 'active'),
      ('${CLIENT_C}', '7000000000000000002', 'GBP', 'active'),
      ('${CLIENT_C}', '7000000000000000003', 'JPY', 'removed')
  `);
}

/* ------------------------------------------------------------------ */

const win = (start: string, end: string, tz = TZ) => windowFromKeys(start, end, tz);

const AUGUST: BookWindow = {
  clientId: CLIENT_A,
  current: win("2026-08-01", "2026-08-31"),
  previous: win("2026-07-01", "2026-07-31"),
  filter: { mode: "attributed", tag: "facebook-lead" },
};
const B_AUGUST: BookWindow = {
  clientId: CLIENT_B,
  current: win("2026-08-01", "2026-08-31"),
  previous: win("2026-07-01", "2026-07-31"),
  filter: { mode: "all", tag: "" },
};
const D_TAGGED: BookWindow = {
  clientId: CLIENT_D,
  current: win("2026-08-01", "2026-08-31"),
  previous: win("2026-07-01", "2026-07-31"),
  filter: { mode: "tagged", tag: "facebook-lead" },
};
const C_AUGUST: BookWindow = {
  clientId: CLIENT_C,
  current: win("2026-08-01", "2026-08-31"),
  previous: win("2026-07-01", "2026-07-31"),
  filter: { mode: "attributed", tag: "" },
};

const pick = (
  rows: Awaited<ReturnType<typeof q.getBookAggregates>>,
  clientId: string,
  bucket: "current" | "previous",
) => rows.find((r) => r.clientId === clientId && r.bucket === bucket)!;

describe("getBookAggregates — spend", () => {
  it("adds Meta, Google and TikTok without multiplying them together", async () => {
    /*
     * THE assertion for the UNION ALL. LEFT JOINs in one SELECT would give
     * every Meta row a partner in every Google row and every TikTok row — 2 × 2
     * × 2 here, so $1,000 of Meta reads as $4,000. The ratio survives and every
     * absolute figure is multiplied, which is why it goes unnoticed.
     */
    const rows = await q.getBookAggregates([AUGUST]);
    const cur = pick(rows, CLIENT_A, "current");
    expect(cur.metaSpend).toBeCloseTo(1000, 6);
    expect(cur.googleSpend).toBeCloseTo(500, 6);
    expect(cur.tiktokSpend).toBeCloseTo(125, 6);
  });

  it("🔴 does not silently drop TikTok spend from the book", async () => {
    /*
     * This is a regression test for a bug that was live: the spend union had
     * only two branches, so TikTok spend never reached the roll-up.
     *
     * The shape of it is what makes it dangerous. Leads come from
     * `stage_transitions`, which is platform-agnostic, so a TikTok client
     * contributed its LEADS to the book while contributing none of its SPEND.
     * The portfolio cost per lead therefore came out **below** the truth — an
     * expensive client reading as the efficient one, on a number that looks
     * entirely plausible. Under-reported spend flatters, and flattering numbers
     * do not get questioned.
     */
    const rows = await q.getBookAggregates([AUGUST, B_AUGUST]);
    expect(
      pick(rows, CLIENT_A, "current").tiktokSpend,
      "TikTok spend is missing from the book — its leads still count, so the book's cost per lead reads low",
    ).toBeCloseTo(125, 6);
    expect(pick(rows, CLIENT_B, "current").tiktokSpend).toBeCloseTo(20, 6);
  });

  it("🔴 counts campaign-level rows only, never the same money at ad level", async () => {
    // The Aug 5 ad row reports the same $600 as its campaign row.
    const rows = await q.getBookAggregates([AUGUST]);
    expect(pick(rows, CLIENT_A, "current").metaSpend).toBeCloseTo(1000, 6);
  });

  it("separates the two buckets", async () => {
    const rows = await q.getBookAggregates([AUGUST]);
    expect(pick(rows, CLIENT_A, "previous").metaSpend).toBeCloseTo(250, 6);
    expect(pick(rows, CLIENT_A, "previous").googleSpend).toBeCloseTo(0, 6);
  });

  it("returns a zeroed row for a client with no spend rather than omitting it", async () => {
    // A client that spent nothing still belongs on the book screen.
    const rows = await q.getBookAggregates([C_AUGUST]);
    const prev = pick(rows, CLIENT_C, "previous");
    expect(prev.metaSpend).toBe(0);
    expect(prev.googleSpend).toBe(0);
    expect(prev.tiktokSpend).toBe(0);
  });
});

describe("getTiktokCurrencies", () => {
  /*
   * Meta, Google and TikTok spend are summed per client, which is only sound
   * when they are priced alike. A book adding £3,000 to $4,000 prints 7,000 of
   * nothing, and there is no exchange rate in this system — so the mismatch has
   * to be reported, which means it first has to be read.
   */
  it("returns active advertisers' currencies per client", async () => {
    const map = await q.getTiktokCurrencies([CLIENT_A, CLIENT_C]);
    expect(map.get(CLIENT_A)).toEqual(["USD"]);
  });

  it("🔴 ignores removed advertisers", async () => {
    // A detached advertiser's currency must not raise a mixed-currency warning
    // about money that is no longer being counted.
    const map = await q.getTiktokCurrencies([CLIENT_C]);
    expect(map.get(CLIENT_C)).toEqual(["GBP"]);
  });

  it("reads the TikTok table, not Google's", async () => {
    // The two share one implementation parameterised by table name. Passing the
    // wrong literal would return Google's currencies under a TikTok label and
    // the mismatch warning would name the wrong platform.
    const [tiktok, google] = await Promise.all([
      q.getTiktokCurrencies([CLIENT_C]),
      q.getGoogleCurrencies([CLIENT_C]),
    ]);
    expect(tiktok.get(CLIENT_C)).toEqual(["GBP"]);
    expect(google.get(CLIENT_C)).toEqual(["CAD"]);
  });
});

describe("getBookAggregates — the funnel", () => {
  it("🔴 counts distinct opportunities, not transitions", async () => {
    // `aBounced` entered appointment_booked twice. Counting rows would halve
    // the reported cost per appointment and make the account look twice as
    // efficient as it is.
    const rows = await q.getBookAggregates([AUGUST]);
    expect(pick(rows, CLIENT_A, "current").funnel.appointment_booked).toBe(1);
  });

  it("applies each client's own paid-lead definition", async () => {
    // A is `attributed`: the unattributed opportunity's lead and win are out.
    const rows = await q.getBookAggregates([AUGUST]);
    const cur = pick(rows, CLIENT_A, "current");
    expect(cur.funnel.new_lead).toBe(2);
    expect(cur.funnel.closed_won).toBe(2);
  });

  it("🔴 keeps contactless transitions for a client counting every lead", async () => {
    /*
     * B's mode is `all`, and `getFunnelCounts` does not join contacts at all in
     * that case — so it counts a transition whose contact link is null. An
     * INNER JOIN here would drop it, and this screen would report zero leads
     * where B's own dashboard reports one. Two numbers, both confident.
     */
    const rows = await q.getBookAggregates([B_AUGUST]);
    // Two: the orphan, and the backfilled opportunity. Both are real
    // opportunities and both count as leads — `getFunnelCounts` applies no
    // source filter, so neither may the book. What a backfill row cannot do is
    // date a sales cycle; that exclusion lives in `getStageLag` alone, and
    // conflating the two would either lose real leads here or invent a
    // same-day cycle there.
    expect(pick(rows, CLIENT_B, "current").funnel.new_lead).toBe(5);
  });

  it("🔴 keeps 'tagged' and 'attributed' apart", async () => {
    /*
     * D has two leads: one carrying the tag, one carrying only a Meta campaign
     * id. Under `tagged` exactly one counts. Widen the attribution branch to
     * also fire for `tagged` clients — the natural-looking simplification, since
     * both are "paid" — and this client's lead count silently doubles while
     * every other mode keeps working.
     */
    const tagged = await q.getBookAggregates([D_TAGGED]);
    expect(pick(tagged, CLIENT_D, "current").funnel.new_lead).toBe(1);

    // The same client read under `attributed` picks the OTHER lead.
    const attributed = await q.getBookAggregates([
      { ...D_TAGGED, filter: { mode: "attributed", tag: "facebook-lead" } },
    ]);
    expect(pick(attributed, CLIENT_D, "current").funnel.new_lead).toBe(1);

    // And `either` takes both, which is what makes them genuinely different
    // populations rather than two names for one.
    const both = await q.getBookAggregates([
      { ...D_TAGGED, filter: { mode: "either", tag: "facebook-lead" } },
    ]);
    expect(pick(both, CLIENT_D, "current").funnel.new_lead).toBe(2);
  });

  it("matches the tag case-insensitively, as the per-client filter does", async () => {
    // `paidLeadPredicate` lowercases and trims before comparing; a book that
    // did not would report zero leads for any client whose tag was typed with a
    // capital letter.
    const rows = await q.getBookAggregates([
      { ...D_TAGGED, filter: { mode: "tagged", tag: "  Facebook-Lead " } },
    ]);
    expect(pick(rows, CLIENT_D, "current").funnel.new_lead).toBe(1);
  });

  it("counts a Google-attributed lead in the blended figure", async () => {
    // C's Meta mode is `attributed` and this contact has no Meta campaign id —
    // it is a Google lead, and the book is blended across platforms.
    const rows = await q.getBookAggregates([C_AUGUST]);
    const cur = pick(rows, CLIENT_C, "current");
    expect(cur.funnel.new_lead).toBe(1);
    expect(cur.funnel.closed_won).toBe(1);
  });

  it("puts a July transition in the previous bucket, not the current one", async () => {
    const rows = await q.getBookAggregates([AUGUST]);
    expect(pick(rows, CLIENT_A, "previous").funnel.new_lead).toBe(1);
  });
});

describe("getBookAggregates — revenue", () => {
  it("separates deals with a value from deals without one", async () => {
    // Two wins for A: one at $4,000, one with no value recorded. Reporting
    // "$4,000 from 2 deals" as a 2-deal average would understate by half; the
    // point of the split is that the UI can refuse to imply a rate at all.
    const rows = await q.getBookAggregates([AUGUST]);
    const rev = pick(rows, CLIENT_A, "current").revenue;
    expect(rev.wonOpps).toBe(2);
    expect(rev.wonWithValue).toBe(1);
    expect(rev.revenue).toBeCloseTo(4000, 6);
  });

  it("🔴 counts a deal once when it closed twice in the window", async () => {
    /*
     * `aWonValued` fell back and closed again on Aug 13. Its $4,000 is one
     * deal. Without the DISTINCT in the `won` CTE the same opportunity's value
     * enters the sum once per transition, and revenue — the number a retainer
     * is argued over — reads $8,000 for $4,000 of business.
     */
    const rows = await q.getBookAggregates([AUGUST]);
    const rev = pick(rows, CLIENT_A, "current").revenue;
    expect(rev.wonOpps).toBe(2);
    expect(rev.revenue).toBeCloseTo(4000, 6);
  });

  it("🔴 excludes an unattributed win for a client filtering on attribution", async () => {
    // `aUnattributed` carries $9,999. Leaking it would put revenue against
    // spend that did not produce it.
    const rows = await q.getBookAggregates([AUGUST]);
    expect(pick(rows, CLIENT_A, "current").revenue.revenue).toBeCloseTo(4000, 6);
  });
});

describe("getBookAggregates — isolation", () => {
  it("🔴 gives every client its own window", async () => {
    /*
     * A is asked for August, B for July. One shared window — the obvious
     * simplification — would report B's August leads under a July heading, and
     * B's own dashboard would disagree with this screen for reasons nobody
     * could trace.
     */
    const rows = await q.getBookAggregates([
      AUGUST,
      { ...B_AUGUST, current: win("2026-07-01", "2026-07-31"), previous: win("2026-06-01", "2026-06-30") },
    ]);
    expect(pick(rows, CLIENT_A, "current").funnel.new_lead).toBe(2);
    expect(pick(rows, CLIENT_B, "current").funnel.new_lead).toBe(0);
  });

  it("respects a client's timezone at the day boundary", async () => {
    /*
     * A transition at 18:00 UTC on Aug 5 is Aug 5 in Los Angeles (11:00) and
     * Aug 5 in London too — so the discriminating case is the window EDGE. A
     * window ending Aug 4 in LA closes at 07:00 UTC on Aug 5, before this
     * transition; the same window in UTC would close at midnight and also
     * exclude it. Use the START edge instead: a window opening Aug 6 in LA
     * opens at 07:00 UTC on Aug 6, so the Aug 5 18:00 transition is out either
     * way. What DOES discriminate is Tokyo, where 18:00 UTC Aug 5 is already
     * Aug 6 — so a window covering only Aug 6 catches it there and not in LA.
     */
    const inLA = await q.getBookAggregates([
      { ...AUGUST, current: win("2026-08-06", "2026-08-06") },
    ]);
    const inTokyo = await q.getBookAggregates([
      { ...AUGUST, current: win("2026-08-06", "2026-08-06", "Asia/Tokyo") },
    ]);
    // 2026-08-05 18:00Z: the `new_lead` for `aBounced`.
    expect(pick(inLA, CLIENT_A, "current").funnel.new_lead).toBe(0);
    expect(pick(inTokyo, CLIENT_A, "current").funnel.new_lead).toBe(1);
  });

  it("never mixes one tenant's rows into another's", async () => {
    const rows = await q.getBookAggregates([AUGUST, B_AUGUST, C_AUGUST]);
    expect(pick(rows, CLIENT_B, "current").metaSpend).toBeCloseTo(100, 6);
    expect(pick(rows, CLIENT_C, "current").googleSpend).toBeCloseTo(750, 6);
    expect(pick(rows, CLIENT_C, "current").metaSpend).toBe(0);
  });

  it("returns nothing for an empty book without touching the database", async () => {
    expect(await q.getBookAggregates([])).toEqual([]);
  });
});

describe("getGoogleCurrencies", () => {
  it("reports the currencies a client's live Google accounts are priced in", async () => {
    const m = await q.getGoogleCurrencies([CLIENT_A, CLIENT_C]);
    expect(m.get(CLIENT_A)).toEqual(["USD"]);
    // The EUR account is removed — a currency nobody is spending in should not
    // raise a mismatch warning forever.
    expect(m.get(CLIENT_C)).toEqual(["CAD"]);
  });

  it("omits a client with no Google account at all", async () => {
    const m = await q.getGoogleCurrencies([CLIENT_B]);
    expect(m.has(CLIENT_B)).toBe(false);
  });

  it("returns an empty map for no clients", async () => {
    expect((await q.getGoogleCurrencies([])).size).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Stage lag and stage mapping — §6.6's two supporting queries
 * ------------------------------------------------------------------ */

describe("getStageLag", () => {
  it("measures days from a lead arriving to reaching a stage", async () => {
    /*
     * A's three attributed appointments: aBounced booked 1 day after its lead
     * (Aug 5 → Aug 6) and again 4 days after (Aug 9). aWonValued closed 3 days
     * after its Aug 7 lead, and again on Aug 13 — 6 days. The median of the
     * closed_won gaps is what the caveat quotes.
     */
    const r = await q.getStageLag(
      CLIENT_A,
      win("2026-08-01", "2026-08-31"),
      { mode: "attributed", tag: "" },
    );
    // Two appointment rows (1d, 4d) — under the three-observation floor.
    expect(r.lag.appointment_booked ?? null).toBeNull();
  });

  it("🔴 refuses a median below three observations", async () => {
    // One opportunity's sales cycle wearing a statistic's clothes is worse than
    // no number: it is quoted in a caveat that is supposed to add confidence.
    const r = await q.getStageLag(
      CLIENT_C,
      win("2026-08-01", "2026-08-31"),
      { mode: "attributed", tag: "" },
    );
    expect(r.lag.closed_won ?? null).toBeNull();
  });

  it("respects the window", async () => {
    const r = await q.getStageLag(
      CLIENT_A,
      win("2026-07-01", "2026-07-31"),
      { mode: "attributed", tag: "" },
    );
    expect(Object.keys(r.lag)).toEqual([]);
  });

  it("counts opportunities whose lead date is only a backfill", async () => {
    // Reported rather than silently producing a confident zero-day sales cycle.
    const r = await q.getStageLag(
      CLIENT_B,
      win("2026-08-01", "2026-08-31"),
      { mode: "all", tag: "" },
    );
    expect(r.excludedBackfill).toBe(3);
  });

  it("🔴 never measures from a backfilled LEAD date", async () => {
    /*
     * Three opportunities book appointments 19–21 days after a backfilled
     * "lead" whose timestamp is really their last stage change. Counting those
     * would clear the three-observation floor and publish a confident ~20-day
     * median that measures nothing.
     *
     * What survives is the fourth: a real webhook lead on Aug 4 whose BOOKING
     * was backfilled on Aug 14. That gap is genuine — `lastStageChangeAt` is
     * the one true timestamp GHL gives us — so it is measured, and being a
     * single observation it correctly falls under the floor.
     */
    const r = await q.getStageLag(
      CLIENT_B,
      win("2026-08-01", "2026-08-31"),
      { mode: "all", tag: "" },
    );
    expect(r.lag.appointment_booked ?? null).toBeNull();
  });

  it("🔴 DOES measure a real lead whose destination was backfilled", async () => {
    /*
     * The other half of the asymmetry, and the one a blanket
     * `source <> 'backfill_snapshot'` would get wrong: it would drop this
     * observation and every one like it, which on an account onboarded mid-life
     * is most of them. Widening the window brings two more real-lead gaps into
     * range so the median is computable and non-zero — proving the row is
     * counted rather than merely not crashing.
     */
    const r = await q.getStageLag(
      CLIENT_B,
      win("2026-08-01", "2026-09-30"),
      { mode: "all", tag: "" },
    );
    expect(r.lag.appointment_booked).not.toBeNull();
    // The three synthetic ~20-day gaps are gone; what is left are real ones.
    expect(r.lag.appointment_booked!).toBeLessThan(15);
  });

  it("🔴 is a median over first-arrival gaps, and drops the impossible ones", async () => {
    /*
     * The exact figure, because three separate rules each move it and an
     * inequality would let two of them pass:
     *
     *   bRealLead   Aug 4 → Aug 14    10 days
     *   bReal2      Sep 1 → Sep 6      5
     *   bReal3      Sep 2 → Sep 9      7
     *   bReEntered  Sep 1 → Sep 25    24   (from FIRST arrival, not the second)
     *   bStalled    Feb 1 → Sep 20   231
     *   bOutOfOrder booked before its lead — dropped, not counted as −7
     *   bBack*      backfilled lead dates — dropped
     *
     * Median of {5, 7, 10, 24, 231} = 10.
     *   · mean instead of median          → 55.4
     *   · negative gaps admitted          →  8.5
     *   · MAX instead of MIN in first_lead →  7
     */
    const r = await q.getStageLag(
      CLIENT_B,
      win("2026-08-01", "2026-09-30"),
      { mode: "all", tag: "" },
    );
    expect(r.lag.appointment_booked!).toBeCloseTo(10, 1);
  });
});

describe("getMappedStages", () => {
  it("reports which canonical stages a GHL stage is bound to", async () => {
    const mapped = await q.getMappedStages(CLIENT_A);
    expect([...mapped].sort()).toEqual(["appointment_booked", "closed_won", "new_lead"]);
  });

  it("🔴 omits a stage that exists in GHL but is mapped to nothing", async () => {
    // An unmapped stage cannot record anything, so a zero against it describes
    // the configuration and not the business.
    const mapped = await q.getMappedStages(CLIENT_A);
    expect(mapped.has("showed")).toBe(false);
  });

  it("returns an empty set for a client with no mapping at all", async () => {
    expect((await q.getMappedStages(CLIENT_C)).size).toBe(0);
  });
});
