import { TZDate } from "@date-fns/tz";

/**
 * Longest selectable window, in days.
 *
 * Shared by the dashboard's URL validation and the range picker's presets so
 * the two cannot drift. They did: the picker offered "All" as 800 days, the
 * page silently clamped it to 365, and the control still rendered "All" as the
 * active segment — so the label named a window the page was not showing.
 */
export const MAX_RANGE_DAYS = 365;
import {
  addDays,
  differenceInCalendarDays,
  format,
  startOfDay,
  startOfMonth,
  endOfMonth,
  subDays,
  subMonths,
} from "date-fns";

/**
 * Timezone-aware date helpers.
 *
 * Every window in this app — daily rows, moving averages, month boundaries — is
 * computed in the CLIENT's timezone, never the server's and never UTC. Meta
 * buckets its daily insights in the ad account's timezone, so if we bucketed in
 * UTC our "Jul 20" would silently contain part of Meta's Jul 19 and Jul 20, and
 * every daily number would be wrong by a few hours' worth of spend.
 */

/** `YYYY-MM-DD` for an instant, as seen in `tz`. */
export function toDateKey(d: Date, tz: string): string {
  return format(new TZDate(d, tz), "yyyy-MM-dd");
}

/** "Today" in the client's timezone, as a date key. */
export function todayKey(tz: string, now: Date = new Date()): string {
  return toDateKey(now, tz);
}

/** Midnight at the start of a `YYYY-MM-DD` in `tz`, as a UTC instant. */
export function dayStartUtc(dateKey: string, tz: string): Date {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(new TZDate(y, m - 1, d, 0, 0, 0, 0, tz).getTime());
}

/** Exclusive end of a `YYYY-MM-DD` in `tz` (= next midnight), as UTC. */
export function dayEndUtc(dateKey: string, tz: string): Date {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(new TZDate(y, m - 1, d + 1, 0, 0, 0, 0, tz).getTime());
}

/** `hour:00` local time on a `YYYY-MM-DD` in `tz`, as a UTC instant. */
export function localHourUtc(dateKey: string, hour: number, tz: string): Date {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(new TZDate(y, m - 1, d, hour, 0, 0, 0, tz).getTime());
}

/**
 * The most recent moment local time in `tz` struck `hour:00`, at or before `now`.
 *
 * This is what lets scheduled work be gated on "has it happened since the
 * client's local 3am" rather than "is it exactly 3am for them right now". The
 * former survives a scheduler that fires late or skips a run; the latter
 * silently drops that client for the day.
 *
 * DST: on a spring-forward day the target hour may not exist locally (US clocks
 * jump 2am → 3am). TZDate normalises forward, so a boundary still resolves —
 * but prefer an hour that always exists (3 rather than 2) so the boundary lands
 * where you expect.
 */
export function lastLocalHourBoundary(
  hour: number,
  tz: string,
  now: Date = new Date(),
): Date {
  const today = localHourUtc(toDateKey(now, tz), hour, tz);
  if (today.getTime() <= now.getTime()) return today;
  // Local time has not reached the boundary yet today, so the most recent one
  // was yesterday.
  const yesterday = format(subDays(new TZDate(now, tz), 1), "yyyy-MM-dd");
  return localHourUtc(yesterday, hour, tz);
}

export interface DateWindow {
  /** Inclusive first day, `YYYY-MM-DD` in client tz. */
  startKey: string;
  /** Inclusive last day, `YYYY-MM-DD` in client tz. */
  endKey: string;
  /** UTC instant of the window's opening boundary. */
  startUtc: Date;
  /** UTC instant of the window's closing boundary (exclusive). */
  endUtc: Date;
}

export function windowFromKeys(
  startKey: string,
  endKey: string,
  tz: string,
): DateWindow {
  return {
    startKey,
    endKey,
    startUtc: dayStartUtc(startKey, tz),
    endUtc: dayEndUtc(endKey, tz),
  };
}

/**
 * A trailing window of `days` ending yesterday (inclusive).
 *
 * Excludes today deliberately: today is partial, and including it would drag
 * every moving average down as the day progresses, making the dashboard look
 * like performance is collapsing every morning.
 */
export function trailingWindow(
  days: number,
  tz: string,
  now: Date = new Date(),
): DateWindow {
  const today = new TZDate(now, tz);
  const end = subDays(startOfDay(today), 1);
  const start = subDays(end, days - 1);
  return windowFromKeys(format(start, "yyyy-MM-dd"), format(end, "yyyy-MM-dd"), tz);
}

/** Trailing window that DOES include today — for "last 7 days" style views. */
export function trailingWindowInclusive(
  days: number,
  tz: string,
  now: Date = new Date(),
): DateWindow {
  const today = startOfDay(new TZDate(now, tz));
  const start = subDays(today, days - 1);
  return windowFromKeys(
    format(start, "yyyy-MM-dd"),
    format(today, "yyyy-MM-dd"),
    tz,
  );
}

/** The window immediately preceding `w`, of equal length. For % change. */
export function previousWindow(w: DateWindow, tz: string): DateWindow {
  const start = dayStartUtc(w.startKey, tz);
  const end = dayStartUtc(w.endKey, tz);
  const len = differenceInCalendarDays(new TZDate(end, tz), new TZDate(start, tz)) + 1;
  const prevEnd = subDays(new TZDate(start, tz), 1);
  const prevStart = subDays(prevEnd, len - 1);
  return windowFromKeys(
    format(prevStart, "yyyy-MM-dd"),
    format(prevEnd, "yyyy-MM-dd"),
    tz,
  );
}

/**
 * A date key `days` earlier or later, as a calendar date.
 *
 * Deliberately plain UTC arithmetic on the key's own parts, with no timezone
 * involved. A date key is already resolved in the client's zone upstream — it
 * is a label for a calendar day, not an instant — so shifting it is calendar
 * arithmetic. Routing it through `TZDate` would reintroduce the zone a second
 * time and land off by one across a DST boundary, which is the one place this
 * is used: extending a window backwards to give an anomaly baseline its lead-in.
 */
export function shiftDateKey(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** Every date key in a window, ascending. */
export function eachDateKey(w: DateWindow, tz: string): string[] {
  const out: string[] = [];
  let cur = new TZDate(dayStartUtc(w.startKey, tz), tz);
  const last = new TZDate(dayStartUtc(w.endKey, tz), tz);
  let guard = 0;
  while (cur.getTime() <= last.getTime() && guard++ < 4000) {
    out.push(format(cur, "yyyy-MM-dd"));
    cur = addDays(cur, 1) as TZDate;
  }
  return out;
}

/** The last `count` calendar months, most recent first. */
export function trailingMonths(
  count: number,
  tz: string,
  now: Date = new Date(),
): Array<DateWindow & { label: string; monthKey: string }> {
  const today = new TZDate(now, tz);
  const out: Array<DateWindow & { label: string; monthKey: string }> = [];
  for (let i = 0; i < count; i++) {
    const anchor = subMonths(today, i);
    const first = startOfMonth(anchor);
    const last = endOfMonth(anchor);
    const startKey = format(first, "yyyy-MM-dd");
    const endKey = format(last, "yyyy-MM-dd");
    out.push({
      ...windowFromKeys(startKey, endKey, tz),
      label: format(first, "MMM yyyy"),
      monthKey: format(first, "yyyy-MM"),
    });
  }
  return out;
}

/**
 * The shape of one calendar month in the client's timezone: its window, its
 * length, and how far into it "now" is.
 *
 * `dayOfMonth` is what budget pacing divides by, and it is deliberately
 * expressed so that a CLOSED month reads as `daysInMonth + 1` — one past the
 * last day, meaning every day is complete. Without that, the last day of a
 * finished month would be treated as still running and its spend excluded from
 * the run rate forever.
 *
 * A month in the FUTURE reads as day 1 — nothing has happened yet, which is the
 * honest answer and keeps every downstream divisor at zero rather than negative.
 */
export function monthShape(
  monthKey: string,
  tz: string,
  now: Date = new Date(),
): DateWindow & { monthKey: string; daysInMonth: number; dayOfMonth: number } {
  const [y, m] = monthKey.split("-").map(Number);
  /*
   * Anchored at NOON rather than midnight.
   *
   * Local midnight on the 1st does not always exist: America/Asuncion skipped
   * it on 2017-10-01 and 2023-10-01, and Asia/Amman on 2016-04-01, when those
   * zones moved their clocks forward at 00:00. TZDate normalises such a time
   * forward to 01:00 on the same date, so a midnight anchor happens to resolve
   * to the right month anyway — but that correctness is borrowed from a
   * normalisation rule rather than stated here. Noon exists in every zone on
   * every day, so it needs no rule.
   */
  const anchor = new TZDate(y, m - 1, 1, 12, 0, 0, tz);
  const first = startOfMonth(anchor);
  const last = endOfMonth(anchor);
  const startKey = format(first, "yyyy-MM-dd");
  const endKey = format(last, "yyyy-MM-dd");
  const daysInMonth = differenceInCalendarDays(last, first) + 1;

  const todayIso = todayKey(tz, now);
  const dayOfMonth =
    todayIso > endKey
      ? daysInMonth + 1 // closed: every day complete
      : todayIso < startKey
        ? 1 // not started
        : Number(todayIso.slice(8, 10));

  return {
    ...windowFromKeys(startKey, endKey, tz),
    monthKey,
    daysInMonth,
    dayOfMonth,
  };
}

/**
 * The hour of the day, 0–23, as it is right now in `tz`.
 *
 * For deciding whether a message should go out at all. A pacing alert is a
 * slow-moving fact about a whole month — landing it at 3am local buys nothing
 * and trains the recipient to mute the channel it shares with the lead alerts,
 * which are the ones with a five-minute half-life.
 */
export function localHour(tz: string, now: Date = new Date()): number {
  return Number(format(new TZDate(now, tz), "H"));
}

/** `yyyy-MM` for "now" in the client's timezone. */
export function currentMonthKey(tz: string, now: Date = new Date()): string {
  return todayKey(tz, now).slice(0, 7);
}

const MONTH_ABBR = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/**
 * Short label for a daily row, e.g. "Jul 20" — matching the sheet.
 *
 * Built from the date-key parts directly rather than via `format(new Date(...))`,
 * which reads the runtime's local timezone and would render the day off-by-one on
 * any non-UTC host (e.g. a dev laptop in America/New_York shows "Jul 19" for
 * "2026-07-20"). This label is already tz-resolved upstream; keep it literal.
 */
export function dayLabel(dateKey: string): string {
  const [, m, d] = dateKey.split("-").map(Number);
  const month = MONTH_ABBR[m - 1] ?? "";
  return `${month} ${d}`;
}

/**
 * A whole period as one label — "1–31 Jul 2026", "28 Jun – 4 Jul 2026".
 *
 * Both keys are already resolved in the client's timezone upstream, so this
 * reads them literally rather than constructing Dates: passing "2026-07-01"
 * through `new Date()` would reinterpret it as UTC midnight and render the
 * previous day for anyone west of Greenwich — the exact off-by-one that makes a
 * report disagree with the dashboard it was generated from.
 */
export function rangeLabel(startKey: string, endKey: string): string {
  const [sy, sm, sd] = startKey.split("-").map(Number);
  const [ey, em, ed] = endKey.split("-").map(Number);
  const sMon = MONTH_ABBR[sm - 1] ?? "";
  const eMon = MONTH_ABBR[em - 1] ?? "";

  if (startKey === endKey) return `${sd} ${sMon} ${sy}`;
  if (sy === ey && sm === em) return `${sd}–${ed} ${eMon} ${ey}`;
  if (sy === ey) return `${sd} ${sMon} – ${ed} ${eMon} ${ey}`;
  return `${sd} ${sMon} ${sy} – ${ed} ${eMon} ${ey}`;
}

/** True only for an IANA zone Intl actually accepts — rejects "" and garbage. */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.trim() === "") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** True only for a real `YYYY-MM-DD` calendar date — used to reject junk URL params. */
export function isValidDateKey(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  // Reject non-existent dates like 2026-02-30 (which JS would roll forward).
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

/**
 * Meta keeps restating spend and conversions for up to 28 days as attribution
 * windows fill. Anything inside that horizon is provisional, not final.
 */
export const META_PROVISIONAL_DAYS = 28;

export function isProvisional(dateKey: string, tz: string, now = new Date()) {
  const age = differenceInCalendarDays(
    new TZDate(now, tz),
    new TZDate(dayStartUtc(dateKey, tz), tz),
  );
  return age < META_PROVISIONAL_DAYS;
}
