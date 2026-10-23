import type { DimensionId, MetricFormat } from "./catalog";
import type { CategoryRow } from "./types";
import { formatMetricValue } from "./format";

/**
 * Chart decisions that are rules rather than drawing — kept out of the
 * `"use client"` chart module so they can be tested and shared (a client
 * module may export only components).
 */

/** Seven categorical slots; the eighth is reserved for status and never a category. */
export const RAMP_SLOTS = 7;

/**
 * Fixed slots for categories that mean the same thing everywhere.
 *
 * "Female" is the same colour in the gender donut, the gender bars and the next
 * board's gender donut. Rank-based colouring would repaint it whenever another
 * gender had a bigger week — and a reader who learned the colour is misled.
 */
const FIXED: Partial<Record<DimensionId, Record<string, number>>> = {
  gender: { female: 1, male: 2 },
  age: {
    "18-24": 1,
    "25-34": 2,
    "35-44": 3,
    "45-54": 4,
    "55-64": 5,
    "65+": 6,
    "13-17": 7,
  },
};

/** Meta's "unknown" bucket is a gap in the data, not a group of people: neutral, like "Other". */
const UNKNOWN = "unknown";

export type SlotOrTone = number | "other" | "not_reported";

/**
 * The colour slot (1–7) for each slice of a circle, or its tone.
 *
 * Fixed categories keep their slot; everything else takes slots in the order
 * shown, which for a split ranked by volume is the biggest first. "Other" and
 * Meta's withheld remainder are not entities and never take a hue.
 *
 * Never cycled: once the free slots run out, a row goes neutral rather than
 * repeating a hue, which would give two categories one colour. A circle shows
 * at most `TOP_N.circleMax` rows, so in practice that is only an unexpected
 * value in a fixed split (an age band Meta adds next year).
 */
export function categorySlots(
  dimension: DimensionId,
  rows: readonly Pick<CategoryRow, "key" | "tone">[],
): SlotOrTone[] {
  const fixed = FIXED[dimension];
  // An unexpected value in a fixed split ("other" gender) must not borrow a
  // pinned colour, or two categories would share one.
  const reserved = new Set(fixed ? Object.values(fixed) : []);
  const free = Array.from({ length: RAMP_SLOTS }, (_, i) => i + 1).filter((s) => !reserved.has(s));
  let next = 0;
  return rows.map((r) => {
    if (r.tone === "other") return "other";
    if (r.tone === "not_reported") return "not_reported";
    if (fixed && r.key.toLowerCase() === UNKNOWN) return "other";
    const pinned = fixed?.[r.key.toLowerCase()];
    if (pinned) return pinned;
    if (next >= free.length) return "other";
    return free[next++];
  });
}

/**
 * Colour slots for bars. A bar is named by its axis label, so colour carries
 * no identity there: every bar takes the series colour, however many rows the
 * widget shows. The exception is a split whose categories have fixed colours
 * (gender, age), where the bars wear the same colours as that split's donut.
 */
export function barSlots(
  dimension: DimensionId,
  rows: readonly Pick<CategoryRow, "key" | "tone">[],
): SlotOrTone[] {
  if (FIXED[dimension]) return categorySlots(dimension, rows);
  return rows.map((r) => (r.tone === "other" || r.tone === "not_reported" ? r.tone : 1));
}

/** May these rows be drawn as parts of a whole? Never with a negative part or an empty whole. */
export function circleAllowed(rows: readonly Pick<CategoryRow, "value">[]): boolean {
  let total = 0;
  for (const r of rows) {
    if (r.value === null) continue;
    if (r.value < 0) return false;
    total += r.value;
  }
  return total > 0;
}

/** Axis ticks: compact from a thousand up, so "12K" rather than "12,000". */
export function tickLabel(format: MetricFormat, v: number, currency: string): string {
  return formatMetricValue(format, v, currency, { compact: true });
}

/** A share of the whole, for legends and tooltips: "12%" or "4.5%". */
export function shareLabel(value: number | null, total: number | null): string | null {
  if (value === null || total === null || total <= 0) return null;
  const pct = (value / total) * 100;
  return `${pct.toFixed(pct < 10 ? 1 : 0)}%`;
}
