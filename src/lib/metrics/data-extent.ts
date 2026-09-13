/**
 * "This range is empty, but the account's data lives over there."
 *
 * A dormant ad account — one that spent last year and has been paused since —
 * renders identically to a broken connection: every tile dashes out and the
 * screen offers no way to tell the difference. The date picker cannot help,
 * because its presets stop at a year and discovering a gap 26 months wide by
 * paging a calendar one month at a time is not something anyone does.
 *
 * So the dashboard has to say it. This decides when there is something to say.
 */

/** Inclusive `YYYY-MM-DD` bounds of every ad row we hold for a client. */
export interface AdDataExtent {
  firstKey: string;
  lastKey: string;
}

export interface OutOfRangeNotice {
  firstKey: string;
  lastKey: string;
  /** Whether the data sits entirely before the selected range, or after it. */
  direction: "before" | "after";
}

/**
 * Null means "say nothing" — and the two reasons for that are different.
 *
 * No extent at all is a client that has never had a row, which is the ad pipe's
 * story to tell (not connected, backfilling, unreachable), not ours. An extent
 * that overlaps the window means the range genuinely contains days we hold, so
 * an empty result is a real "no spend in this period — ads paused". Pointing
 * elsewhere in either case would be noise at best and a wrong diagnosis at
 * worst.
 *
 * Keys are compared as strings on purpose: `YYYY-MM-DD` sorts lexicographically
 * in date order, both sides are already bucketed in the client's own timezone,
 * and parsing them back into Date would reintroduce the double-conversion this
 * codebase keeps out of the date path.
 */
export function outOfRangeNotice(
  window: { startKey: string; endKey: string },
  extent: AdDataExtent | null,
): OutOfRangeNotice | null {
  if (!extent) return null;
  const overlaps =
    extent.firstKey <= window.endKey && extent.lastKey >= window.startKey;
  if (overlaps) return null;
  return {
    firstKey: extent.firstKey,
    lastKey: extent.lastKey,
    direction: extent.lastKey < window.startKey ? "before" : "after",
  };
}
