import { TZDate } from "@date-fns/tz";
import { endOfMonth, format, startOfMonth, subDays, subMonths } from "date-fns";
import { shiftDateKey } from "@/lib/dates";
import { monthBounds, previousMonthKey } from "@/lib/commentary/model";

/**
 * Which report period, if any, is due to be emailed.
 *
 * Pure. No database, no clock of its own — `now` is always passed in, so every
 * boundary case below is a test rather than a thing you wait a month to observe.
 *
 * ── 🔴 Only COMPLETE periods are ever sent ────────────────────────────
 *
 * A weekly report emailed on Wednesday covering "this week so far" is a report
 * of three days wearing a week's label, and next week's will silently disagree
 * with it. So the period is always the last one that has fully ENDED in the
 * client's timezone. On Monday morning that is last week; on the 1st it is last
 * month.
 *
 * ── 🔴 A missed run sends ONE report, not a backlog ───────────────────
 *
 * If the cron is down for three weeks, the obvious behaviour — send every period
 * that was missed — puts three emails in a client's inbox at once, two of them
 * describing periods nobody can act on any more. The recent one is the only one
 * with any value, and the two stale ones actively devalue it.
 *
 * So a missed run sends the most recent complete period and reports the rest as
 * SKIPPED, by name, so the gap is visible rather than silently papered over.
 * That is the same rule the Meta sync follows for its trailing re-pull, and the
 * same reason: a catch-up that pretends nothing was missed is worse than a gap
 * you can see.
 */

export type Cadence = "weekly" | "monthly";

export interface Period {
  startKey: string;
  endKey: string;
  /** Stable identity for deduplication — the end key IS the period's name. */
  key: string;
  label: string;
}

export type DueVerdict =
  | { due: false; reason: "disabled" | "too_early" | "already_sent" }
  | { due: true; period: Period; skipped: Period[] };

const key = (d: Date) => format(d, "yyyy-MM-dd");

/**
 * The last complete period before `now`, in the client's timezone.
 *
 * Weeks run Monday–Sunday. Not a preference: a business reads "last week" as
 * the working week just finished, and a Sunday–Saturday week splits every
 * weekend across two reports, which makes weekend-versus-weekday comparisons —
 * which §6.18 shows are real — impossible to read.
 */
export function lastCompletePeriod(
  cadence: Cadence,
  tz: string,
  now: Date,
): Period {
  const local = new TZDate(now, tz);

  if (cadence === "monthly") {
    const anchor = subMonths(local, 1);
    const start = startOfMonth(anchor);
    const end = endOfMonth(anchor);
    return {
      startKey: key(start),
      endKey: key(end),
      key: key(end),
      label: format(start, "MMMM yyyy"),
    };
  }

  /*
   * Back up to the most recent Sunday that has already passed, then take the
   * seven days ending there. Computed from the ISO weekday rather than
   * `startOfWeek`, whose first day is locale-dependent — on a machine set to
   * en-US it is Sunday, and the report would silently shift by a day depending
   * on where the server happened to be provisioned.
   */
  const isoDow = ((local.getDay() + 6) % 7) + 1; // 1 = Monday … 7 = Sunday
  const lastSunday = subDays(local, isoDow);
  const start = subDays(lastSunday, 6);
  return {
    startKey: key(start),
    endKey: key(lastSunday),
    key: key(lastSunday),
    label: `${format(start, "d MMM")} – ${format(lastSunday, "d MMM yyyy")}`,
  };
}

/**
 * The period immediately before this one.
 *
 * 🔴 Pure string arithmetic on date keys, with no `Date` anywhere.
 *
 * The first version walked backwards by converting each period's start key to a
 * UTC instant and subtracting a day, then re-deriving the period from it. In any
 * negative-offset timezone that instant reads as the PREVIOUS local day, so the
 * walk jumped two weeks at a time and a three-week gap named the wrong periods
 * as missed. A date key already denotes a calendar date; taking it back through
 * a timezone can only lose information.
 */
export function previousPeriod(cadence: Cadence, period: Period): Period {
  if (cadence === "monthly") {
    const prevKey = previousMonthKey(period.startKey.slice(0, 7));
    const { startKey, endKey } = monthBounds(prevKey);
    const [y, m] = prevKey.split("-").map(Number);
    return {
      startKey,
      endKey,
      key: endKey,
      label: format(new Date(Date.UTC(y, m - 1, 1)), "MMMM yyyy"),
    };
  }
  const endKey = shiftDateKey(period.startKey, -1);
  const startKey = shiftDateKey(endKey, -6);
  return {
    startKey,
    endKey,
    key: endKey,
    label: `${format(new Date(`${startKey}T12:00:00Z`), "d MMM")} – ${format(
      new Date(`${endKey}T12:00:00Z`),
      "d MMM yyyy",
    )}`,
  };
}

/**
 * Every complete period between the one last sent and the current one.
 *
 * 🔴 Returns EMPTY when nothing was ever sent. A client onboarded last week has
 * not "missed" fifty-one reports, and saying so would turn every first send into
 * an apology for an outage that never happened.
 *
 * Bounded at 12 otherwise — a schedule that has not run for a year is a
 * configuration that was abandoned, and walking further back builds a list
 * nobody is going to be sent.
 */
export function periodsSince(
  cadence: Cadence,
  tz: string,
  now: Date,
  lastSentKey: string | null,
): Period[] {
  if (!lastSentKey) return [];

  const out: Period[] = [];
  let p = lastCompletePeriod(cadence, tz, now);
  for (let i = 0; i < 12 && p.key > lastSentKey; i++) {
    out.push(p);
    p = previousPeriod(cadence, p);
  }
  return out.reverse();
}

/**
 * Is a send due right now?
 *
 * `sendHour` is the client's LOCAL hour, so a report lands at breakfast wherever
 * the client is rather than whenever the cron's UTC hour happens to fall. The
 * comparison is `>=` rather than `===` because a cron that fires hourly can
 * miss a specific hour — a run at 08:59 and the next at 10:01 would never see 9
 * — and missing a whole week's report to a scheduling coincidence is a much
 * worse failure than sending it an hour late.
 */
export function isDue(
  opts: {
    enabled: boolean;
    cadence: Cadence;
    timezone: string;
    /** Local hour, 0–23, at which the report should go out. */
    sendHour: number;
    /** `period.key` of the last successful send, or null. */
    lastSentKey: string | null;
  },
  now: Date,
): DueVerdict {
  if (!opts.enabled) return { due: false, reason: "disabled" };

  const period = lastCompletePeriod(opts.cadence, opts.timezone, now);

  if (opts.lastSentKey && period.key <= opts.lastSentKey) {
    return { due: false, reason: "already_sent" };
  }

  const localHour = new TZDate(now, opts.timezone).getHours();
  if (localHour < opts.sendHour) return { due: false, reason: "too_early" };

  /*
   * Everything between the last send and this one, minus the one being sent.
   * Named rather than dropped so the operator can see that three weeks went by
   * without a report — a silent catch-up would hide exactly the outage this
   * product exists to make visible.
   */
  const skipped = periodsSince(
    opts.cadence,
    opts.timezone,
    now,
    opts.lastSentKey,
  ).filter((p) => p.key !== period.key);

  return { due: true, period, skipped };
}
