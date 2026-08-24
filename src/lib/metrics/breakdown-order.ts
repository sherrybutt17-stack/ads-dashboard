import type { BreakdownKey } from "@/db/schema";

/**
 * 🔴 Row order within an audience breakdown — a correctness question, not a
 * presentation one.
 *
 * `age` is ORDINAL. 25-34 sits between 18-24 and 35-44 no matter what it spent.
 * Ranking age brackets by spend — which this did for every breakdown — destroys
 * the only thing an age panel is for: the shape of the distribution. Nobody can
 * see "the budget skews a decade older than the clientele" in a list sorted by
 * value, because the axis that would show it has been reordered away. Every
 * number on screen stays correct; only the shape lies, which is why it survived.
 *
 * `gender` is a small closed set, so it also takes a fixed order. A two-row
 * panel gains nothing from ranking, and rows that swap places between periods
 * cannot be compared against last month at a glance.
 *
 * `region`, `placement` and `device` are open-ended and genuinely unordered, so
 * ranking by spend IS the information — the largest line of waste belongs at the
 * top, and region alone can run to dozens of rows.
 *
 * Pure and DB-free on purpose: `queries.ts` imports `@/db`, so anything defined
 * there can only be tested against a live database.
 */

/** The minimum a row needs to be ordered. Structural, so callers keep their own type. */
export interface OrderableSegment {
  value: string;
  spend: number;
}

const GENDER_ORDER: readonly string[] = ["female", "male"];

/**
 * The lower bound of a Meta age bracket: `"25-34"` → 25, `"65+"` → 65.
 *
 * Parsed rather than matched against a hardcoded bracket list, so a bracket Meta
 * introduces later still sorts into its correct position instead of being
 * silently swept to the end of the panel — which would misreport the
 * distribution rather than fail visibly.
 */
export function ageLowerBound(value: string): number {
  const digits = value.match(/\d+/);
  return digits ? Number(digits[0]) : Number.POSITIVE_INFINITY;
}

export function orderSegments<T extends OrderableSegment>(
  key: BreakdownKey,
  segments: readonly T[],
): T[] {
  /*
   * "unknown" sorts last in every breakdown. It is not a segment, it is the
   * absence of one — Meta could not classify those impressions — and letting it
   * rank on spend puts a non-answer at the top of the panel, which is exactly
   * where a reader looks first.
   */
  const isUnknown = (s: T) => s.value.trim().toLowerCase() === "unknown";
  const known = segments.filter((s) => !isUnknown(s));
  const unknown = segments.filter(isUnknown);

  if (key === "age") {
    known.sort((a, b) => ageLowerBound(a.value) - ageLowerBound(b.value));
  } else if (key === "gender") {
    const rank = (s: T) => {
      const i = GENDER_ORDER.indexOf(s.value.trim().toLowerCase());
      // A value Meta adds later keeps a stable place after the known ones
      // rather than jumping around by spend between periods.
      return i === -1 ? GENDER_ORDER.length : i;
    };
    known.sort((a, b) => rank(a) - rank(b) || a.value.localeCompare(b.value));
  } else {
    known.sort((a, b) => b.spend - a.spend);
  }

  return [...known, ...unknown];
}
