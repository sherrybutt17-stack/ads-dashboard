/**
 * Is this segment expensive, or does it just look expensive?
 *
 * The breakdown panels print a CP-Lead per segment and leave the reader to
 * compare a column of numbers by eye. That is the wrong job to hand a person:
 * the rows they are comparing have wildly different denominators, so the row
 * with the worst-looking CP-Lead is very often the row with two leads in it.
 *
 * ── Why the yardstick is the PANEL average, not the account average ──────
 *
 * The plan called for "CP-Lead against the account average", and the account
 * average is the wrong number here for the reason this whole section is built
 * around: **segments do not sum to the account.** Meta withholds any segment
 * below its privacy threshold, and how much it withholds varies per breakdown —
 * a gender panel can reconcile exactly while the age panel is 14% short. Judging
 * both against one account-wide figure would benchmark the same segment against
 * two different yardsticks depending on which panel it appeared in, and would
 * allow a panel where EVERY visible row reads "better than average" — a table
 * that flags nothing, or flags everything, depending on what happened in the
 * spend nobody can see.
 *
 * The panel's own weighted average is the mean of exactly the rows on screen. A
 * row above it is genuinely above its visible peers, which is the comparison the
 * reader was making by eye anyway — just done correctly.
 *
 * ── Why there is a noise gate ────────────────────────────────────────────
 *
 * This book's clients run tens of leads a month, and a region panel can split
 * that across dozens of rows. At those counts CP-Lead is mostly sampling noise:
 * for a segment holding `n` leads the cost per lead carries a relative error of
 * roughly `1/√n` — 100% at one lead, 45% at five, 32% at ten. A flat "flag
 * anything 20% off the average" would therefore paint half the panel red on
 * pure chance, and a chip that fires on noise is worse than no chip, because it
 * spends the reader's attention on a decision that isn't there.
 *
 * So a segment must beat its own noise floor before it says anything. The
 * consequence is deliberate and worth stating: **small segments usually stay
 * silent.** That is the honest outcome — there is not enough evidence in four
 * leads to call a bracket wasteful.
 *
 * Pure and DB-free on purpose, exactly like `breakdown-order.ts`: `queries.ts`
 * imports `@/db`, so anything defined there can only be tested against a live
 * database.
 */

/**
 * The smallest gap worth a reader's attention, once noise is cleared.
 *
 * A segment 6% off the panel average is not a decision even when the counts are
 * large enough to trust it, and flagging it trains people to ignore the column.
 */
export const MIN_NOTABLE_GAP = 0.2;

/**
 * How many leads the panel average predicts before a segment producing NONE
 * counts as evidence rather than as a short run.
 *
 * Lead arrivals behave like a Poisson count, so the chance of seeing zero when
 * three were expected is `e⁻³` ≈ 5% — the conventional threshold for "this
 * probably isn't luck". Below that, a zero-lead segment is unremarkable and
 * says so by staying quiet.
 */
export const SURPRISING_ZERO_EXPECTED = 3;

export type SegmentBenchmark =
  /** Costs more per lead than the panel. `gap` is signed: `+0.4` = 40% dearer. */
  | { verdict: "costlier"; gap: number }
  /** Costs less per lead than the panel. `gap` is signed: `-0.3` = 30% cheaper. */
  | { verdict: "cheaper"; gap: number }
  /**
   * Real spend, no leads at all, and enough spend that this is a finding.
   *
   * The row that most deserves the reader's attention is the one whose CP-Lead
   * cell is empty — division by zero leaves a dash where the worst number in the
   * panel should be, so pure waste renders as "no data".
   */
  | { verdict: "no_leads"; expectedLeads: number }
  /**
   * Nothing to say — either the segment sits within its own noise, or there is
   * no panel average to compare it against.
   */
  | { verdict: "none" };

const QUIET: SegmentBenchmark = { verdict: "none" };

/**
 * Roughly how far a segment's cost per lead can wander on chance alone.
 *
 * A rule of thumb, not a confidence interval: the relative error of a rate built
 * on `n` observations goes as `1/√n`. It only has to be the right order of
 * magnitude to stop a two-lead row from shouting.
 */
export function noiseFloor(leads: number): number {
  if (!Number.isFinite(leads) || leads <= 0) return Number.POSITIVE_INFINITY;
  return 1 / Math.sqrt(leads);
}

/**
 * Where one segment sits against its panel.
 *
 * @param spend         the segment's spend
 * @param leads         the segment's leads
 * @param panelCpLead   the weighted average CP-Lead across the panel's segments,
 *                      or null when the panel produced no leads at all
 */
export function benchmarkSegment(
  spend: number,
  leads: number,
  panelCpLead: number | null,
): SegmentBenchmark {
  if (panelCpLead === null || !Number.isFinite(panelCpLead) || panelCpLead <= 0) {
    return QUIET;
  }
  if (!Number.isFinite(spend) || spend <= 0) return QUIET;
  /*
   * 🔴 Reject a lead count that is not a real, non-negative number BEFORE any
   * comparison. Every relational test against NaN is false, so a NaN count
   * slips past both `leads <= 0` and the noise gate below (`NaN < Infinity` is
   * false), landing on the `gap > 0` branch — which is also false — and
   * emerging as a confident "cheaper" verdict carrying a NaN gap. A negative
   * count is corrupt input rather than an empty segment, and would otherwise
   * be reported as the "no leads" finding.
   */
  if (!Number.isFinite(leads) || leads < 0) return QUIET;

  /*
   * What the panel's own rate says this spend should have bought. This is the
   * whole comparison in one number, because `cpLead / panelCpLead` reduces to
   * `expected / actual` — so the zero-lead case below is the same question
   * asked at the one point the ratio cannot be written down.
   */
  const expectedLeads = spend / panelCpLead;

  if (leads <= 0) {
    return expectedLeads >= SURPRISING_ZERO_EXPECTED
      ? { verdict: "no_leads", expectedLeads }
      : QUIET;
  }

  /*
   * Identical to `(cpLead - panelCpLead) / panelCpLead`, written this way so
   * the arithmetic sits next to the zero case it generalises.
   *
   * One known asymmetry, recorded rather than hidden: a percentage gap runs to
   * +∞ upwards but bottoms out at −100%, so testing |gap| against a symmetric
   * noise floor makes "costlier" marginally easier to trip than "cheaper". The
   * bias points at over-reporting waste in a panel whose entire job is finding
   * waste, so it is left in rather than corrected on the log scale — which
   * would gate on a number different from the one displayed.
   */
  const gap = expectedLeads / leads - 1;
  const threshold = Math.max(MIN_NOTABLE_GAP, noiseFloor(leads));
  if (Math.abs(gap) < threshold) return QUIET;

  return gap > 0 ? { verdict: "costlier", gap } : { verdict: "cheaper", gap };
}
