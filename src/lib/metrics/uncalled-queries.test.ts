import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, CLIENT_A, CLIENT_B, CLIENT_C, type TestDb } from "./__testdb__/harness";

/**
 * The call-list query, against a real Postgres.
 *
 * Everything here is about not putting the wrong person on the list, and the
 * ways SQL can do that are specific:
 *
 *   · `first_call_at IS NULL` taken as "never called" → a lead whose call
 *     webhook arrived before the contact existed sits on the list forever
 *   · `first_touch_at` used for direction   → someone who messaged in and was
 *     ignored is filed as "already being worked by text"
 *   · the most recent opportunity picked    → a contact whose second, stale
 *     opportunity was touched last is listed despite having booked
 *   · UTC day arithmetic                    → an evening lead is a day younger
 *     than it is, and drops off the list until tomorrow
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

const C = {
  plain: "aaaa9000-0000-0000-0000-000000000001",
  called: "aaaa9000-0000-0000-0000-000000000002",
  callViaLog: "aaaa9000-0000-0000-0000-000000000003",
  smsOnly: "aaaa9000-0000-0000-0000-000000000004",
  inbound: "aaaa9000-0000-0000-0000-000000000005",
  booked: "aaaa9000-0000-0000-0000-000000000006",
  preTracking: "aaaa9000-0000-0000-0000-000000000007",
  undated: "aaaa9000-0000-0000-0000-000000000008",
  evening: "aaaa9000-0000-0000-0000-000000000009",
  unpaid: "aaaa9000-0000-0000-0000-00000000000a",
  tagged: "aaaa9000-0000-0000-0000-00000000000b",
  unmapped: "aaaa9000-0000-0000-0000-00000000000c",
  preUnpaid: "aaaa9000-0000-0000-0000-00000000000e",
  betweenEvents: "aaaa9000-0000-0000-0000-000000000011",
  inboundCall: "aaaa9000-0000-0000-0000-00000000000d",
  wrongDirection: "aaaa9000-0000-0000-0000-000000000010",
  bClient: "bbbb9000-0000-0000-0000-000000000001",
};

const S = {
  newLead: "aaaa9100-0000-0000-0000-000000000001",
  booked: "aaaa9100-0000-0000-0000-000000000002",
  bBooked: "bbbb9100-0000-0000-0000-000000000001",
};

/** N days ago, at noon in the client's timezone, as a timestamptz literal. */
const daysAgo = (n: number) =>
  `(((now() AT TIME ZONE '${TZ}')::date - ${n} + interval '12 hours') AT TIME ZONE '${TZ}')`;

/**
 * N days ago at 5:30pm local — which is the NEXT day in UTC, so anything read
 * without `AT TIME ZONE` lands on the wrong weekday and the wrong date.
 */
const eveningDaysAgo = (n: number) =>
  `(((now() AT TIME ZONE '${TZ}')::date - ${n} + interval '17 hours 30 minutes') AT TIME ZONE '${TZ}')`;

async function seed(db: TestDb) {
  const run = (s: string) => db.execute(sql.raw(s));

  await run(`
    INSERT INTO pipeline_stages (id, client_id, ghl_pipeline_id, ghl_stage_id, ghl_stage_name, canonical_stage) VALUES
      ('${S.newLead}',  '${CLIENT_A}', 'p1', 's1', 'New Lead',      'new_lead'),
      ('${S.booked}',   '${CLIENT_A}', 'p1', 's2', 'Consult Booked','appointment_booked'),
      /*
       * 🔴 Deliberately a DIFFERENT canonical stage from CLIENT_A's. With both
       * mapped to new_lead a cross-tenant opportunity leak produces the same
       * answer as no leak at all, and the test proves nothing.
       */
      ('${S.bBooked}',  '${CLIENT_B}', 'p1', 's1', 'Booked',        'appointment_booked')
  `);

  /*
   * Call tracking began 60 days ago. Everything before it is unknowable, which
   * is the distinction the whole panel rests on.
   */
  await run(`
    INSERT INTO webhook_events (client_id, event_type, received_at, payload) VALUES
      /*
       * 🔴 Webhooks started arriving 100 days ago; the first one that proves we
       * can SEE calls is 60 days old. Live, those two are seven minutes apart —
       * opportunity events land the moment the app is installed, and the first
       * OutboundMessage waits for somebody to pick up a phone. Taking the
       * earliest event of any kind as the cutover would claim call visibility
       * for forty days we did not have it.
       */
      ('${CLIENT_A}', 'OpportunityStageUpdate', ${daysAgo(100)}, '{"id":"o1"}'),
      ('${CLIENT_A}', 'OutboundMessage', ${daysAgo(60)}, '{"contactId":"seed","messageType":"SMS","direction":"outbound"}'),
      /* CLIENT_C receives webhooks, but never a message. No call visibility. */
      ('${CLIENT_C}', 'OpportunityCreate', ${daysAgo(30)}, '{"id":"o2"}')
  `);

  await run(`
    INSERT INTO contacts (id, client_id, ghl_contact_id, first_name, last_name, phone, email,
                          meta_campaign_id, tags, ghl_created_at, first_call_at, first_touch_at) VALUES
      ('${C.plain}',       '${CLIENT_A}', 'g-plain',    'Plain','Lead','+15550001','a@x.com','camp_1', ARRAY[]::text[], ${daysAgo(5)}, NULL, NULL),
      /* Called: the column is set, so never a task. */
      ('${C.called}',      '${CLIENT_A}', 'g-called',   'Called','Lead','+15550002',NULL,'camp_1', ARRAY[]::text[], ${daysAgo(5)}, ${daysAgo(4)}, ${daysAgo(4)}),
      /* 🔴 Called, but the webhook landed before we knew the contact. */
      ('${C.callViaLog}',  '${CLIENT_A}', 'g-viacall',  'Log','Lead','+15550003',NULL,'camp_1', ARRAY[]::text[], ${daysAgo(5)}, NULL, NULL),
      ('${C.smsOnly}',     '${CLIENT_A}', 'g-sms',      'Sms','Lead','+15550004',NULL,'camp_1', ARRAY[]::text[], ${daysAgo(5)}, NULL, ${daysAgo(4)}),
      ('${C.inbound}',     '${CLIENT_A}', 'g-inbound',  'In','Lead','+15550005',NULL,'camp_1', ARRAY[]::text[], ${daysAgo(5)}, NULL, ${daysAgo(4)}),
      ('${C.inboundCall}', '${CLIENT_A}', 'g-incall',   'InCall','Lead','+15550013',NULL,'camp_1', ARRAY[]::text[], ${daysAgo(5)}, NULL, ${daysAgo(4)}),
      ('${C.wrongDirection}', '${CLIENT_A}', 'g-wrongdir', 'Wrong','Dir','+15550017',NULL,'camp_1', ARRAY[]::text[], ${daysAgo(5)}, NULL, NULL),
      ('${C.booked}',      '${CLIENT_A}', 'g-booked',   'Booked','Lead','+15550006',NULL,'camp_1', ARRAY[]::text[], ${daysAgo(5)}, NULL, NULL),
      /* Before the cutover: unknowable, never "never called". */
      ('${C.preTracking}', '${CLIENT_A}', 'g-pre',      'Old','Lead','+15550007',NULL,'camp_1', ARRAY[]::text[], ${daysAgo(90)}, NULL, NULL),
      /* Arrived after the first webhook but before the first message event. */
      ('${C.betweenEvents}','${CLIENT_A}', 'g-between',  'Between','Events','+15550018',NULL,'camp_1', ARRAY[]::text[], ${daysAgo(80)}, NULL, NULL),
      /* Imported with no creation date at all — undatable, so unjudgeable. */
      ('${C.undated}',     '${CLIENT_A}', 'g-undated',  'No','Date','+15550008',NULL,'camp_1', ARRAY[]::text[], NULL, NULL, NULL),
      ('${C.unpaid}',      '${CLIENT_A}', 'g-unpaid',   'Un','Paid','+15550009',NULL,NULL,     ARRAY[]::text[], ${daysAgo(5)}, NULL, NULL),
      /* No campaign id, but tagged — an Instant Form lead. Paid under 'either'. */
      ('${C.tagged}',      '${CLIENT_A}', 'g-tagged',   'Tag','Lead','+15550010',NULL,NULL,    ARRAY['facebook-lead'], ${daysAgo(5)}, NULL, NULL),
      ('${C.unmapped}',    '${CLIENT_A}', 'g-unmapped', 'Un','Mapped','+15550011',NULL,'camp_1', ARRAY[]::text[], ${daysAgo(5)}, NULL, NULL),
      /* Pre-cutover AND unfiltered: must not pad the paid pre-tracking count. */
      ('${C.preUnpaid}',   '${CLIENT_A}', 'g-pre-un',   'Old','Organic','+15550014',NULL,NULL,     ARRAY[]::text[], ${daysAgo(90)}, NULL, NULL),
      /*
       * Unfiltered, and phoned. The working-week profile is measured over every
       * call this team makes, not the advertised share — filtering would halve
       * an already small sample for no gain in truth.
       */
      ('aaaa9000-0000-0000-0000-00000000000f', '${CLIENT_A}', 'g-organic-called', 'Organic','Called','+15550016',NULL,NULL, ARRAY[]::text[], ${daysAgo(5)}, ${eveningDaysAgo(4)}, NULL),
      ('${C.bClient}',     '${CLIENT_B}', 'g-b',        'Other','Tenant','+15550012',NULL,'camp_1', ARRAY[]::text[], ${daysAgo(5)}, NULL, NULL),
      /* CLIENT_C exists only to be a client no call has ever been seen for. */
      ('cccc9000-0000-0000-0000-000000000001', '${CLIENT_C}', 'g-c', 'Never','Tracked','+15550015',NULL,'camp_1', ARRAY[]::text[], ${daysAgo(5)}, NULL, NULL)
  `);

  /*
   * 🔴 5:30pm yesterday in Los Angeles is 00:30 TODAY in UTC. Read in UTC this
   * lead is zero days old and drops off the list until tomorrow morning — the
   * single most common timezone bug in a daily ops panel.
   */
  await run(`
    INSERT INTO contacts (id, client_id, ghl_contact_id, first_name, phone, meta_campaign_id, tags, ghl_created_at)
    VALUES ('${C.evening}', '${CLIENT_A}', 'g-evening', 'Evening', '+15550020', 'camp_1', ARRAY[]::text[],
            (((now() AT TIME ZONE '${TZ}')::date - 1 + interval '17 hours 30 minutes') AT TIME ZONE '${TZ}'))
  `);

  await run(`
    INSERT INTO webhook_events (client_id, event_type, received_at, payload) VALUES
      /* An outbound CALL with no first_call_at written — the recovery path. */
      ('${CLIENT_A}', 'OutboundMessage', ${daysAgo(4)}, '{"contactId":"g-viacall","messageType":"CALL","direction":"outbound"}'),
      /* An SMS is not a call, however outbound it is. */
      ('${CLIENT_A}', 'OutboundMessage', ${daysAgo(4)}, '{"contactId":"g-sms","messageType":"SMS","direction":"outbound"}'),
      /* They wrote to us. Nobody has phoned back. */
      ('${CLIENT_A}', 'InboundMessage',  ${daysAgo(4)}, '{"contactId":"g-inbound","messageType":"SMS","direction":"inbound"}'),
      ('${CLIENT_A}', 'OutboundMessage', ${daysAgo(3)}, '{"contactId":"g-inbound","messageType":"Email","direction":"outbound"}'),
      /* An INBOUND call is them ringing us — not us reaching them. */
      ('${CLIENT_A}', 'InboundMessage',  ${daysAgo(4)}, '{"contactId":"g-incall","messageType":"CALL","direction":"inbound"}'),
      /*
       * 🔴 An OutboundMessage event whose payload says the direction is inbound.
       * recordMessageTouch requires BOTH messageType = CALL and direction =
       * outbound before it writes first_call_at, so this one never set the
       * column — and the recovery path must agree with it, or the two disagree
       * about who has been phoned.
       */
      ('${CLIENT_A}', 'OutboundMessage', ${daysAgo(4)}, '{"contactId":"g-wrongdir","messageType":"CALL","direction":"inbound"}'),
      /* 🔴 Another tenant messaged a contact that shares this GHL id. */
      ('${CLIENT_B}', 'OutboundMessage', ${daysAgo(4)}, '{"contactId":"g-plain","messageType":"SMS","direction":"outbound"}')
  `);

  await run(`
    INSERT INTO opportunities (id, client_id, ghl_opportunity_id, contact_id, name, current_stage_id, updated_at) VALUES
      ('aaaaa000-0000-0000-0000-000000000001', '${CLIENT_A}', 'o-plain',  '${C.plain}',    'Plain',  '${S.newLead}', ${daysAgo(5)}),
      /*
       * 🔴 Two opportunities for one contact. The stale New Lead one was touched
       * most recently; the booked one is what matters. Ordering by recency puts
       * a person who already has an appointment on the call list.
       */
      ('aaaaa000-0000-0000-0000-000000000002', '${CLIENT_A}', 'o-bk-old', '${C.booked}',   'Old',    '${S.booked}',  ${daysAgo(9)}),
      ('aaaaa000-0000-0000-0000-000000000003', '${CLIENT_A}', 'o-bk-new', '${C.booked}',   'New',    '${S.newLead}', ${daysAgo(1)}),
      /* current_stage_id null: the GHL stage is not mapped to anything. */
      ('aaaaa000-0000-0000-0000-000000000004', '${CLIENT_A}', 'o-unmap',  '${C.unmapped}', 'Unmap',  NULL,           ${daysAgo(5)}),
      /* 🔴 Belongs to CLIENT_B but points at CLIENT_A's contact. */
      ('bbbbb000-0000-0000-0000-000000000001', '${CLIENT_B}', 'o-cross',  '${C.plain}',    'Cross',  '${S.bBooked}', ${daysAgo(1)})
  `);

  await run(`
    INSERT INTO fb_daily_metrics (client_id, date, level, meta_campaign_id, spend, leads_total) VALUES
      ('${CLIENT_A}', (now() AT TIME ZONE '${TZ}')::date - 10, 'campaign', 'camp_1', 600, 5),
      /* Same day at ad level: duplicates the campaign's spend if summed. */
      ('${CLIENT_A}', (now() AT TIME ZONE '${TZ}')::date - 10, 'ad',       'camp_1', 600, 5),
      /* Before the cutover: not part of the cost of these leads. */
      ('${CLIENT_A}', (now() AT TIME ZONE '${TZ}')::date - 80, 'campaign', 'camp_1', 5000, 40)
  `);
}

const load = () => q.getUncalledLeads(CLIENT_A, TZ);
const byId = async (id: string) => (await load()).leads.find((l) => l.contactId === id);

/* ------------------------------------------------------------------ *
 * What counts as called
 * ------------------------------------------------------------------ */

describe("who is on the list at all", () => {
  it("excludes a lead with a recorded first call", async () => {
    expect(await byId(C.called)).toBeUndefined();
  });

  it("🔴 excludes a lead whose call only exists in the webhook log", async () => {
    /*
     * `recordMessageTouch` returns contactMatched:false when a call webhook
     * arrives for a contact this database has not seen yet, and the column is
     * never written. That lead looks unphoned forever. Ringing someone a
     * colleague called four days ago is how a call list loses its reader.
     */
    expect(await byId(C.callViaLog)).toBeUndefined();
  });

  it("does not treat an outbound SMS as a call", async () => {
    // The panel's whole premise is that a phone call is different from a text.
    const l = await byId(C.smsOnly);
    expect(l).toBeDefined();
    expect(l!.hasOutbound).toBe(true);
  });

  it("🔴 does not treat an inbound call as us reaching them", async () => {
    // They rang us and nobody rang back. Counting it as contact made would
    // remove the most obviously owed call on the list.
    const l = await byId(C.inboundCall);
    expect(l).toBeDefined();
    expect(l!.hasInbound).toBe(true);
  });

  it("excludes leads that arrived before call tracking existed", async () => {
    const r = await load();
    expect(r.leads.find((l) => l.contactId === C.preTracking)).toBeUndefined();
    expect(r.trackingStartedAt).not.toBeNull();
  });

  it("🔴 dates the cutover from the first MESSAGE event, not the first webhook", async () => {
    /*
     * Opportunity webhooks start the moment the app is installed; the first
     * OutboundMessage waits for somebody to pick up a phone. Live, those two
     * are seven minutes apart, but there is no reason they must be — and taking
     * the earliest event of any kind would claim call visibility for a period
     * with none, filling the list with leads that were very probably called.
     */
    expect(await byId(C.betweenEvents)).toBeUndefined();
  });

  it("🔴 keeps a call event on the list when its direction says inbound", async () => {
    /*
     * `recordMessageTouch` requires messageType = CALL AND direction =
     * outbound. The recovery path must apply the same two conditions or it
     * removes people the column would have kept — the two would disagree about
     * who has been phoned, and only one of them is on screen.
     */
    expect(await byId(C.wrongDirection)).toBeDefined();
  });

  it("counts pre-tracking and undatable leads together", async () => {
    // Neither can be judged: one predates visibility, the other has no arrival
    // date at all. Both are reported beside the list, never inside it.
    const r = await load();
    expect(r.preTracking).toBe(3);
    expect(r.leads.find((l) => l.contactId === C.undated)).toBeUndefined();
  });

  it("does not leak another tenant's leads", async () => {
    expect(await byId(C.bClient)).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * Message direction
 * ------------------------------------------------------------------ */

describe("who has been messaged, and which way", () => {
  it("🔴 separates a message in from a message out", async () => {
    /*
     * `first_touch_at` is written by both handlers and cannot tell these apart.
     * They rank at opposite ends of a call list, which is why the raw log is
     * read instead of the derived column.
     */
    const inbound = await byId(C.inbound);
    expect(inbound!.hasInbound).toBe(true);
    expect(inbound!.hasOutbound).toBe(true);

    const out = await byId(C.smsOnly);
    expect(out!.hasInbound).toBe(false);
    expect(out!.hasOutbound).toBe(true);
  });

  it("reports no messages at all as neither", async () => {
    const l = await byId(C.plain);
    expect(l!.hasInbound).toBe(false);
    expect(l!.hasOutbound).toBe(false);
  });

  it("🔴 does not read another tenant's messages", async () => {
    /*
     * CLIENT_B messaged a contact carrying the same GHL id. Without the client
     * filter on the log, this tenant's untouched lead reads as one somebody is
     * already working — and drops to the bottom of the list.
     */
    expect((await byId(C.plain))!.hasOutbound).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Which opportunity speaks for the lead
 * ------------------------------------------------------------------ */

describe("picking the opportunity", () => {
  it("🔴 takes the furthest-along one, not the most recent", async () => {
    // Both belong to this contact; the stale New Lead one was updated last.
    // Ordering by recency lists a person who already has an appointment.
    const l = await byId(C.booked);
    expect(l!.stage).toBe("appointment_booked");
  });

  it("reports a lead with no opportunity as such", async () => {
    const l = await byId(C.smsOnly);
    expect(l!.noOpportunity).toBe(true);
    expect(l!.opportunityId).toBeNull();
    expect(l!.stage).toBeNull();
  });

  it("keeps an unmapped stage as a lead with no canonical stage", async () => {
    // An unmapped GHL stage must not silently drop the lead: it is still a
    // person nobody has called, and the panel judges on the call, not the stage.
    const l = await byId(C.unmapped);
    expect(l!.noOpportunity).toBe(false);
    expect(l!.stage).toBeNull();
  });

  it("🔴 does not attach another tenant's opportunity", async () => {
    // CLIENT_B has an opportunity pointing at this contact, updated more
    // recently than the real one. Its stage must not reach this client.
    const l = await byId(C.plain);
    expect(l!.stage).toBe("new_lead");
  });
});

/* ------------------------------------------------------------------ *
 * The clock
 * ------------------------------------------------------------------ */

describe("dating the lead", () => {
  it("🔴 dates an evening lead by the client's calendar, not UTC", async () => {
    /*
     * 5:30pm yesterday in Los Angeles is 00:30 today in UTC. Read in UTC this
     * lead is zero days old, falls inside the grace period, and vanishes from
     * the list until tomorrow — every evening, for every client west of GMT.
     */
    const l = await byId(C.evening);
    expect(l!.daysSinceDate).toBe(1);
  });

  it("measures whole days, not elapsed hours", async () => {
    // A lead from noon five days ago is five days old, not 4.99.
    expect((await byId(C.plain))!.daysSinceDate).toBe(5);
  });

  it("takes the weekday from the client's calendar too", async () => {
    const [row] = (
      (await harness.db.execute(
        sql`SELECT EXTRACT(ISODOW FROM (now() AT TIME ZONE ${TZ})::date - 1)::int AS dow`,
      )) as unknown as { rows: { dow: number }[] }
    ).rows;
    expect((await byId(C.evening))!.leadDow).toBe(Number(row.dow));
  });

  it("🔴 counts every first call, not just the advertised ones", async () => {
    /*
     * Two calls exist here, one to an unfiltered lead. The working-week profile
     * is a fact about the team, and it already needs twenty calls before it
     * measures anything — filtering it to the paid share would push small
     * clients under the floor and quietly switch the clock to calendar days.
     */
    const r = await load();
    expect(r.callWeekdays.reduce((n, d) => n + d.calls, 0)).toBe(2);
    expect(r.callWeekdays[0].dow).toBeGreaterThanOrEqual(1);
    expect(r.callWeekdays[0].dow).toBeLessThanOrEqual(7);
  });

  it("🔴 puts an evening call on the local weekday, not the UTC one", async () => {
    /*
     * One of the two calls is at 5:30pm local, which is the following day in
     * UTC. Read without the timezone it lands on the wrong weekday — and this
     * profile is what decides whether the clock runs on a given day, so a
     * misplaced call can silently add or remove a working day for every lead.
     */
    const [row] = (
      (await harness.db.execute(
        sql`SELECT EXTRACT(ISODOW FROM (now() AT TIME ZONE ${TZ})::date - 4)::int AS dow`,
      )) as unknown as { rows: { dow: number }[] }
    ).rows;
    const r = await load();
    expect(r.callWeekdays.map((d) => d.dow)).toEqual([Number(row.dow)]);
  });
});

/* ------------------------------------------------------------------ *
 * Both sides of the lead filter
 * ------------------------------------------------------------------ */

describe("the paid-lead filter", () => {
  it("🔴 returns unfiltered leads too, flagged rather than dropped", async () => {
    // The engine partitions them, so "and N more outside the filter" is
    // measured to the same standard as the list rather than counted separately.
    const l = await byId(C.unpaid);
    expect(l).toBeDefined();
    expect(l!.isPaid).toBe(false);
    expect((await byId(C.plain))!.isPaid).toBe(true);
  });

  it("counts a tagged lead with no campaign id as paid", async () => {
    // Instant Form leads carry no UTMs at all; the tag is the only signal.
    expect((await byId(C.tagged))!.isPaid).toBe(true);
  });

  it("marks everything paid when the filter is 'all'", async () => {
    const r = await q.getUncalledLeads(CLIENT_A, TZ, { mode: "all", tag: "" });
    expect(r.leads.every((l) => l.isPaid)).toBe(true);
  });

  it("counts only paid leads as pre-tracking", async () => {
    // The number sits beside a paid-filtered list; padding it with unfiltered
    // history would overstate how much the panel cannot see.
    const all = await q.getUncalledLeads(CLIENT_A, TZ, { mode: "all", tag: "" });
    expect(all.preTracking).toBeGreaterThan((await load()).preTracking);
  });
});

/* ------------------------------------------------------------------ *
 * What the leads cost
 * ------------------------------------------------------------------ */

describe("cost per lead over the tracking period", () => {
  it("sums campaign-level rows only", async () => {
    // The ad-level row duplicates the same day's spend. Counted, every lead on
    // the list would be priced at double.
    const r = await load();
    // $600 since the cutover across 11 paid leads that arrived after it.
    expect(r.costPerLead).not.toBeNull();
    expect(r.costPerLead! * 11).toBeCloseTo(600, 4);
  });

  it("🔴 ignores spend from before call tracking began", async () => {
    /*
     * $5,000 sits 80 days back. Included, the list would be priced at nearly
     * ten times its real cost — and this panel's most quotable line is a dollar
     * figure, so an inflated one is the worst kind of wrong.
     */
    const r = await load();
    expect(r.costPerLead!).toBeLessThan(100);
  });

  it("reports nothing when the client has no ad data", async () => {
    const r = await q.getUncalledLeads(CLIENT_B, TZ);
    expect(r.costPerLead).toBeNull();
  });

  it("🔴 reports nothing rather than zero when spend is simply absent", async () => {
    // A null cost per lead makes the panel withhold its dollar line. A zero
    // would print "$0 of leads nobody called" over a real, unpriced failure.
    const r = await q.getUncalledLeads(CLIENT_C, TZ);
    expect(r.costPerLead).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * No tracking at all
 * ------------------------------------------------------------------ */

describe("a client with no call visibility", () => {
  it("🔴 returns nothing to call and says why", async () => {
    /*
     * CLIENT_C receives webhooks — just never a message one. Its leads all have
     * a null `first_call_at`, and reporting them as uncalled would be the source
     * spreadsheet's `SHOWN = 0 forever` rebuilt faithfully.
     */
    const r = await q.getUncalledLeads(CLIENT_C, TZ);
    expect(r.trackingStartedAt).toBeNull();
    expect(r.leads).toEqual([]);
    expect(r.preTracking).toBe(1);
    expect(r.callWeekdays).toEqual([]);
  });
});
