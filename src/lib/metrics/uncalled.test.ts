import { describe, it, expect } from "vitest";
import {
  buildUncalled,
  measureWorkingDays,
  rankCallList,
  workingDaysSince,
  MAX_LISTED,
  type CallWeekday,
  type UncalledLead,
} from "./uncalled";

/**
 * A call list is judged one row at a time, so these fixtures are mostly about
 * who gets *off* it.
 *
 * Every exclusion here corresponds to a real row found in live data: someone who
 * booked online without a call, someone with no phone number on the record,
 * someone who arrived this morning, and someone who messaged in and was never
 * phoned. Get any one of them wrong and the panel is a list a person rings
 * through once, is embarrassed by, and never opens again.
 */

let seq = 0;
const lead = (o: Partial<UncalledLead> = {}): UncalledLead => ({
  contactId: `c-${String(++seq).padStart(4, "0")}`,
  opportunityId: "o-1",
  name: "Lead",
  phone: "+15550000000",
  leadAt: "2026-08-10T17:00:00.000Z",
  daysSinceDate: 3,
  // Monday, so the default fixture accrues working days on a Mon–Fri profile.
  leadDow: 1,
  isPaid: true,
  stage: "new_lead",
  ghlStageName: "New Lead",
  noOpportunity: false,
  hasInbound: false,
  hasOutbound: false,
  campaignId: null,
  campaignName: null,
  value: null,
  ...o,
});

/** Mon–Fri, comfortably over the measurement floor. */
const WEEKDAYS: CallWeekday[] = [
  { dow: 1, calls: 20 },
  { dow: 2, calls: 20 },
  { dow: 3, calls: 20 },
  { dow: 4, calls: 20 },
  { dow: 5, calls: 20 },
];

const build = (leads: UncalledLead[], o: Partial<Parameters<typeof buildUncalled>[1]> = {}) =>
  buildUncalled(leads, {
    callWeekdays: WEEKDAYS,
    trackingStartedAt: "2026-07-28T11:22:29.000Z",
    preTracking: 0,
    costPerLead: null,
    ...o,
  });

/* ------------------------------------------------------------------ *
 * Which days the clock runs on
 * ------------------------------------------------------------------ */

describe("measuring the working week", () => {
  it("returns null below the measurement floor", () => {
    // Nineteen calls describe one person's fortnight, not a working week — and
    // a wrong weekday profile silently shifts every threshold on the panel.
    expect(measureWorkingDays([{ dow: 2, calls: 19 }])).toBeNull();
  });

  it("measures at exactly the floor", () => {
    expect(measureWorkingDays([{ dow: 2, calls: 20 }])).toEqual([2]);
  });

  it("keeps a weekday sitting exactly on the share bar", () => {
    // "At least this share" — one call in fifty is 2% exactly. A strict
    // comparison here silently costs a client a working day, which shifts every
    // threshold on the panel by one.
    expect(
      measureWorkingDays([
        { dow: 1, calls: 49 },
        { dow: 2, calls: 1 },
      ]),
    ).toEqual([1, 2]);
  });

  it("🔴 keeps a weekday carrying 3.3% of calls", () => {
    /*
     * Taken from live data: this client places 3 of 92 first calls on Thursday.
     * The speed-to-lead panel's 5% bar would drop it, and a Thursday that does
     * not count means a Wednesday lead is not callable until Friday — a real
     * miss delayed a full day by a measurement artefact.
     */
    const days = measureWorkingDays([
      { dow: 1, calls: 5 },
      { dow: 2, calls: 51 },
      { dow: 3, calls: 10 },
      { dow: 4, calls: 3 },
      { dow: 5, calls: 23 },
    ]);
    expect(days).toEqual([1, 2, 3, 4, 5]);
  });

  it("drops a weekday below the bar", () => {
    // One stray Sunday call in 200 is somebody catching up, not a working day.
    const days = measureWorkingDays([
      { dow: 1, calls: 100 },
      { dow: 2, calls: 99 },
      { dow: 7, calls: 1 },
    ]);
    expect(days).toEqual([1, 2]);
  });

  it("keeps a Saturday for a client that works Saturdays", () => {
    // The reason this is measured rather than assumed: a med spa open at the
    // weekend would otherwise have its busiest day excluded from the clock.
    const days = measureWorkingDays([
      { dow: 5, calls: 30 },
      { dow: 6, calls: 40 },
    ]);
    expect(days).toEqual([5, 6]);
  });

  it("returns days in weekday order regardless of input order", () => {
    const days = measureWorkingDays([
      { dow: 5, calls: 30 },
      { dow: 1, calls: 30 },
      { dow: 3, calls: 30 },
    ]);
    expect(days).toEqual([1, 3, 5]);
  });
});

/* ------------------------------------------------------------------ *
 * The clock itself
 * ------------------------------------------------------------------ */

describe("counting working days", () => {
  const MF = [1, 2, 3, 4, 5];

  it("gives the arrival day itself nothing", () => {
    // A lead that came in at 4pm and one that came in at 8am have had very
    // different amounts of today; rather than model that, the day is forgiven.
    expect(workingDaysSince(0, 3, MF)).toBe(0);
  });

  it("returns zero for a negative gap", () => {
    // Clock skew between GHL's timestamps and ours. Never a negative wait.
    expect(workingDaysSince(-2, 3, MF)).toBe(0);
  });

  it("counts the day after a Wednesday arrival", () => {
    expect(workingDaysSince(1, 3, MF)).toBe(1);
  });

  it("🔴 does not age a Friday lead over the weekend", () => {
    /*
     * The single most important case. Wall-clock, a Friday-afternoon lead is
     * "two days old" on Sunday morning and would head the list — sent to a team
     * that is not in the building. One weekend of that and the panel is noise.
     */
    expect(workingDaysSince(1, 5, MF)).toBe(0); // Saturday
    expect(workingDaysSince(2, 5, MF)).toBe(0); // Sunday
    expect(workingDaysSince(3, 5, MF)).toBe(1); // Monday
  });

  it("wraps correctly from a Sunday arrival", () => {
    // leadDow 7 must roll to Monday, not to day 8.
    expect(workingDaysSince(1, 7, MF)).toBe(1);
  });

  it("counts a full week as five working days", () => {
    expect(workingDaysSince(7, 1, MF)).toBe(5);
  });

  it("matches a day-by-day count over a long gap", () => {
    /*
     * The closed form exists because this runs per lead on a page issuing ~60
     * queries, and a closed form that disagrees with the obvious loop is worse
     * than the loop. Checked against it across a full week of start days.
     */
    const loop = (gap: number, dow: number, days: number[]) => {
      let n = 0;
      for (let i = 1; i <= gap; i++) if (days.includes(((dow - 1 + i) % 7) + 1)) n++;
      return n;
    };
    for (let dow = 1; dow <= 7; dow++) {
      for (const gap of [1, 2, 3, 5, 8, 13, 30, 365]) {
        expect(workingDaysSince(gap, dow, MF)).toBe(loop(gap, dow, MF));
        expect(workingDaysSince(gap, dow, [6, 7])).toBe(loop(gap, dow, [6, 7]));
      }
    }
  });

  it("counts every calendar day when the week cannot be measured", () => {
    /*
     * The fallback errs toward flagging sooner, which is the safe direction: an
     * over-eager row is visible and self-corrects once enough calls land.
     * Assuming Monday-to-Friday instead would bake in an invented constant.
     */
    expect(workingDaysSince(2, 5, null)).toBe(2);
  });
});

/* ------------------------------------------------------------------ *
 * Who comes off the list
 * ------------------------------------------------------------------ */

describe("exclusions", () => {
  it("🔴 does not list someone who booked without a call", () => {
    /*
     * Live: five uncalled leads sit in Appointment Booked. They booked
     * themselves online. Ringing them to ask why nobody has been in touch is
     * the single fastest way to lose a reader's trust in this panel.
     */
    const r = build([lead({ stage: "appointment_booked" })]);
    expect(r.rows).toHaveLength(0);
    expect(r.progressed).toBe(1);
  });

  it("treats showed and no_show as already handled", () => {
    const r = build([lead({ stage: "showed" }), lead({ stage: "no_show" })]);
    expect(r.progressed).toBe(2);
    expect(r.callable).toBe(0);
  });

  it("counts a closed lead apart from a progressed one", () => {
    // "Marked lost and nobody ever phoned them" is a different sentence from
    // "booked without needing a call", and they must not share a counter.
    const r = build([
      lead({ stage: "lost" }),
      lead({ stage: "closed_won" }),
      lead({ stage: "disqualified" }),
    ]);
    expect(r.closedWithoutCall).toBe(3);
    expect(r.progressed).toBe(0);
  });

  it("still lists a contacted lead", () => {
    /*
     * `contacted` is NOT an exclusion, and that is deliberate. GHL's stage moves
     * are manual; somebody dragging a card to Contacted is not evidence a call
     * happened, and this panel's whole premise is that the call record beats
     * the stage label.
     */
    const r = build([lead({ stage: "contacted" })]);
    expect(r.rows).toHaveLength(1);
  });

  it("lists a lead with no opportunity at all", () => {
    // Live: ten of them. Nobody even made a card — the most complete miss the
    // pipeline can produce, and the one a stage-based list cannot see.
    const r = build([lead({ stage: null, opportunityId: null, noOpportunity: true })]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].noOpportunity).toBe(true);
    expect(r.rows[0].stageLabel).toBeNull();
  });

  it("🔴 keeps someone with no phone number off the list", () => {
    // Live: 5 of 26. Not a failure to call — a failure to capture, with a
    // different fix, and padding the call list with them helps nobody.
    const r = build([lead({ phone: null })]);
    expect(r.rows).toHaveLength(0);
    expect(r.noPhone).toBe(1);
  });

  it("does not list a lead that arrived today", () => {
    const r = build([lead({ daysSinceDate: 0 })]);
    expect(r.rows).toHaveLength(0);
    expect(r.tooRecent).toBe(1);
  });

  it("🔴 files a phoneless lead that arrived today under too-recent", () => {
    /*
     * Ordering assertion. "People we should have called but cannot" is a
     * statement about a missed obligation; a lead that arrived an hour ago is
     * not owed a call yet, so counting it as an unreachable failure would
     * overstate a data-capture problem the operator would then go and chase.
     */
    const r = build([lead({ phone: null, daysSinceDate: 0 })]);
    expect(r.tooRecent).toBe(1);
    expect(r.noPhone).toBe(0);
  });

  it("🔴 files a lead booked the same day under progressed, not too-recent", () => {
    // The stage check runs first because "not a task" outranks "not yet a
    // task" — reported the other way, tomorrow it would silently become one.
    const r = build([lead({ stage: "appointment_booked", daysSinceDate: 0 })]);
    expect(r.progressed).toBe(1);
    expect(r.tooRecent).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Why each row is on the list
 * ------------------------------------------------------------------ */

describe("classifying the reason", () => {
  it("🔴 calls an inbound message 'replied' even when we also messaged out", () => {
    /*
     * The distinction `first_touch_at` cannot make. A lead who wrote in is a
     * live human waiting on a phone call — the best call available today — and
     * treating them as "someone is working it by text" buries them.
     */
    const r = build([lead({ hasInbound: true, hasOutbound: true })]);
    expect(r.rows[0].kind).toBe("replied");
    expect(r.replied).toBe(1);
  });

  it("calls an outbound-only touch 'messaged'", () => {
    const r = build([lead({ hasOutbound: true })]);
    expect(r.rows[0].kind).toBe("messaged");
  });

  it("calls no contact at all 'untouched'", () => {
    const r = build([lead()]);
    expect(r.rows[0].kind).toBe("untouched");
  });
});

describe("the order it is dialled in", () => {
  it("🔴 puts replies first, then untouched, then messaged", () => {
    /*
     * Not by age, and not by stage depth like the aging panel. Nothing has been
     * invested in anybody here, so the only thing separating these rows is who
     * will still pick up: someone mid-conversation, then a stranger nobody has
     * tried, then a stranger somebody is already working by text.
     */
    const r = build([
      lead({ contactId: "c-msg", hasOutbound: true }),
      lead({ contactId: "c-none" }),
      lead({ contactId: "c-in", hasInbound: true }),
    ]);
    expect(r.rows.map((x) => x.contactId)).toEqual(["c-in", "c-none", "c-msg"]);
    // The headline counts replies only. It is the number that justifies calling
    // this list before anything else on the page, so it cannot quietly become
    // "everyone uncalled" the moment a second kind is present.
    expect(r.replied).toBe(1);
  });

  it("🔴 puts the freshest lead first within a kind", () => {
    /*
     * The opposite of the aging panel's order, on purpose. Reachability decays
     * steeply, so the newest callable lead is always the best call — and a list
     * sorted oldest-first spends the reader's afternoon on the least
     * answerable people it contains.
     */
    const r = build([
      lead({ contactId: "c-old", daysSinceDate: 20, leadDow: 1 }),
      lead({ contactId: "c-new", daysSinceDate: 1, leadDow: 1 }),
      lead({ contactId: "c-mid", daysSinceDate: 7, leadDow: 1 }),
    ]);
    expect(r.rows.map((x) => x.contactId)).toEqual(["c-new", "c-mid", "c-old"]);
  });

  it("ranks on working days, not calendar days", () => {
    /*
     * A Friday lead three calendar days old has waited one working day; a
     * Monday lead two calendar days old has waited two. Ordering by the
     * calendar would put them the wrong way round.
     */
    const rows = rankCallList([
      {
        contactId: "fri",
        opportunityId: null,
        name: null,
        phone: "1",
        leadAt: "2026-08-07T17:00:00.000Z",
        workingDaysWaiting: 1,
        calendarDays: 3,
        kind: "untouched",
        stage: null,
        stageLabel: null,
        ghlStageName: null,
        noOpportunity: true,
        campaignId: null,
        campaignName: null,
      },
      {
        contactId: "mon",
        opportunityId: null,
        name: null,
        phone: "1",
        leadAt: "2026-08-10T17:00:00.000Z",
        workingDaysWaiting: 2,
        calendarDays: 2,
        kind: "untouched",
        stage: null,
        stageLabel: null,
        ghlStageName: null,
        noOpportunity: true,
        campaignId: null,
        campaignName: null,
      },
    ]);
    expect(rows.map((r) => r.contactId)).toEqual(["fri", "mon"]);
  });

  it("breaks ties deterministically", () => {
    // Two leads from the same day must not reshuffle between page loads; a list
    // that reorders itself is one a reader cannot work through.
    const mk = (id: string) => lead({ contactId: id, daysSinceDate: 3, leadDow: 1 });
    const a = build([mk("c-b"), mk("c-a")]).rows.map((x) => x.contactId);
    const b = build([mk("c-a"), mk("c-b")]).rows.map((x) => x.contactId);
    expect(a).toEqual(["c-a", "c-b"]);
    expect(b).toEqual(a);
  });

  it("caps the list and says how many were left off", () => {
    /*
     * Written against 32 and 25 literally rather than against `MAX_LISTED`,
     * which would make the assertion agree with any cap at all. The number
     * matters: this is a list somebody dials through, and a hundred rows is a
     * database export wearing a call list's heading.
     */
    const many = Array.from({ length: 32 }, (_, i) =>
      lead({ contactId: `c-${String(i).padStart(3, "0")}` }),
    );
    const r = build(many);
    expect(MAX_LISTED).toBe(25);
    expect(r.rows).toHaveLength(25);
    expect(r.notListed).toBe(7);
    // The headline must count everyone, not just the visible rows.
    expect(r.callable).toBe(32);
  });
});

/* ------------------------------------------------------------------ *
 * The other side of the lead filter
 * ------------------------------------------------------------------ */

describe("leads outside the paid filter", () => {
  it("🔴 counts an unfiltered callable lead without listing it", () => {
    /*
     * Every other panel here is paid-only and the lead-filter note explains it.
     * This one is a task list, and "nobody to call" printed while two dozen
     * people sit unphoned outside the filter is the omission by silence this
     * product exists to replace.
     */
    const r = build([lead({ isPaid: false }), lead({ isPaid: true })]);
    expect(r.rows).toHaveLength(1);
    expect(r.outsideFilter).toBe(1);
  });

  it("🔴 holds unfiltered leads to the same standard as the list", () => {
    /*
     * The count is taken at the point a paid lead would join the list, after
     * every exclusion. Counting them earlier would produce a much larger, much
     * looser number sitting next to a carefully-filtered one, inviting the
     * reader to compare two things that were never measured the same way.
     */
    const r = build([
      lead({ isPaid: false, stage: "appointment_booked" }),
      lead({ isPaid: false, daysSinceDate: 0 }),
      lead({ isPaid: false, phone: null }),
      lead({ isPaid: false }),
    ]);
    expect(r.outsideFilter).toBe(1);
  });

  it("does not let unfiltered leads inflate the excluded counts", () => {
    // Those counters describe the panel's own population. An unfiltered lead
    // with no phone is not this client's ad-lead capture problem.
    const r = build([
      lead({ isPaid: false, phone: null }),
      lead({ isPaid: false, stage: "lost" }),
      lead({ isPaid: false, daysSinceDate: 0 }),
    ]);
    expect(r.noPhone).toBe(0);
    expect(r.closedWithoutCall).toBe(0);
    expect(r.tooRecent).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * What the leads cost
 * ------------------------------------------------------------------ */

describe("the price of not calling", () => {
  it("prices the whole callable set, including rows past the cap", () => {
    const many = Array.from({ length: MAX_LISTED + 5 }, (_, i) =>
      lead({ contactId: `c-${String(i).padStart(3, "0")}` }),
    );
    const r = build(many, { costPerLead: 10 });
    expect(r.wastedSpend).toBeCloseTo((MAX_LISTED + 5) * 10, 6);
  });

  it("🔴 reports nothing rather than zero when the list is empty", () => {
    /*
     * "$0 of leads nobody called" reads as an all-clear. It is the correct
     * number here, but the empty state already says so in words, and a currency
     * figure of zero drawn from an empty set is the shape of a broken pipe.
     */
    const r = build([], { costPerLead: 10 });
    expect(r.wastedSpend).toBeNull();
  });

  it("reports nothing when no cost per lead is known", () => {
    const r = build([lead()], { costPerLead: null });
    expect(r.wastedSpend).toBeNull();
    expect(r.callable).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * What the panel knows about itself
 * ------------------------------------------------------------------ */

describe("what gets reported alongside", () => {
  it("carries the pre-tracking count and the cutover through", () => {
    /*
     * Live, 1,554 of 1,604 contacts predate call visibility. A null
     * `first_call_at` for those means unobserved, not uncalled — the source
     * spreadsheet's `SHOWN = 0 forever` in a new costume — so the number is
     * reported beside the list rather than folded into it.
     */
    const r = build([], { preTracking: 1554 });
    expect(r.preTracking).toBe(1554);
    expect(r.trackingStartedAt).toBe("2026-07-28T11:22:29.000Z");
  });

  it("surfaces the measured working week so a reader can check it", () => {
    const r = build([]);
    expect(r.workingDays).toEqual([1, 2, 3, 4, 5]);
  });

  it("reports an unmeasurable working week as null", () => {
    const r = build([], { callWeekdays: [{ dow: 2, calls: 3 }] });
    expect(r.workingDays).toBeNull();
  });

  it("still lists leads when the working week is unmeasurable", () => {
    // A brand new client has no call history at all. The panel must degrade to
    // calendar days rather than going blank on its first useful week.
    const r = build([lead({ daysSinceDate: 2, leadDow: 5 })], {
      callWeekdays: [{ dow: 2, calls: 3 }],
    });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].workingDaysWaiting).toBe(2);
  });

  it("keeps calendar days on the row for display", () => {
    // "6 days ago" is what a person understands; "3 working days" is what the
    // panel judges by. Both are needed, and they are not the same number.
    const r = build([lead({ daysSinceDate: 6, leadDow: 3 })]);
    expect(r.rows[0].calendarDays).toBe(6);
    expect(r.rows[0].workingDaysWaiting).toBe(4);
  });
});
