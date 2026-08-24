import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, CLIENT_A, CLIENT_B, type TestDb } from "./__testdb__/harness";
import { windowFromKeys } from "@/lib/dates";

/**
 * The join itself, against a real Postgres.
 *
 * Everything the engine decides is unit-tested; this file tests the one thing
 * it cannot see — whether the rows handed to it are the right rows. Each
 * assertion corresponds to a way a reasonable-looking version of this query
 * quietly returns a different cohort:
 *
 *   · bound the outcome to the date range → every lead that converted after the
 *     range ends is scored a failure, and the newest leads suffer most
 *   · COUNT/MAX instead of MIN            → a re-entered lead's days-to-book is
 *     measured to the LAST time it got there
 *   · drop the clock-skew guards          → a call logged before its own lead
 *     becomes a negative response time, which buckets as "within 5 minutes"
 *   · read hours in UTC                   → the calling-window control is
 *     shifted by seven hours and controls for nothing
 *   · forget the tracking cutover         → every historical lead joins the
 *     "never called" row, inverting the panel's most actionable line
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
const RANGE = () => windowFromKeys("2026-08-01", "2026-08-14", TZ);

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
 * ------------------------------------------------------------------ */

const C = {
  preTrack: "aaaa0000-0000-0000-0000-000000000001",
  fast: "aaaa0000-0000-0000-0000-000000000002",
  slow: "aaaa0000-0000-0000-0000-000000000003",
  never: "aaaa0000-0000-0000-0000-000000000004",
  skew: "aaaa0000-0000-0000-0000-000000000005",
  lateBooker: "aaaa0000-0000-0000-0000-000000000006",
  rebooked: "aaaa0000-0000-0000-0000-000000000007",
  preLead: "aaaa0000-0000-0000-0000-000000000008",
  unattributed: "aaaa0000-0000-0000-0000-000000000009",
  deep: "aaaa0000-0000-0000-0000-00000000000a",
  night: "aaaa0000-0000-0000-0000-00000000000b",
  bClient: "bbbb0000-0000-0000-0000-000000000001",
};

const O = {
  fast: "aaaa1111-0000-0000-0000-000000000002",
  lateBooker: "aaaa1111-0000-0000-0000-000000000006",
  rebooked: "aaaa1111-0000-0000-0000-000000000007",
  preLead: "aaaa1111-0000-0000-0000-000000000008",
  unattributed: "aaaa1111-0000-0000-0000-000000000009",
  deep: "aaaa1111-0000-0000-0000-00000000000a",
};

/** Outbound-call tracking went live on 5 August. */
const TRACKING_START = "2026-08-05T00:00:00Z";

async function seed(db: TestDb) {
  const run = (s: string) => db.execute(sql.raw(s));

  await run(`
    INSERT INTO webhook_events (client_id, event_type, received_at) VALUES
      ('${CLIENT_A}', 'OutboundMessage', '${TRACKING_START}'),
      ('${CLIENT_A}', 'OutboundMessage', '2026-08-09T00:00:00Z'),
      -- Not a call event, and EARLIER. Taking MIN over every event type would
      -- move the cutover back and readmit leads we could not have measured.
      ('${CLIENT_A}', 'ContactCreate',   '2026-01-01T00:00:00Z'),
      ('${CLIENT_B}', 'ContactCreate',   '2026-01-01T00:00:00Z')
  `);

  const contact = (
    id: string,
    client: string,
    ghlId: string,
    createdAt: string | null,
    firstCallAt: string | null,
    campaign: string | null = "camp_1",
  ) =>
    `('${id}', '${client}', '${ghlId}', ${campaign ? `'${campaign}'` : "NULL"}, ` +
    `${createdAt ? `'${createdAt}'` : "NULL"}, ${firstCallAt ? `'${firstCallAt}'` : "NULL"})`;

  await run(`
    INSERT INTO contacts (id, client_id, ghl_contact_id, meta_campaign_id, ghl_created_at, first_call_at) VALUES
      ${[
        // In the window but BEFORE tracking — response time unknowable.
        contact(C.preTrack, CLIENT_A, "a1", "2026-08-02T18:00:00Z", null),
        // Thu 6 Aug, 10:00 LA. Called after 5 minutes. Booked two days later.
        contact(C.fast, CLIENT_A, "a2", "2026-08-06T17:00:00Z", "2026-08-06T17:05:00Z"),
        // Fri 7 Aug, 10:00 LA. Called two days later. Never booked.
        contact(C.slow, CLIENT_A, "a3", "2026-08-07T17:00:00Z", "2026-08-09T17:00:00Z"),
        contact(C.never, CLIENT_A, "a4", "2026-08-08T17:00:00Z", null),
        // 🔴 A call logged an hour BEFORE the lead arrived. GHL's webhooks are
        // unordered and its clocks are not ours.
        contact(C.skew, CLIENT_A, "a5", "2026-08-09T17:00:00Z", "2026-08-09T16:00:00Z"),
        contact(C.lateBooker, CLIENT_A, "a6", "2026-08-10T17:00:00Z", "2026-08-10T17:10:00Z"),
        contact(C.rebooked, CLIENT_A, "a7", "2026-08-11T17:00:00Z", "2026-08-11T17:01:00Z"),
        contact(C.preLead, CLIENT_A, "a8", "2026-08-12T17:00:00Z", "2026-08-12T17:02:00Z"),
        // No campaign id and no tag: not a paid lead under mode `either`.
        contact(C.unattributed, CLIENT_A, "a9", "2026-08-12T18:00:00Z", "2026-08-12T18:02:00Z", null),
        contact(C.deep, CLIENT_A, "a10", "2026-08-13T17:00:00Z", "2026-08-13T17:03:00Z"),
        /*
         * 🔴 Both timestamps land on a different DAY in UTC than in Los
         * Angeles. Arrived Saturday 10pm local (Sunday in UTC), answered
         * Sunday 9:30pm local (Monday in UTC) — so read in UTC this weekend
         * enquiry is filed as a Sunday lead answered on a Monday.
         */
        contact(C.night, CLIENT_A, "a11", "2026-08-09T05:00:00Z", "2026-08-10T04:30:00Z"),
        contact(C.bClient, CLIENT_B, "b1", "2026-08-06T17:00:00Z", "2026-08-06T17:04:00Z"),
      ].join(",\n      ")}
  `);

  await run(`
    INSERT INTO opportunities (id, client_id, ghl_opportunity_id, contact_id) VALUES
      ('${O.fast}',         '${CLIENT_A}', 'ao2',  '${C.fast}'),
      ('${O.lateBooker}',   '${CLIENT_A}', 'ao6',  '${C.lateBooker}'),
      ('${O.rebooked}',     '${CLIENT_A}', 'ao7',  '${C.rebooked}'),
      ('${O.preLead}',      '${CLIENT_A}', 'ao8',  '${C.preLead}'),
      ('${O.unattributed}', '${CLIENT_A}', 'ao9',  '${C.unattributed}'),
      ('${O.deep}',         '${CLIENT_A}', 'ao10', '${C.deep}')
  `);

  const t = (client: string, opp: string, contactId: string, stage: string, at: string) =>
    `('${client}', '${opp}', '${contactId}', '${stage}', '${at}')`;

  await run(`
    INSERT INTO stage_transitions (client_id, opportunity_id, contact_id, to_canonical, changed_at) VALUES
      ${[
        t(CLIENT_A, O.fast, C.fast, "new_lead", "2026-08-06T17:00:00Z"),
        t(CLIENT_A, O.fast, C.fast, "appointment_booked", "2026-08-08T17:00:00Z"),

        /*
         * 🔴 Booked on 20 SEPTEMBER — five weeks after the window closes. The
         * lead arrived inside the range, so it belongs to this cohort and its
         * booking counts. Bounding the outcome to the range would score it a
         * failure, and would do so most often for the newest leads, which are
         * the fast-answered ones.
         */
        t(CLIENT_A, O.lateBooker, C.lateBooker, "new_lead", "2026-08-10T17:00:00Z"),
        t(CLIENT_A, O.lateBooker, C.lateBooker, "appointment_booked", "2026-09-20T17:00:00Z"),

        // Booked, fell back, booked again. Days-to-book is measured to the
        // FIRST time — one day, not nine.
        t(CLIENT_A, O.rebooked, C.rebooked, "appointment_booked", "2026-08-12T17:00:00Z"),
        t(CLIENT_A, O.rebooked, C.rebooked, "appointment_booked", "2026-08-20T17:00:00Z"),

        // A booking stamped before its own contact existed. Not an outcome of
        // a lead that had not arrived.
        t(CLIENT_A, O.preLead, C.preLead, "appointment_booked", "2026-08-01T17:00:00Z"),

        // Paid filter: this lead is unattributed and must not appear at all.
        t(CLIENT_A, O.unattributed, C.unattributed, "appointment_booked", "2026-08-13T17:00:00Z"),

        // The full path, so the three stages can be told apart.
        t(CLIENT_A, O.deep, C.deep, "appointment_booked", "2026-08-14T17:00:00Z"),
        t(CLIENT_A, O.deep, C.deep, "showed", "2026-08-18T17:00:00Z"),
        t(CLIENT_A, O.deep, C.deep, "closed_won", "2026-08-28T17:00:00Z"),

        // 🔴 Another tenant's ledger row pointing at THIS tenant's contact.
        // Only the client filter keeps it out.
        t(CLIENT_B, O.deep, C.fast, "closed_won", "2026-08-09T17:00:00Z"),
      ].join(",\n      ")}
  `);
}

const load = () => q.getSpeedToLeadOutcomes(CLIENT_A, RANGE(), TZ);
const byCall = async (secondsToCall: number | null) =>
  (await load()).leads.filter((l) => l.secondsToCall === secondsToCall);

/* ------------------------------------------------------------------ *
 * The cohort
 * ------------------------------------------------------------------ */

describe("who is in the cohort", () => {
  it("takes paid leads that arrived after call tracking went live", () => {
    // preTrack (too early) and unattributed (not paid) are the two exclusions.
    return load().then((r) => {
      expect(r.leads).toHaveLength(9);
      expect(r.trackingStartedAt).toBe(new Date(TRACKING_START).toISOString());
    });
  });

  it("🔴 counts pre-tracking leads separately rather than as never called", () => {
    // One lead in the range predates the cutover. Reported as unknown — the
    // panel's whole credibility on a client onboarded mid-life rests on this.
    return load().then((r) => expect(r.preTracking).toBe(1));
  });

  it("takes the cutover from CALL events only", async () => {
    // A ContactCreate event sits at 1 January. If the cutover were MIN over
    // every event type, the pre-tracking lead would be admitted with an unknown
    // call time and land in the "never called" row.
    const r = await load();
    expect(r.leads.some((l) => l.leadAt.startsWith("2026-08-02"))).toBe(false);
  });

  it("returns nothing measurable for a client with no call events", async () => {
    const r = await q.getSpeedToLeadOutcomes(CLIENT_B, RANGE(), TZ, {
      mode: "all",
      tag: "",
    });
    expect(r.trackingStartedAt).toBeNull();
    expect(r.leads).toHaveLength(0);
    // …but the lead is still counted, so the panel can say why it is absent.
    expect(r.preTracking).toBe(1);
  });

  it("🔴 is bounded by the selected range at both ends", async () => {
    /*
     * Everything else in the cohort is gated by the tracking cutover, which on
     * this fixture sits inside the range — so the range bound itself is only
     * observable from a window that starts AFTER tracking went live. Without
     * it, a client whose call tracking has been running for a year would have
     * their entire history dragged into every date range they select.
     */
    const narrow = await q.getSpeedToLeadOutcomes(
      CLIENT_A,
      windowFromKeys("2026-08-10", "2026-08-11", TZ),
      TZ,
    );
    expect(narrow.leads.map((l) => l.leadAt.slice(0, 10))).toEqual([
      "2026-08-10",
      "2026-08-11",
    ]);
    expect(narrow.preTracking).toBe(0);
  });

  it("applies the paid-lead filter", async () => {
    const r = await load();
    expect(r.leads.some((l) => l.leadAt.startsWith("2026-08-12T18"))).toBe(false);
    const all = await q.getSpeedToLeadOutcomes(CLIENT_A, RANGE(), TZ, {
      mode: "all",
      tag: "",
    });
    expect(all.leads).toHaveLength(10);
  });
});

/* ------------------------------------------------------------------ *
 * Response time
 * ------------------------------------------------------------------ */

describe("time to the first call", () => {
  it("measures it in seconds from lead-in", async () => {
    expect(await byCall(300)).toHaveLength(1);
    expect(await byCall(172_800)).toHaveLength(1);
  });

  it("🔴 treats a call logged before its own lead as unmeasured, not instant", async () => {
    /*
     * A negative response time would be arithmetically smaller than every real
     * one, so it buckets as "within 5 minutes" and lands in the fast arm — a
     * clock-skew artefact promoted to evidence that answering fast works.
     */
    const r = await load();
    const skewed = r.leads.find((l) => l.leadAt.startsWith("2026-08-09T17"))!;
    expect(skewed.secondsToCall).toBeNull();
    expect(r.leads.every((l) => l.secondsToCall === null || l.secondsToCall >= 0)).toBe(true);
  });

  it("carries no call time for a lead nobody called", async () => {
    const r = await load();
    const never = r.leads.find((l) => l.leadAt.startsWith("2026-08-08"))!;
    expect(never.secondsToCall).toBeNull();
    expect(never.callHour).toBeNull();
    expect(never.callDow).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * The outcome side — the half nothing joined before
 * ------------------------------------------------------------------ */

describe("what became of each lead", () => {
  it("🔴 follows the cohort forward out of the date range", async () => {
    // Booked five weeks after the range closed. Flow-in-window semantics —
    // right for a period report — would call this lead a failure.
    const r = await load();
    const late = r.leads.find((l) => l.leadAt.startsWith("2026-08-10"))!;
    expect(late.reached.appointment_booked).toBeCloseTo(41, 1);
  });

  it("🔴 measures to the FIRST time a stage was reached", async () => {
    const r = await load();
    const re = r.leads.find((l) => l.leadAt.startsWith("2026-08-11"))!;
    expect(re.reached.appointment_booked).toBeCloseTo(1, 1); // not 9
  });

  it("ignores a transition stamped before its own lead", async () => {
    const r = await load();
    const pre = r.leads.find((l) => l.leadAt.startsWith("2026-08-12T17"))!;
    expect(pre.reached.appointment_booked).toBeUndefined();
  });

  it("separates the three stages and their timings", async () => {
    const r = await load();
    const deep = r.leads.find((l) => l.leadAt.startsWith("2026-08-13"))!;
    expect(deep.reached.appointment_booked).toBeCloseTo(1, 1);
    expect(deep.reached.showed).toBeCloseTo(5, 1);
    expect(deep.reached.closed_won).toBeCloseTo(15, 1);
  });

  it("leaves a lead that reached nothing with an empty outcome map", async () => {
    const r = await load();
    const slow = r.leads.find((l) => l.leadAt.startsWith("2026-08-07"))!;
    expect(slow.reached).toEqual({});
  });

  it("🔴 does not read another tenant's ledger", async () => {
    // CLIENT_B has a closed_won row pointing at CLIENT_A's fastest lead. The
    // contact join alone would let it through and hand this client a deal that
    // is not theirs.
    const r = await load();
    const fast = r.leads.find((l) => l.secondsToCall === 300)!;
    expect(fast.reached.closed_won).toBeUndefined();
    expect(fast.reached.appointment_booked).toBeCloseTo(2, 1);
  });
});

/* ------------------------------------------------------------------ *
 * Local time — what the calling-window control depends on
 * ------------------------------------------------------------------ */

describe("weekday and hour", () => {
  it("🔴 reads them in the client's timezone, not UTC", async () => {
    /*
     * 17:00 UTC is 10:00 in Los Angeles. Seven hours out puts a mid-morning
     * lead in the afternoon, and the control that separates "we answered
     * slowly" from "it arrived at 2am" then controls for nothing.
     */
    const r = await load();
    const fast = r.leads.find((l) => l.secondsToCall === 300)!;
    expect(fast.arrivalHour).toBe(10);
    expect(fast.arrivalDow).toBe(4); // Thursday 6 August
    expect(fast.callHour).toBe(10);
  });

  it("🔴 crosses the date boundary the way the client's calendar does", async () => {
    /*
     * A lead that arrived Saturday night sits on SUNDAY in UTC. Read that way,
     * a weekend-evening enquiry is filed under a different day of the week —
     * so a client who does not work Sundays would have their busiest Saturday
     * evening ruled out of the control, and their Sunday silence ruled in.
     */
    const r = await load();
    const night = r.leads.find((l) => l.leadAt.startsWith("2026-08-09T05"))!;
    expect(night.arrivalDow).toBe(6); // Saturday locally, Sunday in UTC
    expect(night.arrivalHour).toBe(22);
    /*
     * The call side matters just as much: the working DAYS of the calling
     * window are counted from these. A team that works Sunday evenings would
     * read as working Mondays, and their Sunday leads would be ruled
     * out-of-hours — the control then excludes exactly the leads it exists to
     * examine.
     */
    expect(night.callDow).toBe(7); // Sunday locally, Monday in UTC
    expect(night.callHour).toBe(21);
    expect(night.secondsToCall).toBe(84_600);
  });
});
