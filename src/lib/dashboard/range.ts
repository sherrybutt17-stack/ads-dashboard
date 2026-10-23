import {
  MAX_RANGE_DAYS,
  eachDateKey,
  isValidDateKey,
  shiftDateKey,
  trailingWindow,
  windowFromKeys,
  type DateWindow,
} from "@/lib/dates";

export interface RangeParams {
  days?: string | string[];
  start?: string | string[];
  end?: string | string[];
  /** The picker's preset id ("30d"), which it reads back to light its button. */
  range?: string | string[];
}

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * The date range a page shows, from its URL — the same rules as the Overview.
 *
 * The range comes straight from the address bar (the picker sells links as
 * shareable), so junk like `?start=foo` or `?days=1e11` must fall back to the
 * default rather than reach the date maths. Presets end YESTERDAY: today is
 * partial, and a part-day against a previous period of full days showed a fake
 * drop every morning.
 *
 * `clampExplicit` additionally caps a hand-typed start/end to `MAX_RANGE_DAYS`,
 * keeping its end date: the board runs one query per widget, and a ten-year
 * range typed into the URL would fan that out across a decade of rows.
 */
export function parseRangeParams(
  sp: RangeParams,
  tz: string,
  opts: { clampExplicit?: boolean; defaultDays?: number } = {},
): DateWindow {
  const fallback = opts.defaultDays ?? 30;
  const raw = one(sp.days);
  const days = raw ? Number(raw) : fallback;
  const safeDays =
    Number.isFinite(days) && days > 0 ? Math.min(Math.floor(days), MAX_RANGE_DAYS) : fallback;

  const start = one(sp.start);
  const end = one(sp.end);
  if (isValidDateKey(start) && isValidDateKey(end) && start <= end) {
    let startKey = start;
    if (opts.clampExplicit) {
      const earliest = shiftDateKey(end, -(MAX_RANGE_DAYS - 1));
      if (startKey < earliest) startKey = earliest;
    }
    return windowFromKeys(startKey, end, tz);
  }
  return trailingWindow(safeDays, tz);
}

/** What a change is measured against, named the way the Overview tiles name it. */
export function comparisonBasis(window: DateWindow, tz: string): string {
  const days = eachDateKey(window, tz).length;
  return days === 1 ? "previous day" : `previous ${days} days`;
}

/** The query string that carries a range onto another page. */
export function rangeQuery(window: DateWindow): string {
  return `start=${window.startKey}&end=${window.endKey}`;
}

/**
 * The range as the picker wrote it, for moving between the board, its editor
 * and the Overview: a preset stays a preset. `rangeQuery` turns "Last 30
 * days" into two dates, and the picker then lights "Custom" for a range the
 * reader never customised.
 *
 * Only well-formed values pass; anything else is dropped and the next page
 * falls back to its default, exactly as `parseRangeParams` would.
 */
export function carriedRange(sp: RangeParams): string {
  const start = one(sp.start);
  const end = one(sp.end);
  if (isValidDateKey(start) && isValidDateKey(end) && start <= end) {
    return `start=${start}&end=${end}`;
  }
  const out = new URLSearchParams();
  const range = one(sp.range);
  const days = one(sp.days);
  if (range && /^[a-z0-9]{1,8}$/i.test(range)) out.set("range", range);
  if (days && /^\d{1,4}$/.test(days)) out.set("days", days);
  return out.toString();
}

/** `path`, with a carried range when there is one. */
export function withRange(path: string, carried: string): string {
  return carried ? `${path}?${carried}` : path;
}
