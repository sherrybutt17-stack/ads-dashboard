import { TZDate } from "@date-fns/tz";
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

/** Short label for a daily row, e.g. "Jul 20" — matching the sheet. */
export function dayLabel(dateKey: string): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  return format(new Date(Date.UTC(y, m - 1, d)), "MMM d");
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
