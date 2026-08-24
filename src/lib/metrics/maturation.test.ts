import { describe, it, expect } from "vitest";
import {
  buildMaturation,
  shareAt,
  HORIZON_DAYS,
  type CohortInput,
  type ConversionInput,
} from "./maturation";
import type { OutcomeStage } from "./speed-outcome";

/**
 * The decision this exists to prevent, written as a fixture.
 *
 * A client opens the dashboard on the 8th. June: 35 leads, 12 appointments.
 * July: 40 leads, 3. The campaign gets switched off. June looked identical on
 * ITS eighth day — and every number in that comparison was correct.
 */

const ASOF = new Date("2026-08-08T12:00:00Z");
const MS = 86_400_000;

/** A cohort whose month opened `ageDays` before `asOf`. */
const cohort = (o: {
  month: string;
  ageDays: number;
  leads: number;
  complete?: boolean;
}): CohortInput => ({
  month: o.month,
  label: o.month,
  leads: o.leads,
  startUtc: new Date(ASOF.getTime() - o.ageDays * MS).toISOString(),
  complete: o.complete ?? true,
});

const conv = (
  month: string,
  stage: OutcomeStage,
  days: number[],
): ConversionInput[] => days.map((d) => ({ month, stage, days: d }));

const build = (c: CohortInput[], v: ConversionInput[]) =>
  buildMaturation(c, v, { asOf: ASOF });

/**
 * Four finished cohorts whose closes land on a consistent slow curve: nothing
 * inside a week, half by about day 30, the rest trailing to 80.
 */
const MATURE_HISTORY = [
  cohort({ month: "2026-01", ageDays: 210, leads: 40 }),
  cohort({ month: "2026-02", ageDays: 180, leads: 40 }),
  cohort({ month: "2026-03", ageDays: 150, leads: 40 }),
  cohort({ month: "2026-04", ageDays: 120, leads: 40 }),
];
const MATURE_CLOSES = MATURE_HISTORY.flatMap((c) =>
  conv(c.month, "closed_won", [20, 25, 30, 35, 50, 70]),
);

/* ------------------------------------------------------------------ *
 * The comparison that needs no inference
 * ------------------------------------------------------------------ */

describe("comparing two months at the same age", () => {
  it("🔴 flags the month that only looks worse because it is younger", () => {
    /*
     * July is 8 days old. Raw, it shows 3 appointments against June's 12 — and
     * the campaign gets killed. At 8 days old June had 2. July is ahead, from
     * more leads.
     */
    const cohorts = [
      cohort({ month: "2026-06", ageDays: 68, leads: 35 }),
      cohort({ month: "2026-07", ageDays: 8, leads: 40, complete: false }),
    ];
    const conversions = [
      // June: two land early, ten land later — after July's current age.
      ...conv("2026-06", "appointment_booked", [3, 6, 15, 18, 20, 24, 28, 30, 33, 40, 45, 50]),
      ...conv("2026-07", "appointment_booked", [2, 4, 7]),
    ];
    const check = build(cohorts, conversions).checks.find(
      (c) => c.stage === "appointment_booked",
    )!;

    expect(check.atDays).toBe(8);
    expect(check.rawRecent).toBe(3);
    expect(check.rawPrior).toBe(12);
    expect(check.recent.converted).toBe(3);
    expect(check.prior.converted).toBe(2);
    expect(check.misleading).toBe(true);
  });

  it("🔴 does not cry wolf on a month that is genuinely worse", () => {
    /*
     * The flag has to stay silent here or it teaches the reader to ignore it on
     * the month that matters. July is behind at equal age AND behind raw — it
     * really is the weaker month.
     */
    const cohorts = [
      cohort({ month: "2026-06", ageDays: 68, leads: 35 }),
      cohort({ month: "2026-07", ageDays: 8, leads: 40, complete: false }),
    ];
    const conversions = [
      ...conv("2026-06", "appointment_booked", [1, 2, 3, 4, 5, 6, 20, 30]),
      ...conv("2026-07", "appointment_booked", [5]),
    ];
    const check = build(cohorts, conversions).checks.find(
      (c) => c.stage === "appointment_booked",
    )!;
    expect(check.prior.converted).toBe(6);
    expect(check.recent.converted).toBe(1);
    expect(check.misleading).toBe(false);
  });

  it("🔴 stays silent when the raw reading was never misleading", () => {
    /*
     * The flag means "the comparison in front of you is wrong". If the recent
     * month already looks equal or better side by side, the reader is not being
     * misled by anything and there is nothing to correct — firing here would
     * make the warning decoration rather than a signal.
     */
    const cohorts = [
      cohort({ month: "2026-06", ageDays: 68, leads: 20 }),
      cohort({ month: "2026-07", ageDays: 20, leads: 30, complete: false }),
    ];
    const conversions = [
      // June genuinely has a late tail, so truncation DOES remove something —
      // every other clause of the flag is satisfied, and only the raw reading
      // stops it firing.
      ...conv("2026-06", "appointment_booked", [1, 2, 40, 50]),
      ...conv("2026-07", "appointment_booked", [1, 2, 3, 4, 5]),
    ];
    const check = build(cohorts, conversions).checks.find(
      (c) => c.stage === "appointment_booked",
    )!;
    expect(check.rawRecent).toBeGreaterThan(check.rawPrior);
    expect(check.prior.converted).toBeLessThan(check.rawPrior); // truncation bit
    expect(check.recent.rate!).toBeGreaterThan(check.prior.rate!);
    expect(check.misleading).toBe(false);
  });

  it("🔴 stays silent when maturity is not what explains the gap", () => {
    /*
     * Found on live data. This account's bookings land the SAME DAY the lead
     * arrives, so cutting the older month back to the younger one's age removes
     * nothing from it — 5 raw, 5 truncated. The recent month does have a better
     * rate, but maturity is not why, and the panel's explanation ("July has had
     * months to fill in") would be a confident false sentence about a stage
     * that fills in overnight.
     *
     * The neutral branch still states both counted numbers, which is the honest
     * version of the same comparison.
     */
    const cohorts = [
      cohort({ month: "2026-07", ageDays: 40, leads: 16 }),
      cohort({ month: "2026-08", ageDays: 12, leads: 5, complete: false }),
    ];
    const conversions = [
      // Every July booking landed within a day — none after August's age.
      ...conv("2026-07", "appointment_booked", [0, 0, 1, 1, 1]),
      ...conv("2026-08", "appointment_booked", [0, 1, 1]),
    ];
    const check = build(cohorts, conversions).checks.find(
      (c) => c.stage === "appointment_booked",
    )!;
    expect(check.rawRecent).toBe(3);
    expect(check.rawPrior).toBe(5);
    expect(check.prior.converted).toBe(5); // truncation was a no-op
    expect(check.recent.rate!).toBeGreaterThan(check.prior.rate!);
    expect(check.misleading).toBe(false);
  });

  it("compares rates, so a bigger month is not credited for being bigger", () => {
    // Equal counts from unequal lead volumes is not equal performance.
    const cohorts = [
      cohort({ month: "2026-06", ageDays: 68, leads: 20 }),
      cohort({ month: "2026-07", ageDays: 10, leads: 80, complete: false }),
    ];
    const conversions = [
      ...conv("2026-06", "appointment_booked", [2, 3, 40, 41, 42]),
      ...conv("2026-07", "appointment_booked", [2, 3]),
    ];
    const check = build(cohorts, conversions).checks.find(
      (c) => c.stage === "appointment_booked",
    )!;
    expect(check.prior.rate).toBeCloseTo(2 / 20, 6);
    expect(check.recent.rate).toBeCloseTo(2 / 80, 6);
    // Raw counts fall (5 → 2) but the rate is WORSE too, so nothing is hidden.
    expect(check.misleading).toBe(false);
  });

  it("🔴 truncates the older month, not just the younger one", () => {
    // Cutting only the recent cohort would compare 8 days against 68 and
    // reproduce the exact error, with extra arithmetic.
    const cohorts = [
      cohort({ month: "2026-06", ageDays: 68, leads: 35 }),
      cohort({ month: "2026-07", ageDays: 8, leads: 35, complete: false }),
    ];
    const conversions = conv("2026-06", "closed_won", [1, 40, 50, 60]);
    const check = build(cohorts, conversions).checks.find((c) => c.stage === "closed_won")!;
    expect(check.prior.converted).toBe(1); // only the day-1 close is inside 8 days
    expect(check.rawPrior).toBe(4);
  });

  it("says nothing when there is only one month of history", () => {
    const r = build([cohort({ month: "2026-08", ageDays: 8, leads: 10 })], []);
    expect(r.checks).toEqual([]);
  });

  it("says nothing on the first day of a month, when there is no age to cut to", () => {
    const r = build(
      [
        cohort({ month: "2026-07", ageDays: 40, leads: 30 }),
        cohort({ month: "2026-08", ageDays: 0, leads: 1, complete: false }),
      ],
      [],
    );
    expect(r.checks).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * The curve
 * ------------------------------------------------------------------ */

describe("how conversions fill in", () => {
  it("measures the shape from finished months", () => {
    const c = build(MATURE_HISTORY, MATURE_CLOSES).curves.find(
      (x) => x.stage === "closed_won",
    )!;
    expect(c.measured).toBe(true);
    expect(c.basis).toBe(4);
    // Nothing lands in the first week on this fixture.
    expect(shareAt(c.curve, 7)).toBe(0);
    // Half by day 30-ish, everything by 90.
    expect(shareAt(c.curve, 30)).toBeCloseTo(0.5, 1);
    expect(shareAt(c.curve, HORIZON_DAYS)).toBe(1);
    expect(c.halfDays).toBeGreaterThan(20);
    expect(c.halfDays).toBeLessThan(40);
  });

  it("🔴 leaves unfinished months out of the measurement", () => {
    /*
     * The bias that silently cancels the whole feature. An eight-day-old cohort
     * contributes its early conversions and none of its late ones, so folded in
     * it reports the fill-in as far faster than it is — which makes every
     * immature month look nearly complete, which is the error being corrected.
     */
    const young = cohort({ month: "2026-08", ageDays: 8, leads: 40, complete: false });
    const withYoung = build(
      [...MATURE_HISTORY, young],
      [...MATURE_CLOSES, ...conv("2026-08", "closed_won", [1, 2, 3, 4, 5, 6])],
    ).curves.find((x) => x.stage === "closed_won")!;

    expect(withYoung.basis).toBe(4); // the young cohort is not counted
    expect(shareAt(withYoung.curve, 7)).toBe(0); // and has not bent the curve
  });

  it("🔴 refuses a curve built on too few months", () => {
    const c = build(MATURE_HISTORY.slice(0, 2), MATURE_CLOSES).curves.find(
      (x) => x.stage === "closed_won",
    )!;
    expect(c.measured).toBe(false);
    expect(c.curve).toEqual([]);
    expect(c.halfDays).toBeNull();
  });

  it("🔴 ignores a month with a handful of conversions", () => {
    // One conversion gives a share of exactly 0 or 1 at every age — a step
    // function that would drag the median toward a cliff.
    const thin = MATURE_HISTORY.flatMap((c) => conv(c.month, "closed_won", [30]));
    const c = build(MATURE_HISTORY, thin).curves.find((x) => x.stage === "closed_won")!;
    expect(c.measured).toBe(false);
    expect(c.basis).toBe(0);
  });

  it("uses the median across months, so one freak month cannot set the shape", () => {
    const odd = [
      ...MATURE_CLOSES.filter((c) => c.month !== "2026-01"),
      // January closed everything on day one. It must not drag the curve.
      ...conv("2026-01", "closed_won", [1, 1, 1, 1, 1, 1]),
    ];
    const c = build(MATURE_HISTORY, odd).curves.find((x) => x.stage === "closed_won")!;
    expect(shareAt(c.curve, 7)).toBe(0);
  });

  it("never runs backwards, on a fixture built to try", () => {
    /*
     * Four cohorts with wildly different shapes, so the column medians jump
     * between different cohorts as the age advances — the situation a clamp
     * would exist for. It still cannot dip: each cohort's own share is a count
     * over a fixed total, and the median of pointwise-ordered values is itself
     * ordered. The property is structural, and the test pins it so a future
     * rewrite to a mean or a trimmed statistic has to face it.
     */
    const jagged = [
      ...conv("2026-01", "closed_won", [1, 2, 3, 80, 85, 88]),
      ...conv("2026-02", "closed_won", [40, 41, 42, 43, 44, 45]),
      ...conv("2026-03", "closed_won", [1, 1, 1, 1, 1, 90]),
      ...conv("2026-04", "closed_won", [10, 60, 61, 62, 63, 89]),
    ];
    const c = build(MATURE_HISTORY, jagged).curves.find((x) => x.stage === "closed_won")!;
    for (let i = 1; i < c.curve.length; i++) {
      expect(c.curve[i].share).toBeGreaterThanOrEqual(c.curve[i - 1].share);
    }
    expect(c.curve[c.curve.length - 1].share).toBe(1);
  });

  it("drops conversions beyond the horizon rather than piling them on the end", () => {
    const late = MATURE_HISTORY.flatMap((c) =>
      conv(c.month, "closed_won", [10, 20, 30, 40, 50, 400]),
    );
    const r = build(MATURE_HISTORY, late);
    const row = r.cohorts.find((x) => x.month === "2026-01")!;
    expect(row.stages.closed_won.observed).toBe(5); // the 400-day close is out

    /*
     * 🔴 And out of the CURVE's denominator too. Left in, each cohort's total
     * becomes six while only five ever land inside the horizon, so the curve
     * tops out at 5/6 — every finished month then reads as 83% matured and
     * gets projected upward forever.
     */
    const c = r.curves.find((x) => x.stage === "closed_won")!;
    expect(shareAt(c.curve, HORIZON_DAYS)).toBe(1);
    expect(c.curve[c.curve.length - 1].share).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * Projection
 * ------------------------------------------------------------------ */

describe("projecting an unfinished month", () => {
  const withRecent = (ageDays: number, closes: number[]) =>
    build(
      [...MATURE_HISTORY, cohort({ month: "2026-08", ageDays, leads: 40, complete: false })],
      [...MATURE_CLOSES, ...conv("2026-08", "closed_won", closes)],
    ).cohorts.find((c) => c.month === "2026-08")!;

  it("🔴 refuses to project a barely-started month", () => {
    /*
     * At 8 days old this fixture's maturity is zero and even a little higher
     * would multiply the observed count by twenty. That is not an estimate, and
     * the honest output is the words "too early".
     */
    const row = withRecent(8, [1, 2, 3]);
    expect(row.stages.closed_won.observed).toBe(3);
    expect(row.stages.closed_won.maturity).toBeLessThan(0.25);
    expect(row.stages.closed_won.projected).toBeNull();
  });

  it("projects once enough has landed to be worth saying", () => {
    // Half-way through the curve, six observed closes imply about twelve.
    const row = withRecent(30, [1, 2, 3, 4, 5, 6]);
    expect(row.stages.closed_won.maturity).toBeCloseTo(0.5, 1);
    expect(row.stages.closed_won.projected).toBe(12);
  });

  it("stops projecting once a month has settled", () => {
    const row = build(MATURE_HISTORY, MATURE_CLOSES).cohorts.find(
      (c) => c.month === "2026-01",
    )!;
    expect(row.stages.closed_won.maturity).toBe(1);
    expect(row.stages.closed_won.projected).toBe(row.stages.closed_won.observed);
  });

  it("🔴 never projects without a measured curve, even on a settled month", () => {
    /*
     * A 200-day-old cohort IS settled — that much follows from the calendar and
     * needs no curve, so its maturity reads 1 and the panel says "settled"
     * rather than "0% matured" on a month that finished half a year ago.
     *
     * But settled is not the same as projectable: with no curve there is no
     * fill-in pattern, and a projection would be the observed count wearing a
     * different label and implying an inference nobody made.
     */
    const r = build(
      [
        cohort({ month: "2026-01", ageDays: 200, leads: 30 }),
        cohort({ month: "2026-07", ageDays: 40, leads: 30 }),
        cohort({ month: "2026-08", ageDays: 8, leads: 30, complete: false }),
      ],
      conv("2026-01", "closed_won", [5, 6, 40, 70]),
    );
    expect(r.curves.find((c) => c.stage === "closed_won")!.measured).toBe(false);

    const settled = r.cohorts.find((c) => c.month === "2026-01")!;
    expect(settled.stages.closed_won.maturity).toBe(1);
    expect(settled.stages.closed_won.observed).toBe(4);
    expect(settled.stages.closed_won.projected).toBeNull();

    expect(r.cohorts.every((c) => c.stages.closed_won.projected === null)).toBe(true);
  });

  it("keeps the observed count as its own field, always", () => {
    // The projection must never be able to displace the counted number.
    const row = withRecent(30, [1, 2, 3, 4, 5, 6]);
    expect(row.stages.closed_won.observed).toBe(6);
  });
});

/* ------------------------------------------------------------------ *
 * Shape
 * ------------------------------------------------------------------ */

describe("the report", () => {
  it("lists cohorts newest first", () => {
    const r = build(MATURE_HISTORY, MATURE_CLOSES);
    expect(r.cohorts.map((c) => c.month)).toEqual([
      "2026-04",
      "2026-03",
      "2026-02",
      "2026-01",
    ]);
  });

  it("counts each stage independently", () => {
    const r = build(MATURE_HISTORY, [
      ...conv("2026-01", "appointment_booked", [5, 6, 7]),
      ...conv("2026-01", "closed_won", [40]),
    ]);
    const row = r.cohorts.find((c) => c.month === "2026-01")!;
    expect(row.stages.appointment_booked.observed).toBe(3);
    expect(row.stages.closed_won.observed).toBe(1);
    expect(row.stages.showed.observed).toBe(0);
  });

  it("carries the lead count and part-month flag through", () => {
    const r = build([cohort({ month: "2026-08", ageDays: 8, leads: 40, complete: false })], []);
    expect(r.cohorts[0].leads).toBe(40);
    expect(r.cohorts[0].complete).toBe(false);
  });

  it("survives an account with no history at all", () => {
    const r = build([], []);
    expect(r.cohorts).toEqual([]);
    expect(r.checks).toEqual([]);
    expect(r.curves.every((c) => !c.measured)).toBe(true);
  });
});

describe("shareAt", () => {
  const curve = [
    { day: 10, share: 0.2 },
    { day: 50, share: 0.8 },
  ];

  it("interpolates between points", () => {
    expect(shareAt(curve, 30)).toBeCloseTo(0.5, 6);
  });

  it("is zero at the start and one past the horizon", () => {
    expect(shareAt(curve, 0)).toBe(0);
    expect(shareAt(curve, HORIZON_DAYS)).toBe(1);
    expect(shareAt(curve, 400)).toBe(1);
  });

  it("🔴 claims nothing for an unmeasured curve, at any age", () => {
    // No curve means no claim — including past the horizon, where the shortcut
    // would otherwise report a cohort as fully matured on no evidence at all.
    expect(shareAt([], 45)).toBe(0);
    expect(shareAt([], 200)).toBe(0);
  });
});
