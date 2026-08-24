import { probBetaGreater, betaQuantile } from "./stats";
import type { CanonicalStage } from "@/lib/stages";

/**
 * Does answering faster actually book more appointments — for THIS client?
 *
 * Both halves have been stored for months and nothing joined them: response time
 * lives on `contacts.first_call_at`, the outcome lives in the stage-transition
 * ledger. The join is one query. Getting the join *right* is the work, because
 * three separate effects each produce a confident, wrong answer.
 *
 * ---
 *
 * **1 · 🔴 Censoring, which biases against the thing being measured.**
 *
 * A lead that arrived two days ago has not had time to book. Count it as a
 * failure and it drags down whichever bucket it lands in — and it lands in the
 * FAST bucket, because response times improve over time, most of all when a
 * client starts watching this panel. So the naive version reports "answering
 * faster makes no difference" exactly when the client has started answering
 * faster. A feature that breaks when it works is worse than no feature.
 *
 * The fix is standard right-censoring: a lead counts only once it is old enough
 * to have converted — **unless it already has**, in which case it is a settled
 * observation at any age. Dropping young converters would bias the other way,
 * against fast responders, who are precisely the ones converting quickly.
 *
 * **2 · 🔴 Triage, which is selection on the outcome.**
 *
 * Never-called leads are not "infinitely slow". A team that skips the obvious
 * junk produces a never-called group that converts at zero *because of that
 * judgement*, not because of speed — folding it into the slow side would
 * manufacture a speed effect out of triage. So the headline contrast is
 * called-fast against called-slow, and never-called is reported on its own line,
 * outside the comparison, with the reason stated.
 *
 * **3 · Confounding by arrival time.**
 *
 * A lead arriving at 2am gets a slow response through nobody's failure, and 2am
 * leads may simply be worse leads. If that is what is happening, the honest
 * finding is "night leads convert worse", not "call faster" — opposite advice.
 * The control re-runs the contrast over leads that arrived inside the hours this
 * client actually places calls, **measured from their own call log** rather than
 * assumed, so the control is not itself a guess wearing a lab coat.
 *
 * What survives all three is still a correlation, and the panel says so. One
 * mechanism it does NOT suffer from is worth naming: `first_call_at` is the
 * first outbound *attempt*, not a connection, so "keen leads answer the phone
 * faster" cannot produce this effect — the clock starts when the team dials.
 */

export type OutcomeStage = "appointment_booked" | "showed" | "closed_won";

export const OUTCOME_STAGES: readonly OutcomeStage[] = [
  "appointment_booked",
  "showed",
  "closed_won",
];

export const OUTCOME_VERB: Record<OutcomeStage, string> = {
  appointment_booked: "booked",
  showed: "showed up",
  closed_won: "closed",
};

export const OUTCOME_NOUN: Record<OutcomeStage, string> = {
  appointment_booked: "appointments",
  showed: "shows",
  closed_won: "closed deals",
};

export const OUTCOME_LABEL: Record<OutcomeStage, string> = {
  appointment_booked: "Booked",
  showed: "Showed",
  closed_won: "Closed",
};

/** Completes "Does answering faster …?" — a heading has to be a sentence. */
export const OUTCOME_QUESTION: Record<OutcomeStage, string> = {
  appointment_booked: "book more appointments",
  showed: "get more people to turn up",
  closed_won: "close more deals",
};

/**
 * The contrast, fixed in advance and identical for every client.
 *
 * One hour, not the industry's five minutes. Five minutes is the famous number
 * and it is on the bucket table where a reader can see it — but as the *test's*
 * split it puts almost every lead on one side at real agency volumes, and a
 * contrast with three leads in one arm cannot answer anything. One hour divides
 * a typical book closer to evenly, which is where the comparison has power.
 *
 * 🔴 Fixed, and never chosen per client. A threshold picked to maximise the gap
 * would find one in pure noise for every client on the roster.
 */
export const FAST_THRESHOLD_SECONDS = 3600;

/** How the response-time table is cut. Fixed bins, for the same reason. */
export const RESPONSE_BUCKETS = [
  { id: "under_5m", label: "Within 5 min", max: 300 },
  { id: "under_1h", label: "5 – 60 min", max: 3600 },
  { id: "under_24h", label: "1 – 24 hr", max: 86400 },
  { id: "over_24h", label: "After 24 hr", max: Infinity },
] as const;

export type BucketId = (typeof RESPONSE_BUCKETS)[number]["id"] | "never";

/**
 * How long a lead must be observable before its absence of a conversion means
 * anything — used only until the client's own history can answer it.
 *
 * Deliberately generous. Too short and immature leads are counted as failures,
 * which is the bias described above; too long only costs sample size, and the
 * count of what was withheld is shown either way.
 */
const DEFAULT_MATURATION_DAYS: Record<OutcomeStage, number> = {
  appointment_booked: 14,
  showed: 30,
  closed_won: 45,
};

/** Below this many observed conversions, the measured p90 is one lead's story. */
const MIN_MATURATION_SAMPLE = 5;
/** A p90 of zero would mature every lead instantly; a day is the floor. */
const MIN_MATURATION_DAYS = 1;
/** One 200-day deal must not push the whole cohort out of the denominator. */
const MAX_MATURATION_DAYS = 60;

/** Below this, "the hours you make calls" is a guess about four phone calls. */
const MIN_WINDOW_CALLS = 20;
/** A weekday carrying less than this share of calls is not a working day. */
const WORKING_DAY_SHARE = 0.05;

/** Credible-interval mass. 80%, because 95% at n=12 is a bar the width of the row. */
const INTERVAL_MASS = 0.8;

/* ------------------------------------------------------------------ *
 * Inputs
 * ------------------------------------------------------------------ */

/** One lead in the cohort, as the query returns it. */
export interface SpeedOutcomeLead {
  /** Lead-in time, ISO. */
  leadAt: string;
  /** Seconds from lead-in to the first outbound call; null = never called. */
  secondsToCall: number | null;
  /** Weekday (1 = Mon … 7 = Sun) and hour of arrival, in the client's timezone. */
  arrivalDow: number;
  arrivalHour: number;
  /** Weekday and hour of the first call — what defines the calling window. */
  callDow: number | null;
  callHour: number | null;
  /** Days from lead-in to FIRST reaching each stage. Absent = never reached. */
  reached: Partial<Record<OutcomeStage, number>>;
}

/* ------------------------------------------------------------------ *
 * Outputs
 * ------------------------------------------------------------------ */

export interface RateGroup {
  leads: number;
  converted: number;
  /** Null when there are no leads — never 0%, which would read as a finding. */
  rate: number | null;
  /** 80% credible interval on the rate, or null with no leads. */
  lo: number | null;
  hi: number | null;
}

export interface BucketOutcome extends RateGroup {
  id: BucketId;
  label: string;
  /** Never-called leads sit outside the comparison — see the header note. */
  inComparison: boolean;
}

export type VerdictStrength =
  | "fast_clear"
  | "fast_leaning"
  | "inconclusive"
  | "slow_leaning"
  | "slow_clear";

export interface Verdict {
  fast: RateGroup;
  slow: RateGroup;
  /** P(the fast group's true rate exceeds the slow group's). */
  probFastBetter: number;
  /** Percentage points, fast − slow. Null if either arm is empty. */
  gapPoints: number | null;
  strength: VerdictStrength;
}

/** The hours and days this client is actually on the phone, measured. */
export interface CallingWindow {
  /** 10th and 90th percentile of the hour at which first calls are placed. */
  startHour: number;
  endHour: number;
  /** Weekdays (1 = Mon) carrying a meaningful share of calls. */
  days: number[];
  /** How many first calls the window was measured from. */
  calls: number;
}

export interface StageOutcome {
  stage: OutcomeStage;
  label: string;
  verb: string;
  noun: string;
  /** A GHL stage is bound to this canonical stage. */
  mapped: boolean;
  /** Leads old enough to judge, or already converted. The denominator. */
  matured: number;
  /** Leads too new to judge — withheld, never counted as failures. */
  maturing: number;
  maturationDays: number;
  /** True when measured from this client's own conversions, not the default. */
  maturationMeasured: boolean;
  /** Conversions among matured leads. */
  converted: number;
  buckets: BucketOutcome[];
  /** Null when neither arm of the contrast has a lead in it. */
  verdict: Verdict | null;
  /**
   * The same contrast over leads that arrived inside the calling window. Null
   * when the window could not be measured, or when the restriction empties an
   * arm — in which case the confound is stated rather than pretend-controlled.
   */
  control: Verdict | null;
}

export interface SpeedOutcome {
  /** When outbound-call tracking went live; before it, nothing is measurable. */
  trackingStartedAt: string | null;
  /** Leads in the window that arrived after tracking went live. */
  cohort: number;
  /** Leads in the window that predate tracking — unknowable, not misses. */
  preTracking: number;
  stages: StageOutcome[];
  defaultStage: OutcomeStage;
  callingWindow: CallingWindow | null;
}

/* ------------------------------------------------------------------ *
 * Engine
 * ------------------------------------------------------------------ */

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * A rate with its uncertainty, under a uniform prior.
 *
 * The interval is what stops "100% of leads called within 5 minutes booked"
 * from reading as a fact when it came from one lead — that row's interval spans
 * roughly 10% to 100%, which is the honest picture. The plan's rule holds: the
 * figure is never suppressed, it is qualified.
 */
function rateGroup(leads: number, converted: number): RateGroup {
  if (leads <= 0) return { leads: 0, converted: 0, rate: null, lo: null, hi: null };
  const a = converted + 1;
  const b = leads - converted + 1;
  const tail = (1 - INTERVAL_MASS) / 2;
  return {
    leads,
    converted,
    rate: converted / leads,
    lo: betaQuantile(a, b, tail),
    hi: betaQuantile(a, b, 1 - tail),
  };
}

export function verdictStrength(probFastBetter: number): VerdictStrength {
  if (probFastBetter >= 0.95) return "fast_clear";
  if (probFastBetter >= 0.8) return "fast_leaning";
  /*
   * The mirror cases exist because "slower converts better" must be reportable.
   * Collapsing them into "inconclusive" would let the panel quietly withhold a
   * result that contradicts the advice it is built to give, which is the same
   * one-directional honesty the source spreadsheet practised.
   */
  if (probFastBetter <= 0.05) return "slow_clear";
  if (probFastBetter <= 0.2) return "slow_leaning";
  return "inconclusive";
}

function buildVerdict(
  leads: readonly { fast: boolean; converted: boolean }[],
): Verdict | null {
  let fastN = 0;
  let fastK = 0;
  let slowN = 0;
  let slowK = 0;
  for (const l of leads) {
    if (l.fast) {
      fastN++;
      if (l.converted) fastK++;
    } else {
      slowN++;
      if (l.converted) slowK++;
    }
  }
  // A contrast needs two sides. One arm empty is not a weak finding, it is no
  // comparison at all, and rendering it as 50/50 would imply we had looked.
  if (fastN === 0 || slowN === 0) return null;

  const fast = rateGroup(fastN, fastK);
  const slow = rateGroup(slowN, slowK);
  const prob = probBetaGreater(fastK + 1, fastN - fastK + 1, slowK + 1, slowN - slowK + 1);

  return {
    fast,
    slow,
    probFastBetter: prob,
    gapPoints:
      fast.rate !== null && slow.rate !== null ? (fast.rate - slow.rate) * 100 : null,
    strength: verdictStrength(prob),
  };
}

/**
 * When is this client actually on the phone?
 *
 * Measured from the hours their own first calls land in, never assumed. An
 * assumed 9-to-5 would be an arbitrary constant laundered as a control, and for
 * a med spa open Saturdays it would be wrong in the direction that matters.
 */
export function measureCallingWindow(
  leads: readonly SpeedOutcomeLead[],
): CallingWindow | null {
  const hours: number[] = [];
  const byDay = new Map<number, number>();
  for (const l of leads) {
    if (l.callHour === null || l.callDow === null) continue;
    hours.push(l.callHour);
    byDay.set(l.callDow, (byDay.get(l.callDow) ?? 0) + 1);
  }
  if (hours.length < MIN_WINDOW_CALLS) return null;

  hours.sort((a, b) => a - b);
  const days = [...byDay.entries()]
    .filter(([, n]) => n / hours.length >= WORKING_DAY_SHARE)
    .map(([d]) => d)
    .sort((a, b) => a - b);

  return {
    startHour: Math.floor(quantile(hours, 0.1)),
    endHour: Math.ceil(quantile(hours, 0.9)),
    calls: hours.length,
    days,
  };
}

export function inCallingWindow(lead: SpeedOutcomeLead, w: CallingWindow): boolean {
  return (
    w.days.includes(lead.arrivalDow) &&
    lead.arrivalHour >= w.startHour &&
    lead.arrivalHour <= w.endHour
  );
}

function bucketFor(secondsToCall: number | null): BucketId {
  if (secondsToCall === null) return "never";
  for (const b of RESPONSE_BUCKETS) if (secondsToCall <= b.max) return b.id;
  return "over_24h";
}

/**
 * Days a lead must survive un-converted before its silence counts as a no.
 *
 * Exported so §6.18 judges "old enough to count" by exactly this rule. Two
 * implementations of the same censoring would drift, and the two panels sit on
 * the same page reporting conversion rates over the same leads — a lead counted
 * in one and withheld from the other is a discrepancy nobody would trace back.
 */
export function maturationFor(
  stage: OutcomeStage,
  observedDays: readonly number[],
): { days: number; measured: boolean } {
  if (observedDays.length < MIN_MATURATION_SAMPLE) {
    return { days: DEFAULT_MATURATION_DAYS[stage], measured: false };
  }
  const sorted = [...observedDays].sort((a, b) => a - b);
  const p90 = quantile(sorted, 0.9);
  return {
    days: Math.min(MAX_MATURATION_DAYS, Math.max(MIN_MATURATION_DAYS, p90)),
    measured: true,
  };
}

export function buildSpeedOutcome(
  leads: readonly SpeedOutcomeLead[],
  opts: {
    asOf: Date;
    mappedStages: ReadonlySet<CanonicalStage>;
    trackingStartedAt: string | null;
    preTracking?: number;
  },
): SpeedOutcome {
  const window = measureCallingWindow(leads);
  const asOfMs = opts.asOf.getTime();

  const stages: StageOutcome[] = OUTCOME_STAGES.map((stage) => {
    const observed = leads
      .map((l) => l.reached[stage])
      .filter((d): d is number => d !== undefined);
    const { days: maturationDays, measured } = maturationFor(stage, observed);

    let maturing = 0;
    const judged: {
      bucket: BucketId;
      fast: boolean;
      converted: boolean;
      inWindow: boolean;
    }[] = [];

    for (const l of leads) {
      const reachedDays = l.reached[stage];
      const converted = reachedDays !== undefined;
      /*
       * 🔴 `converted ||` first, and the order is the whole point. A lead that
       * booked yesterday is a settled observation however young it is; testing
       * age alone would discard exactly the fast-converting leads and report
       * that speed does not help. Age only decides the fate of leads that have
       * NOT converted — those are the ones whose silence might just be youth.
       */
      const ageDays = (asOfMs - new Date(l.leadAt).getTime()) / 86_400_000;
      if (!converted && ageDays < maturationDays) {
        maturing++;
        continue;
      }
      judged.push({
        bucket: bucketFor(l.secondsToCall),
        fast: l.secondsToCall !== null && l.secondsToCall <= FAST_THRESHOLD_SECONDS,
        converted,
        inWindow: window ? inCallingWindow(l, window) : false,
      });
    }

    const buckets: BucketOutcome[] = [
      ...RESPONSE_BUCKETS.map((b) => ({ id: b.id as BucketId, label: b.label })),
      { id: "never" as BucketId, label: "Never called" },
    ].map(({ id, label }) => {
      const rows = judged.filter((j) => j.bucket === id);
      return {
        id,
        label,
        inComparison: id !== "never",
        ...rateGroup(rows.length, rows.filter((r) => r.converted).length),
      };
    });

    // Never-called leads are excluded from BOTH arms — see the header note on
    // triage. They are visible as their own row and counted nowhere else.
    const called = judged.filter((j) => j.bucket !== "never");

    return {
      stage,
      label: OUTCOME_LABEL[stage],
      verb: OUTCOME_VERB[stage],
      noun: OUTCOME_NOUN[stage],
      mapped: opts.mappedStages.has(stage),
      matured: judged.length,
      maturing,
      maturationDays,
      maturationMeasured: measured,
      converted: judged.filter((j) => j.converted).length,
      buckets,
      verdict: buildVerdict(called),
      control: window ? buildVerdict(called.filter((j) => j.inWindow)) : null,
    };
  });

  /*
   * Booking is the default, and not because it has the most rows.
   *
   * Speed to lead acts on whether you reach someone while they are still in the
   * moment of enquiring — the outcome one step away from the phone call. A close
   * is many steps and several weeks further on, mostly determined by the sales
   * conversation, so attributing it to response time is a longer chain of
   * reasoning on a tenth of the sample. Deeper stages stay selectable; they are
   * just not the answer to "should we call faster".
   */
  const preferred = stages.find((s) => s.stage === "appointment_booked");
  const defaultStage =
    preferred && preferred.converted > 0
      ? preferred.stage
      : (stages.find((s) => s.converted > 0)?.stage ?? "appointment_booked");

  return {
    trackingStartedAt: opts.trackingStartedAt,
    cohort: leads.length,
    preTracking: opts.preTracking ?? 0,
    stages,
    defaultStage,
    callingWindow: window,
  };
}
