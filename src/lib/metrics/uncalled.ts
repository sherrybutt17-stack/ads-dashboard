import { STAGE_LABELS, type CanonicalStage } from "@/lib/stages";

/**
 * Who has never been phoned.
 *
 * Every other panel in this dashboard is analytics: it tells you something and
 * you decide what to do. This one is a task list. Its output is names, in the
 * order to dial them, and its only measure of success is whether somebody picks
 * up the phone because of it.
 *
 * That changes what "correct" means. An analytics panel that is 10% wrong is
 * 90% useful. A call list that is 10% wrong gets used twice: the second time
 * someone rings a lead their colleague booked yesterday, and nobody opens it
 * again. So the bar here is not accuracy in aggregate, it is that **every
 * single row is a person who genuinely should be called right now.**
 *
 * Four things get someone off the list, and all four were found in live data:
 *
 * **1 · We could not have known.** `first_call_at` is populated by the GHL
 * OutboundMessage webhook, which has only existed since this client was
 * connected. Before that instant a null means "unobserved", not "not called" —
 * on this deployment that is 1,554 of 1,604 contacts. Listing them would
 * reproduce the source spreadsheet's `SHOWN = 0 forever` exactly: a column
 * confidently reporting an absence of evidence as evidence of absence.
 *
 * **2 · There is no phone number.** Live: 5 of 26. Not a failure to call — a
 * failure to *capture*, usually a lead form without a phone field. It belongs on
 * the panel, but as its own line with its own fix, never padding the call list
 * with people who cannot be called.
 *
 * **3 · They already moved.** Live: 5 uncalled leads sit in Appointment Booked.
 * They booked themselves, online, without anyone phoning them. That is a fact
 * worth reporting and the opposite of a task.
 *
 * **4 · There has not been time yet.** A lead that arrived twenty minutes ago is
 * not a miss. See `MIN_WORKING_DAYS` for why the clock counts working days
 * rather than hours, and why the threshold is not measured from this client's
 * own habits like the aging panel's is.
 *
 * ---
 *
 * **🔴 `first_touch_at` cannot tell you whether anybody reached out.**
 *
 * The tempting simplification is "no call but a touch exists ⇒ someone is
 * working it by text". It is wrong, and wrong in the worst direction:
 * `recordMessageTouch` sets that column from **both** InboundMessage and
 * OutboundMessage webhooks, so a lead who messaged *in* and was ignored looks
 * identical to one we messaged *out* to. That lead is the single hottest call on
 * the list — a person who raised their hand and got silence — and the
 * simplification would file them as handled.
 *
 * So direction is recovered from `webhook_events`, which stores every raw
 * payload precisely so a derived column that lost a distinction can be rebuilt
 * without a migration. It is why the log exists.
 */

/* ------------------------------------------------------------------ *
 * Inputs
 * ------------------------------------------------------------------ */

/** One trackable lead with no recorded outbound call. */
export interface UncalledLead {
  contactId: string;
  opportunityId: string | null;
  name: string | null;
  /** Null when the record carries no dialable number. */
  phone: string | null;
  /** Lead-in time, ISO — displayed, never used for the clock. */
  leadAt: string;
  /**
   * Whole calendar days from the lead's arrival DATE to today, both in the
   * client's timezone. Computed in SQL, where the timezone arithmetic is exact.
   */
  daysSinceDate: number;
  /** ISO weekday (1 = Mon) of the arrival date, in the client's timezone. */
  leadDow: number;
  /**
   * Whether this lead counts as paid under the dashboard's lead filter.
   *
   * Both sides are fetched and classified by the same code, so the "and this
   * many more outside the filter" line cannot drift from the list beside it.
   */
  isPaid: boolean;
  /**
   * The furthest-along stage across this lead's opportunities — null when they
   * have none, or the GHL stage maps to nothing canonical.
   */
  stage: CanonicalStage | null;
  ghlStageName: string | null;
  /** True when this lead has no opportunity record at all. */
  noOpportunity: boolean;
  /** A message FROM this lead exists. They are waiting on us. */
  hasInbound: boolean;
  /** A message TO this lead exists. Somebody is working it, just not by phone. */
  hasOutbound: boolean;
  campaignId: string | null;
  campaignName: string | null;
  value: number | null;
}

/** First-call weekday counts, used to work out which days are working days. */
export interface CallWeekday {
  /** ISO weekday, 1 = Mon. */
  dow: number;
  calls: number;
}

/* ------------------------------------------------------------------ *
 * Outputs
 * ------------------------------------------------------------------ */

/**
 * Why this lead is on the list — which determines the order it is worked in.
 *
 * `replied` first, and that is the whole reason this type exists rather than a
 * flat list sorted by age. Someone who answered a text and never got a call is
 * a live conversation with a gap in it. Someone nobody has touched at all is a
 * cold dial. The first converts; the second is a chore.
 */
export type UncalledKind = "replied" | "untouched" | "messaged";

export const KIND_ORDER: readonly UncalledKind[] = ["replied", "untouched", "messaged"];

export interface CallListRow {
  contactId: string;
  opportunityId: string | null;
  name: string | null;
  phone: string;
  leadAt: string;
  /** Working days elapsed since arrival — the clock this panel judges by. */
  workingDaysWaiting: number;
  /** Calendar days, for display: "6 days ago" is what a person understands. */
  calendarDays: number;
  kind: UncalledKind;
  stage: CanonicalStage | null;
  stageLabel: string | null;
  ghlStageName: string | null;
  noOpportunity: boolean;
  campaignId: string | null;
  campaignName: string | null;
}

export interface UncalledReport {
  /** The call list, ranked and capped. */
  rows: CallListRow[];
  /** Ranked rows beyond the cap. */
  notListed: number;
  /** Total callable, past the grace period — `rows.length + notListed`. */
  callable: number;
  /** Waiting on a reply from us. The subset of `callable` worth naming first. */
  replied: number;
  /** Uncalled and past grace, but no phone number on the record. */
  noPhone: number;
  /** Uncalled but already at appointment_booked or deeper — booked themselves. */
  progressed: number;
  /** Uncalled and already won, lost or disqualified. Nobody tried. */
  closedWithoutCall: number;
  /** Uncalled but still inside the grace period. Not yet a miss. */
  tooRecent: number;
  /** Arrived before call tracking existed, so their call history is unknowable. */
  preTracking: number;
  /**
   * Uncalled leads that fall OUTSIDE this dashboard's paid-lead filter.
   *
   * 🔴 Counted, because a call list that reads "0 to call" while two dozen
   * people sit unphoned outside the filter is the omission this product exists
   * to prevent — and unlike every other panel here, the reader's next action
   * depends on the whole pipeline, not the advertised part of it.
   */
  outsideFilter: number;
  /** Spend attributable to the callable leads, when a cost per lead is known. */
  wastedSpend: number | null;
  /** Which weekdays this client actually makes calls on; null = not measurable. */
  workingDays: number[] | null;
  /** When call visibility began. Null means no call has ever been observed. */
  trackingStartedAt: string | null;
}

export const EMPTY_UNCALLED: UncalledReport = {
  rows: [],
  notListed: 0,
  callable: 0,
  replied: 0,
  noPhone: 0,
  progressed: 0,
  closedWithoutCall: 0,
  tooRecent: 0,
  preTracking: 0,
  outsideFilter: 0,
  wastedSpend: null,
  workingDays: null,
  trackingStartedAt: null,
};

/* ------------------------------------------------------------------ *
 * Thresholds
 * ------------------------------------------------------------------ */

/**
 * 🔴 One full working day, fixed — deliberately NOT measured from this client's
 * own response times, which is what the aging panel next door does.
 *
 * The difference is that stage dwell has no external truth. How long a med spa's
 * consultations take before a decision is whatever it is, so the ledger is the
 * only authority and a measured 90th percentile is the honest bar.
 *
 * Response time is not like that. It is one of the most replicated findings in
 * sales that reachability collapses within the first hours, and it does not
 * become untrue because a particular team is slow. Measuring this client and
 * calling the result the standard would mean deriving the bar from the very
 * behaviour the panel exists to catch: live, this client's own 90th percentile
 * time-to-first-call is **5.2 days**, so a measured threshold would quietly
 * certify a lead ignored for most of a week as normal.
 *
 * So the threshold is external and the *clock* is local. One working day is
 * short enough to be a real standard and long enough that nobody can argue they
 * had no chance — and the panel prints the client's own median beside it, which
 * is where the actual argument belongs.
 */
const MIN_WORKING_DAYS = 1;

/**
 * A weekday carrying at least this share of first calls is a working day.
 *
 * 2%, not the 5% the speed-to-lead panel uses for the same measurement, and the
 * difference is not an oversight. There it decides whether a lead *arrived* in
 * working hours — a control, where a strict cut is conservative. Here it decides
 * whether the clock runs, so a wrongly-excluded weekday silently delays a real
 * miss by a day, and the conservative direction is to include.
 *
 * The 5% bar demonstrably cuts too deep for that: live, this client places 3 of
 * 92 first calls on a Thursday — 3.3%, under the bar — and a Thursday that does
 * not count means a Wednesday lead is not callable until Friday. Thursday is
 * plainly a working day; it is just their quietest one.
 */
const WORKING_DAY_SHARE = 0.02;

/** Below this many observed calls, a weekday profile is a handful of anecdotes. */
const MIN_CALLS_TO_MEASURE = 20;

/** The list is dialled by a person. Past this it is a database export. */
export const MAX_LISTED = 25;

/* ------------------------------------------------------------------ *
 * Engine
 * ------------------------------------------------------------------ */

/**
 * Which weekdays does this client actually make calls on?
 *
 * Returns null rather than guessing. A null means the clock falls back to plain
 * calendar days, which flags marginally sooner than reality — the safe direction
 * for a fallback, since the error is visible on the panel and self-corrects the
 * moment enough calls have been observed. Assuming Monday-to-Friday instead
 * would be an invented constant, and wrong for exactly the Saturday-opening med
 * spas this product is aimed at.
 */
export function measureWorkingDays(counts: readonly CallWeekday[]): number[] | null {
  let total = 0;
  for (const c of counts) total += c.calls;
  if (total < MIN_CALLS_TO_MEASURE) return null;

  /*
   * No `days.length > 0` guard. An empty result would freeze the clock at zero
   * forever, so one was written — and it cannot happen: at most seven weekdays
   * exist and shares that sum to 1 cannot all sit under 2%. Untestable
   * defensive code is a liability rather than a safeguard, so it is gone and
   * the reasoning is here instead.
   */
  return counts
    .filter((c) => c.calls / total >= WORKING_DAY_SHARE)
    .map((c) => c.dow)
    .sort((a, b) => a - b);
}

/**
 * Working days elapsed since a lead arrived.
 *
 * The arrival day itself never counts. A lead that came in at 4pm and one that
 * came in at 8am have had wildly different amounts of the day available, and
 * rather than model that, the whole day is forgiven: **a lead becomes callable
 * the next working day.** That is a rule anybody can hold in their head and
 * check against their own memory, which matters more here than precision that
 * would put a 4pm lead on the list at 5pm.
 *
 * Closed form rather than a loop over days, because the gap can be years — this
 * runs once per uncalled lead on a page that already issues ~60 queries.
 */
export function workingDaysSince(
  daysSinceDate: number,
  leadDow: number,
  workingDays: readonly number[] | null,
): number {
  /*
   * `<= 0` rather than `< 0` is a fast path, not a behaviour: at zero the
   * arithmetic below already returns zero. The guard is load-bearing only for
   * negative gaps — clock skew between GHL's timestamps and ours — where
   * `Math.floor(-2 / 7)` would otherwise produce a negative wait. Mutating it to
   * `< 0` survives every test, and it should: the two are equivalent.
   */
  if (!Number.isFinite(daysSinceDate) || daysSinceDate <= 0) return 0;
  // No measured profile: every day counts, so the answer is the gap itself.
  if (workingDays === null) return daysSinceDate;

  const weeks = Math.floor(daysSinceDate / 7);
  let count = weeks * workingDays.length;
  // The run of days being counted starts the day AFTER arrival.
  const startDow = (leadDow % 7) + 1;
  for (let i = 0; i < daysSinceDate % 7; i++) {
    if (workingDays.includes(((startDow - 1 + i) % 7) + 1)) count++;
  }
  return count;
}

/** Stages that mean somebody is already dealing with this person. */
const PROGRESSED: readonly CanonicalStage[] = ["appointment_booked", "showed", "no_show"];
const CLOSED: readonly CanonicalStage[] = ["closed_won", "lost", "disqualified"];

function kindOf(l: UncalledLead): UncalledKind {
  if (l.hasInbound) return "replied";
  return l.hasOutbound ? "messaged" : "untouched";
}

/**
 * The order the list is dialled in.
 *
 * By urgency of kind, then **newest first** — which is the opposite of the aging
 * panel's order, and the opposite for a reason rather than by accident. Aging
 * ranks by how much has been invested in a lead, because a booked lead who went
 * quiet is worth more than a fresh form fill. Here nothing has been invested in
 * anyone: every row is a stranger, and the only thing separating them is whether
 * they will still answer. That decays fast, so the freshest callable lead is
 * always the best call on the list.
 *
 * The old ones are not lost — they are counted, and they keep their place in the
 * kind above them.
 */
export function rankCallList(rows: readonly CallListRow[]): CallListRow[] {
  return [...rows].sort((a, b) => {
    const k = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
    if (k !== 0) return k;
    const age = a.workingDaysWaiting - b.workingDaysWaiting;
    if (age !== 0) return age;
    return a.contactId < b.contactId ? -1 : 1;
  });
}

export function buildUncalled(
  leads: readonly UncalledLead[],
  opts: {
    callWeekdays: readonly CallWeekday[];
    trackingStartedAt: string | null;
    preTracking: number;
    /** Cost per paid lead over the same population, or null when unknown. */
    costPerLead: number | null;
  },
): UncalledReport {
  const workingDays = measureWorkingDays(opts.callWeekdays);

  const callable: CallListRow[] = [];
  let noPhone = 0;
  let progressed = 0;
  let closedWithoutCall = 0;
  let tooRecent = 0;
  let replied = 0;
  let outsideFilter = 0;

  for (const l of leads) {
    /*
     * Stage first, before anything else — a lead who booked without a call is
     * not "too recent" or "unreachable", they are simply not a task, and
     * reporting them under any other heading would be a miscount rather than a
     * different phrasing.
     */
    if (l.stage !== null && CLOSED.includes(l.stage)) {
      if (l.isPaid) closedWithoutCall++;
      continue;
    }
    if (l.stage !== null && PROGRESSED.includes(l.stage)) {
      if (l.isPaid) progressed++;
      continue;
    }

    const waiting = workingDaysSince(l.daysSinceDate, l.leadDow, workingDays);
    if (waiting < MIN_WORKING_DAYS) {
      if (l.isPaid) tooRecent++;
      continue;
    }

    // Last, so the count means "people we should have called but cannot",
    // rather than sweeping in leads that were never due yet.
    if (l.phone === null) {
      if (l.isPaid) noPhone++;
      continue;
    }

    /*
     * Everything from here would appear on the list. The unfiltered ones are
     * counted at exactly this point and nowhere else, so the sentence "and N
     * more outside the ad-attributed leads" describes the same standard the
     * list itself was built to — not a looser count of everyone uncalled.
     */
    if (!l.isPaid) {
      outsideFilter++;
      continue;
    }

    const kind = kindOf(l);
    if (kind === "replied") replied++;
    callable.push({
      contactId: l.contactId,
      opportunityId: l.opportunityId,
      name: l.name,
      phone: l.phone,
      leadAt: l.leadAt,
      workingDaysWaiting: waiting,
      calendarDays: l.daysSinceDate,
      kind,
      stage: l.stage,
      stageLabel: l.stage ? STAGE_LABELS[l.stage] : null,
      ghlStageName: l.ghlStageName,
      noOpportunity: l.noOpportunity,
      campaignId: l.campaignId,
      campaignName: l.campaignName,
    });
  }

  const ranked = rankCallList(callable);

  return {
    rows: ranked.slice(0, MAX_LISTED),
    notListed: Math.max(0, ranked.length - MAX_LISTED),
    callable: ranked.length,
    replied,
    noPhone,
    progressed,
    closedWithoutCall,
    tooRecent,
    preTracking: opts.preTracking,
    outsideFilter,
    /*
     * What the unanswered leads cost to buy. Null rather than zero when no cost
     * per lead is known — "$0 of leads nobody called" reads as a reassurance,
     * and it would be one drawn from missing data.
     */
    wastedSpend:
      opts.costPerLead !== null && ranked.length > 0
        ? opts.costPerLead * ranked.length
        : null,
    workingDays,
    trackingStartedAt: opts.trackingStartedAt,
  };
}
