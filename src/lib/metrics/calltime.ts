import { probBetaGreater, betaQuantile } from "./stats";

/**
 * When is the best time to call?
 *
 * ── 🔴 Why this is NOT "leads first contacted at hour X close at Y%" ────
 *
 * That was the shape this was asked for, and it produces a confident, wrong
 * answer for a reason worth writing down.
 *
 * The hour a lead is first called is mostly decided by the hour it ARRIVED. A
 * lead in at 9:02 and called at 9:05 lands in the 9am bucket with a good outcome
 * — earned by the three-minute response, not by nine o'clock. A lead in at 9:02
 * and called at 4pm lands in the 4pm bucket with a bad outcome, earned by the
 * seven-hour delay. Plot close rate against call hour and you have re-drawn
 * §6.7's speed-to-lead chart with the axis relabelled, then told the client to
 * staff the phones at whatever hour their ads happen to deliver.
 *
 * Worse, the effect is unfixable by controlling for lag: among fast responders,
 * call hour and arrival hour are the SAME variable, so there is no calling
 * effect to identify there at all. Among slow responders the population is
 * selected on the outcome — those are the leads somebody chose to leave.
 *
 * ── What is actually identified ────────────────────────────────────────
 *
 * **Whether a call at this hour reaches a human.** Every outbound call event
 * carries `callDuration`, so a call attempt is its own observation with its own
 * outcome, and whether a person picks up at 5pm is a fact about that person's
 * day rather than about the quality of the lead. No lead-quality confound, and
 * the unit is the attempt, so the data is several times denser than one row per
 * lead.
 *
 * Close rate by call hour is deliberately absent. The reason is on the panel,
 * not just here — a missing chart with no explanation is indistinguishable from
 * an oversight.
 *
 * ── The finding this usually produces ──────────────────────────────────
 *
 * Not "call at 10am". Almost always: **"you cannot know yet."** Measured against
 * the live account, 80% of all call attempts fall in two hours of the day, and
 * ten of twenty-four hours have never had a single call. You cannot compare
 * hours you have never called in, and a bar chart implying 6am is excellent on a
 * sample of five is exactly the false precision this product exists to remove.
 *
 * So the headline is a statement about EVIDENCE — how much of the day has been
 * tried — and the hour-by-hour figures sit underneath as counts, with a rate
 * only where enough attempts back it.
 */

/**
 * How long a call must last to count as having reached someone.
 *
 * `callStatus` cannot answer this: on the live account 122 of 123 calls read
 * `completed`, which means the attempt finished, not that anybody spoke. The
 * duration histogram is where the signal is — a spike of 34 calls at 5–9
 * seconds (ring, then voicemail detected) and a long tail beyond it.
 *
 * 30 seconds sits above a voicemail greeting and below any conversation worth
 * having. It is a judgement, so the panel names it rather than presenting
 * "connected" as though it were reported by the phone system.
 */
export const CONNECTED_SECONDS = 30;

/**
 * Attempts before an hour's rate is quoted as a rate.
 *
 * Below this the counts still render — "3 of 5" is honest and useful, and
 * hiding it entirely makes the tool look like it knows less than it does. What
 * is withheld is the PERCENTAGE, because 60% off five attempts reads as a
 * finding and is a coin flip.
 */
export const MIN_ATTEMPTS_TO_RATE = 12;

/** Attempts before an hour may be compared against the rest of the day. */
export const MIN_ATTEMPTS_TO_COMPARE = 20;

/** Posterior probability required to say an hour genuinely differs. */
export const CONFIDENT = 0.9;

/**
 * The window inside which "you have never tried this hour" is worth raising.
 *
 * Leads arrive at 2am; nobody should call them at 2am, and a panel suggesting it
 * would be ignored along with everything next to it. Local hours, half-open.
 */
export const DAYTIME_START = 8;
export const DAYTIME_END = 19;

/** Arrivals in an hour before its lack of call attempts is worth mentioning. */
const MIN_GAP_ARRIVALS = 3;
/** An hour is under-tried when its attempts fall below this share of its due. */
const GAP_RATIO = 0.25;
/** How many under-tried hours to name. More than this is a list, not a point. */
const MAX_GAPS = 4;

export interface HourInput {
  /** 0–23, in the client's timezone. */
  hour: number;
  attempts: number;
  connected: number;
  /** Leads that arrived in this hour, over the same window. */
  arrivals: number;
}

export interface HourRow {
  hour: number;
  attempts: number;
  connected: number;
  /** Null when nothing was tried, or when too little was to quote a rate. */
  rate: number | null;
  /** The raw share, always available when anything was tried. Read with care. */
  rawRate: number | null;
  lo: number | null;
  hi: number | null;
  arrivals: number;
  arrivalShare: number;
  attemptShare: number;
}

export type CallTimingVerdict =
  /** Nothing has been recorded yet — the call log accumulates forward. */
  | "no_calls"
  /** Calling is too concentrated for any hour to be compared with another. */
  | "too_concentrated"
  | "no_hour_stands_out"
  | "hour_stands_out";

export interface UntriedHour {
  hour: number;
  arrivals: number;
  attempts: number;
}

export interface CallTimingReport {
  hours: HourRow[];
  totals: {
    attempts: number;
    connected: number;
    rate: number | null;
    arrivals: number;
  };
  verdict: CallTimingVerdict;
  /** Present only on `hour_stands_out`. */
  best: {
    hour: number;
    rate: number;
    /** The rest of the day, for contrast. */
    restRate: number;
    probability: number;
  } | null;
  /** How many hours carry enough attempts to be compared at all. */
  comparableHours: number;
  /**
   * The smallest number of hours holding most of the calling, and their share.
   * Null when nothing has been called.
   */
  concentration: { hours: number; share: number } | null;
  /** Daytime hours with real arrivals and almost no attempts. */
  untried: UntriedHour[];
  connectedSeconds: number;
}

const EMPTY_TOTALS = { attempts: 0, connected: 0, rate: null, arrivals: 0 };

/** Guarded share. Zero attempts is not a zero rate. */
function share(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

/**
 * How concentrated the calling is: the fewest hours holding ≥ 70% of attempts.
 *
 * Stated as "80% of calls in 2 hours" rather than as an entropy or a Gini,
 * because the sentence has to survive being read aloud on a call.
 */
function concentrationOf(
  hours: readonly HourRow[],
  totalAttempts: number,
): { hours: number; share: number } | null {
  if (totalAttempts <= 0) return null;
  const sorted = [...hours].sort((a, b) => b.attempts - a.attempts);
  let running = 0;
  for (let i = 0; i < sorted.length; i++) {
    running += sorted[i].attempts;
    if (running / totalAttempts >= 0.7) {
      return { hours: i + 1, share: running / totalAttempts };
    }
  }
  return { hours: sorted.length, share: 1 };
}

/**
 * Build the report.
 *
 * `input` need not cover all 24 hours; missing hours are filled with zeroes so
 * the panel can show a whole day and an hour nobody has ever called reads as
 * untried rather than as absent.
 */
export function buildCallTiming(input: readonly HourInput[]): CallTimingReport {
  const byHour = new Map<number, HourInput>();
  for (const h of input) {
    if (!Number.isInteger(h.hour) || h.hour < 0 || h.hour > 23) continue;
    const prev = byHour.get(h.hour);
    byHour.set(h.hour, {
      hour: h.hour,
      attempts: (prev?.attempts ?? 0) + Math.max(0, h.attempts),
      connected: (prev?.connected ?? 0) + Math.max(0, h.connected),
      arrivals: (prev?.arrivals ?? 0) + Math.max(0, h.arrivals),
    });
  }

  const totalAttempts = [...byHour.values()].reduce((a, h) => a + h.attempts, 0);
  const totalConnected = [...byHour.values()].reduce((a, h) => a + h.connected, 0);
  const totalArrivals = [...byHour.values()].reduce((a, h) => a + h.arrivals, 0);

  const hours: HourRow[] = Array.from({ length: 24 }, (_, hour) => {
    const h = byHour.get(hour);
    const attempts = h?.attempts ?? 0;
    /*
     * Clamped: a connected count above the attempt count would come from a
     * query bug and would produce a rate above 1 that reads as a real figure.
     */
    const connected = Math.min(h?.connected ?? 0, attempts);
    const rawRate = share(connected, attempts);
    return {
      hour,
      attempts,
      connected,
      rawRate,
      rate: attempts >= MIN_ATTEMPTS_TO_RATE ? rawRate : null,
      lo: attempts > 0 ? betaQuantile(connected + 1, attempts - connected + 1, 0.05) : null,
      hi: attempts > 0 ? betaQuantile(connected + 1, attempts - connected + 1, 0.95) : null,
      arrivals: h?.arrivals ?? 0,
      arrivalShare: share(h?.arrivals ?? 0, totalArrivals) ?? 0,
      attemptShare: share(attempts, totalAttempts) ?? 0,
    };
  });

  if (totalAttempts === 0) {
    return {
      hours,
      totals: { ...EMPTY_TOTALS, arrivals: totalArrivals },
      verdict: "no_calls",
      best: null,
      comparableHours: 0,
      concentration: null,
      untried: [],
      connectedSeconds: CONNECTED_SECONDS,
    };
  }

  const comparable = hours.filter((h) => h.attempts >= MIN_ATTEMPTS_TO_COMPARE);

  /*
   * 🔴 Two comparable hours is the floor, and it is the gate that usually
   * fires. One hour cannot be "the best hour" — there is nothing to be better
   * than, and quoting its rate as a recommendation would turn "this is when we
   * happen to call" into "this is when to call".
   */
  let verdict: CallTimingVerdict =
    comparable.length < 2 ? "too_concentrated" : "no_hour_stands_out";
  let best: CallTimingReport["best"] = null;

  if (verdict === "no_hour_stands_out") {
    for (const h of comparable) {
      const restAttempts = totalAttempts - h.attempts;
      const restConnected = totalConnected - h.connected;
      /*
       * No floor on `restAttempts`. One was written and then removed once it
       * turned out to be unreachable: this branch runs only when at least two
       * hours clear MIN_ATTEMPTS_TO_COMPARE, so whichever hour is being judged,
       * the OTHER one is already in the remainder and the remainder therefore
       * clears the floor by construction. The invariant is asserted in the
       * tests so a change to the gate above cannot quietly make it false.
       */
      /*
       * Each hour against the REST of the day rather than against the overall
       * rate, which contains the hour itself — an hour holding most of the
       * calling would otherwise be compared with a near-copy of itself and
       * could never differ from it.
       */
      const p = probBetaGreater(
        h.connected + 1,
        h.attempts - h.connected + 1,
        restConnected + 1,
        restAttempts - restConnected + 1,
      );
      if (!Number.isFinite(p) || p < CONFIDENT) continue;
      if (best && p <= best.probability) continue;
      best = {
        hour: h.hour,
        rate: h.rawRate ?? 0,
        restRate: share(restConnected, restAttempts) ?? 0,
        probability: p,
      };
    }
    if (best) verdict = "hour_stands_out";
  }

  /*
   * Hours worth trying, not hours the team failed to cover. A lead arriving at
   * 10pm should be called the next morning; what this names is the daytime
   * hours carrying real arrival volume where nobody has ever picked up the
   * phone — which is the reason the question above cannot be answered.
   */
  const untried = hours
    .filter(
      (h) =>
        h.hour >= DAYTIME_START &&
        h.hour < DAYTIME_END &&
        h.arrivals >= MIN_GAP_ARRIVALS &&
        h.attempts < totalAttempts * h.arrivalShare * GAP_RATIO,
    )
    .sort((a, b) => b.arrivals - a.arrivals || a.hour - b.hour)
    .slice(0, MAX_GAPS)
    .map((h) => ({ hour: h.hour, arrivals: h.arrivals, attempts: h.attempts }));

  return {
    hours,
    totals: {
      attempts: totalAttempts,
      connected: totalConnected,
      rate: share(totalConnected, totalAttempts),
      arrivals: totalArrivals,
    },
    verdict,
    best,
    comparableHours: comparable.length,
    concentration: concentrationOf(hours, totalAttempts),
    untried,
    connectedSeconds: CONNECTED_SECONDS,
  };
}

/** "9am", "12pm", "5pm" — read aloud on a call, so not 24-hour time. */
export function hourLabel(hour: number): string {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return "–";
  if (hour === 0) return "12am";
  if (hour === 12) return "12pm";
  return hour < 12 ? `${hour}am` : `${hour - 12}pm`;
}

/** "8–9am" — an hour is a span, and a single label reads as an instant. */
export function hourRangeLabel(hour: number): string {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return "–";
  return `${hourLabel(hour)}–${hourLabel((hour + 1) % 24)}`;
}
