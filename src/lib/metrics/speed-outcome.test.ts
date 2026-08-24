import { describe, it, expect } from "vitest";
import {
  buildSpeedOutcome,
  measureCallingWindow,
  verdictStrength,
  FAST_THRESHOLD_SECONDS,
  OUTCOME_STAGES,
  type OutcomeStage,
  type SpeedOutcomeLead,
} from "./speed-outcome";
import type { CanonicalStage } from "@/db/schema";

/**
 * The three ways this measurement lies if you build it the obvious way, each
 * written as a fixture that fails without the guard.
 *
 * Every date here is anchored to a fixed `asOf` rather than the clock, because
 * a censoring rule tested against `new Date()` passes in the morning and fails
 * in the afternoon.
 */

const ASOF = new Date("2026-08-14T12:00:00Z");
const ALL_MAPPED = new Set<CanonicalStage>([
  "new_lead",
  "contacted",
  "appointment_booked",
  "showed",
  "no_show",
  "closed_won",
  "lost",
]);

/** A lead that arrived `ageDays` ago, at a Tuesday 10am-ish local hour. */
function lead(o: {
  ageDays: number;
  secondsToCall?: number | null;
  reached?: Partial<Record<OutcomeStage, number>>;
  arrivalHour?: number;
  arrivalDow?: number;
  callHour?: number | null;
  callDow?: number | null;
}): SpeedOutcomeLead {
  const at = new Date(ASOF.getTime() - o.ageDays * 86_400_000);
  const secondsToCall = o.secondsToCall === undefined ? 60 : o.secondsToCall;
  return {
    leadAt: at.toISOString(),
    secondsToCall,
    arrivalDow: o.arrivalDow ?? 2,
    arrivalHour: o.arrivalHour ?? 10,
    callDow: o.callDow !== undefined ? o.callDow : secondsToCall === null ? null : 2,
    callHour: o.callHour !== undefined ? o.callHour : secondsToCall === null ? null : 10,
    reached: o.reached ?? {},
  };
}

const build = (
  leads: SpeedOutcomeLead[],
  opts: { mapped?: Set<CanonicalStage>; asOf?: Date } = {},
) =>
  buildSpeedOutcome(leads, {
    asOf: opts.asOf ?? ASOF,
    mappedStages: opts.mapped ?? ALL_MAPPED,
    trackingStartedAt: "2026-01-01T00:00:00.000Z",
  });

const stageOf = (r: ReturnType<typeof build>, s: OutcomeStage) =>
  r.stages.find((x) => x.stage === s)!;

/* ------------------------------------------------------------------ *
 * 1 · Censoring — the bias that would break the feature when it works
 * ------------------------------------------------------------------ */

describe("leads too new to judge", () => {
  it("withholds a recent lead that has not converted, rather than scoring it a failure", () => {
    const r = build([
      lead({ ageDays: 1 }), // arrived yesterday, no booking YET
      lead({ ageDays: 60, reached: { appointment_booked: 3 } }),
      lead({ ageDays: 60 }),
    ]);
    const s = stageOf(r, "appointment_booked");
    expect(s.maturing).toBe(1);
    expect(s.matured).toBe(2);
    expect(s.converted).toBe(1);
  });

  it("🔴 counts a recent lead that HAS converted, at any age", () => {
    /*
     * The inversion that matters. Fast responders convert fastest, so an
     * age-only rule discards exactly the evidence that answering quickly works
     * — and the panel then reports that answering quickly does not work, most
     * strongly at the moment a client starts answering quickly.
     */
    const r = build([
      lead({ ageDays: 0.5, secondsToCall: 60, reached: { appointment_booked: 0.2 } }),
      lead({ ageDays: 60, secondsToCall: 90_000 }),
    ]);
    const s = stageOf(r, "appointment_booked");
    expect(s.maturing).toBe(0);
    expect(s.matured).toBe(2);
    expect(s.verdict!.fast.converted).toBe(1);
    expect(s.verdict!.fast.leads).toBe(1);
  });

  it("uses a longer maturation for deeper stages", () => {
    // A 20-day-old lead can be judged on booking but not on closing.
    const r = build([lead({ ageDays: 20 })]);
    expect(stageOf(r, "appointment_booked").matured).toBe(1);
    expect(stageOf(r, "closed_won").matured).toBe(0);
    expect(stageOf(r, "closed_won").maturing).toBe(1);
  });

  it("measures the maturation window from the client's own conversions", () => {
    /*
     * Five observed bookings at 1–3 days: this client books fast, so a lead
     * silent for four days is genuinely a non-booker and the 14-day default
     * would throw away most of the cohort for nothing.
     */
    const converters = [1, 1, 2, 2, 3].map((d) =>
      lead({ ageDays: 30, reached: { appointment_booked: d } }),
    );
    const r = build([...converters, lead({ ageDays: 5 })]);
    const s = stageOf(r, "appointment_booked");
    expect(s.maturationMeasured).toBe(true);
    expect(s.maturationDays).toBeLessThan(5);
    expect(s.matured).toBe(6); // the 5-day-old lead now counts
  });

  it("🔴 waits for the slow tail of conversions, not the typical one", () => {
    /*
     * Four of this client's five bookings land on day one and the fifth takes
     * ten days. The typical booking is same-day — but a lead silent for three
     * days still has a real chance of booking, and judging it now would score a
     * future booking as a failure. The window is the tail (p90 ≈ 6.4 days), not
     * the middle (p50 = 1 day), and a three-day-old lead sits between them.
     */
    const r = build([
      ...[1, 1, 1, 1, 10].map((d) =>
        lead({ ageDays: 40, reached: { appointment_booked: d } }),
      ),
      lead({ ageDays: 3 }),
    ]);
    const s = stageOf(r, "appointment_booked");
    expect(s.maturationDays).toBeGreaterThan(3);
    expect(s.maturationDays).toBeLessThan(10);
    expect(s.maturing).toBe(1);
    expect(s.matured).toBe(5);
  });

  it("falls back to the default below five observations, and says which", () => {
    const r = build([
      ...[1, 2].map((d) => lead({ ageDays: 30, reached: { appointment_booked: d } })),
      lead({ ageDays: 5 }),
    ]);
    const s = stageOf(r, "appointment_booked");
    expect(s.maturationMeasured).toBe(false);
    expect(s.maturationDays).toBe(14);
    expect(s.maturing).toBe(1);
  });

  it("🔴 caps the measured window so one stale deal cannot empty the cohort", () => {
    // Four quick bookings and one that took 300 days. An uncapped p90 would
    // demand every lead be most of a year old before it counted.
    const r = build([
      ...[1, 1, 2, 2].map((d) =>
        lead({ ageDays: 400, reached: { appointment_booked: d } }),
      ),
      lead({ ageDays: 400, reached: { appointment_booked: 300 } }),
      lead({ ageDays: 70 }),
    ]);
    const s = stageOf(r, "appointment_booked");
    expect(s.maturationDays).toBeLessThanOrEqual(60);
    expect(s.matured).toBe(6);
  });

  it("floors the measured window at a day when everything converts instantly", () => {
    const r = build([
      ...Array.from({ length: 5 }, () =>
        lead({ ageDays: 30, reached: { appointment_booked: 0 } }),
      ),
      lead({ ageDays: 0.2 }),
    ]);
    const s = stageOf(r, "appointment_booked");
    expect(s.maturationDays).toBeGreaterThanOrEqual(1);
    expect(s.maturing).toBe(1); // a five-hour-old lead is still too new
  });
});

/* ------------------------------------------------------------------ *
 * 2 · Triage — never-called leads are not "infinitely slow"
 * ------------------------------------------------------------------ */

describe("leads nobody called", () => {
  const fixture = [
    ...Array.from({ length: 8 }, () =>
      lead({ ageDays: 40, secondsToCall: 120, reached: { appointment_booked: 1 } }),
    ),
    ...Array.from({ length: 8 }, () => lead({ ageDays: 40, secondsToCall: 120 })),
    // Ten leads the team looked at and skipped. None booked, by construction.
    ...Array.from({ length: 10 }, () => lead({ ageDays: 40, secondsToCall: null })),
  ];

  it("🔴 keeps them out of the slow arm, so triage cannot fake a speed effect", () => {
    const s = stageOf(build(fixture), "appointment_booked");
    // Fast arm: the 16 called leads. Slow arm: nothing — so no comparison.
    expect(s.verdict).toBeNull();
    const never = s.buckets.find((b) => b.id === "never")!;
    expect(never.leads).toBe(10);
    expect(never.inComparison).toBe(false);
  });

  it("still reports their rate on its own row", () => {
    // Excluded from the test is not the same as hidden — "ten leads nobody
    // called, none of them booked" is the most actionable line on the panel.
    const s = stageOf(build(fixture), "appointment_booked");
    const never = s.buckets.find((b) => b.id === "never")!;
    expect(never.rate).toBe(0);
    expect(never.leads).toBe(10);
  });

  it("counts them in neither arm even when both arms exist", () => {
    const s = stageOf(
      build([
        ...fixture,
        ...Array.from({ length: 6 }, () => lead({ ageDays: 40, secondsToCall: 90_000 })),
      ]),
      "appointment_booked",
    );
    expect(s.verdict!.fast.leads + s.verdict!.slow.leads).toBe(22);
    expect(s.matured).toBe(32);
  });
});

/* ------------------------------------------------------------------ *
 * 3 · The contrast itself
 * ------------------------------------------------------------------ */

describe("the fast/slow split", () => {
  it("puts a call at exactly the threshold on the fast side", () => {
    const s = stageOf(
      build([
        lead({ ageDays: 40, secondsToCall: FAST_THRESHOLD_SECONDS }),
        lead({ ageDays: 40, secondsToCall: FAST_THRESHOLD_SECONDS + 1 }),
      ]),
      "appointment_booked",
    );
    expect(s.verdict!.fast.leads).toBe(1);
    expect(s.verdict!.slow.leads).toBe(1);
  });

  it("returns no verdict when every lead is on one side", () => {
    // Not a weak finding — no comparison at all. Rendering it as a coin flip
    // would imply we had looked at two groups.
    const s = stageOf(
      build(Array.from({ length: 20 }, () => lead({ ageDays: 40, secondsToCall: 60 }))),
      "appointment_booked",
    );
    expect(s.verdict).toBeNull();
  });

  it("finds a real effect when there is one", () => {
    const s = stageOf(
      build([
        ...Array.from({ length: 40 }, (_, i) =>
          lead({
            ageDays: 40,
            secondsToCall: 120,
            reached: i < 16 ? { appointment_booked: 1 } : {},
          }),
        ),
        ...Array.from({ length: 40 }, (_, i) =>
          lead({
            ageDays: 40,
            secondsToCall: 90_000,
            reached: i < 6 ? { appointment_booked: 2 } : {},
          }),
        ),
      ]),
      "appointment_booked",
    );
    expect(s.verdict!.fast.rate).toBeCloseTo(0.4, 6);
    expect(s.verdict!.slow.rate).toBeCloseTo(0.15, 6);
    expect(s.verdict!.gapPoints).toBeCloseTo(25, 6);
    expect(s.verdict!.strength).toBe("fast_clear");
  });

  it("🔴 does not find one when the same rates come from four leads", () => {
    // 50% against 0% — the shape of a headline finding, from two leads a side.
    const s = stageOf(
      build([
        lead({ ageDays: 40, secondsToCall: 60, reached: { appointment_booked: 1 } }),
        lead({ ageDays: 40, secondsToCall: 60 }),
        lead({ ageDays: 40, secondsToCall: 90_000 }),
        lead({ ageDays: 40, secondsToCall: 90_000 }),
      ]),
      "appointment_booked",
    );
    expect(s.verdict!.fast.rate).toBe(0.5);
    expect(s.verdict!.slow.rate).toBe(0);
    expect(s.verdict!.strength).toBe("inconclusive");
  });

  it("🔴 reports a reversal rather than burying it as inconclusive", () => {
    /*
     * A panel built to recommend answering faster that can only say "yes" or
     * "not sure" is confirming its own premise. If this client's slower-called
     * leads convert better, that has to be sayable.
     */
    const s = stageOf(
      build([
        ...Array.from({ length: 40 }, (_, i) =>
          lead({
            ageDays: 40,
            secondsToCall: 120,
            reached: i < 4 ? { appointment_booked: 1 } : {},
          }),
        ),
        ...Array.from({ length: 40 }, (_, i) =>
          lead({
            ageDays: 40,
            secondsToCall: 90_000,
            reached: i < 18 ? { appointment_booked: 2 } : {},
          }),
        ),
      ]),
      "appointment_booked",
    );
    expect(s.verdict!.strength).toBe("slow_clear");
    expect(s.verdict!.gapPoints).toBeLessThan(0);
  });

  it("maps probabilities to strengths symmetrically", () => {
    expect(verdictStrength(0.99)).toBe("fast_clear");
    expect(verdictStrength(0.95)).toBe("fast_clear");
    expect(verdictStrength(0.85)).toBe("fast_leaning");
    expect(verdictStrength(0.5)).toBe("inconclusive");
    expect(verdictStrength(0.15)).toBe("slow_leaning");
    expect(verdictStrength(0.02)).toBe("slow_clear");
  });
});

/* ------------------------------------------------------------------ *
 * The buckets
 * ------------------------------------------------------------------ */

describe("response-time buckets", () => {
  it("cuts at 5 minutes, an hour and a day, inclusive of the boundary", () => {
    const s = stageOf(
      build([
        lead({ ageDays: 40, secondsToCall: 300 }),
        lead({ ageDays: 40, secondsToCall: 301 }),
        lead({ ageDays: 40, secondsToCall: 3600 }),
        lead({ ageDays: 40, secondsToCall: 3601 }),
        lead({ ageDays: 40, secondsToCall: 86_400 }),
        lead({ ageDays: 40, secondsToCall: 86_401 }),
        lead({ ageDays: 40, secondsToCall: null }),
      ]),
      "appointment_booked",
    );
    const n = (id: string) => s.buckets.find((b) => b.id === id)!.leads;
    expect(n("under_5m")).toBe(1);
    expect(n("under_1h")).toBe(2); // 301s and 3600s
    expect(n("under_24h")).toBe(2); // 3601s and 86400s
    expect(n("over_24h")).toBe(1);
    expect(n("never")).toBe(1);
  });

  it("gives an empty bucket a null rate, never a zero", () => {
    // 0% reads as "nobody in this band converted". Null reads as "nobody was in
    // this band", which is what it is.
    const s = stageOf(build([lead({ ageDays: 40, secondsToCall: 60 })]), "appointment_booked");
    const empty = s.buckets.find((b) => b.id === "over_24h")!;
    expect(empty.leads).toBe(0);
    expect(empty.rate).toBeNull();
    expect(empty.lo).toBeNull();
  });

  it("🔴 widens the interval on a one-lead bucket instead of hiding it", () => {
    const s = stageOf(
      build([lead({ ageDays: 40, secondsToCall: 60, reached: { appointment_booked: 1 } })]),
      "appointment_booked",
    );
    const b = s.buckets.find((b) => b.id === "under_5m")!;
    expect(b.rate).toBe(1); // shown, per the plan's rule against suppression
    expect(b.lo!).toBeLessThan(0.35); // and honestly qualified
  });
});

/* ------------------------------------------------------------------ *
 * 4 · The confound — when the lead arrived, not how fast we answered
 * ------------------------------------------------------------------ */

describe("the calling window", () => {
  const calls = (n: number, hour: number, dow = 2) =>
    Array.from({ length: n }, () =>
      lead({ ageDays: 40, secondsToCall: 60, callHour: hour, callDow: dow }),
    );

  it("is not measured from a handful of calls", () => {
    expect(measureCallingWindow(calls(19, 10))).toBeNull();
  });

  it("brackets the hours this client actually dials", () => {
    const w = measureCallingWindow([
      ...calls(10, 9),
      ...calls(10, 14),
      ...calls(10, 17),
    ])!;
    expect(w.startHour).toBeLessThanOrEqual(9);
    expect(w.endHour).toBeGreaterThanOrEqual(17);
    expect(w.calls).toBe(30);
  });

  it("🔴 keeps Saturday when the client works Saturdays", () => {
    // An assumed Mon–Fri would push every weekend lead out of the control, and
    // for a med spa that is most of the week's enquiries.
    const w = measureCallingWindow([...calls(20, 11, 2), ...calls(10, 11, 6)])!;
    expect(w.days).toContain(6);
  });

  it("🔴 drops a day carrying a stray call, and does not let it widen the hours", () => {
    /*
     * One 3am Sunday call among forty Tuesday-morning ones. Taken as the edge
     * of the working window it would declare this client contactable from 3am
     * on any day, which quietly readmits every out-of-hours lead the control
     * exists to exclude. Trimmed percentiles rather than min/max, for the same
     * reason the dispersion estimate elsewhere is a median.
     */
    const w = measureCallingWindow([...calls(40, 11, 2), ...calls(1, 3, 7)])!;
    expect(w.days).toEqual([2]);
    expect(w.startHour).toBeGreaterThanOrEqual(10);
  });

  it("🔴 excludes an arrival on a day this client does not work", () => {
    // A Sunday 11am lead waits until Monday through nobody's failure. Judging
    // the sales team on that response time measures the calendar, not them.
    const at = (dow: number, secondsToCall: number, booked: boolean) =>
      lead({
        ageDays: 40,
        secondsToCall,
        arrivalDow: dow,
        arrivalHour: 11,
        callDow: 2,
        callHour: 11,
        reached: booked ? { appointment_booked: 1 } : {},
      });
    const r = build([
      ...Array.from({ length: 30 }, (_, i) => at(2, 120, i < 12)),
      ...Array.from({ length: 30 }, (_, i) => at(2, 90_000, i < 4)),
      // Sunday arrivals: answered slowly, and they book well. Leaving them in
      // would drag the slow arm's rate up and hide a real effect.
      ...Array.from({ length: 20 }, () => at(7, 90_000, true)),
    ]);
    const s = stageOf(r, "appointment_booked");
    expect(s.verdict!.slow.leads).toBe(50);
    expect(s.control!.slow.leads).toBe(30);
    expect(s.control!.probFastBetter).toBeGreaterThan(s.verdict!.probFastBetter);
  });

  it("ignores never-called leads when measuring it", () => {
    const w = measureCallingWindow([
      ...calls(20, 11),
      ...Array.from({ length: 50 }, () => lead({ ageDays: 40, secondsToCall: null })),
    ])!;
    expect(w.calls).toBe(20);
  });

  it("🔴 re-runs the contrast inside those hours, and can fail to reproduce it", () => {
    /*
     * The confound made concrete: fast leads all arrive at 11am and convert;
     * slow leads all arrive at 3am and do not. In-hours, only the fast leads
     * remain, so the control must decline to confirm rather than repeat the
     * headline back.
     */
    const r = build([
      ...Array.from({ length: 20 }, () =>
        lead({
          ageDays: 40,
          secondsToCall: 120,
          arrivalHour: 11,
          callHour: 11,
          reached: { appointment_booked: 1 },
        }),
      ),
      ...Array.from({ length: 20 }, () =>
        lead({ ageDays: 40, secondsToCall: 90_000, arrivalHour: 3, callHour: 11 }),
      ),
    ]);
    const s = stageOf(r, "appointment_booked");
    expect(s.verdict!.strength).toBe("fast_clear");
    expect(s.control).toBeNull(); // one arm empty once night arrivals are out
  });

  it("confirms the contrast when it survives the restriction", () => {
    const inHours = (secondsToCall: number, booked: boolean) =>
      lead({
        ageDays: 40,
        secondsToCall,
        arrivalHour: 11,
        callHour: 11,
        reached: booked ? { appointment_booked: 1 } : {},
      });
    const r = build([
      ...Array.from({ length: 40 }, (_, i) => inHours(120, i < 16)),
      ...Array.from({ length: 40 }, (_, i) => inHours(90_000, i < 5)),
    ]);
    const s = stageOf(r, "appointment_booked");
    expect(s.control!.fast.leads).toBe(40);
    expect(s.control!.probFastBetter).toBeGreaterThan(0.95);
  });

  it("leaves the control null when the window cannot be measured at all", () => {
    const s = stageOf(
      build([
        lead({ ageDays: 40, secondsToCall: 60 }),
        lead({ ageDays: 40, secondsToCall: 90_000 }),
      ]),
      "appointment_booked",
    );
    expect(s.verdict).not.toBeNull();
    expect(s.control).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Stage selection and shape
 * ------------------------------------------------------------------ */

describe("which outcome the panel opens on", () => {
  it("🔴 opens on booking even when deeper stages have data", () => {
    /*
     * Deliberately NOT the deepest stage with data, which is what the campaign
     * table does. Speed to lead acts on whether you reach someone while they
     * are still enquiring; a close is weeks and a sales conversation further
     * on, so attributing it to response time is a longer chain on a tenth of
     * the sample.
     */
    const r = build([
      lead({
        ageDays: 90,
        reached: { appointment_booked: 1, showed: 3, closed_won: 20 },
      }),
    ]);
    expect(r.defaultStage).toBe("appointment_booked");
  });

  it("falls through to a deeper stage when nothing has booked", () => {
    const r = build([lead({ ageDays: 90, reached: { closed_won: 20 } })]);
    expect(r.defaultStage).toBe("closed_won");
  });

  it("defaults to booking on an account with no outcomes at all", () => {
    expect(build([lead({ ageDays: 90 })]).defaultStage).toBe("appointment_booked");
  });

  it("flags a stage no GHL stage is mapped to", () => {
    const r = build([lead({ ageDays: 90 })], {
      mapped: new Set<CanonicalStage>(["new_lead", "appointment_booked"]),
    });
    expect(stageOf(r, "showed").mapped).toBe(false);
    expect(stageOf(r, "appointment_booked").mapped).toBe(true);
  });

  it("offers every outcome stage, including the empty ones", () => {
    const r = build([lead({ ageDays: 90 })]);
    expect(r.stages.map((s) => s.stage)).toEqual([...OUTCOME_STAGES]);
  });

  it("carries the pre-tracking count through untouched", () => {
    const r = buildSpeedOutcome([], {
      asOf: ASOF,
      mappedStages: ALL_MAPPED,
      trackingStartedAt: "2026-05-01T00:00:00.000Z",
      preTracking: 137,
    });
    expect(r.preTracking).toBe(137);
    expect(r.cohort).toBe(0);
  });

  it("survives an empty cohort without throwing", () => {
    const r = build([]);
    expect(r.cohort).toBe(0);
    expect(stageOf(r, "appointment_booked").verdict).toBeNull();
    expect(stageOf(r, "appointment_booked").matured).toBe(0);
  });

  it("counts a stage independently of the others", () => {
    // A lead that booked and never showed must not count as a show, and the
    // maturation windows differ per stage.
    const r = build([
      lead({ ageDays: 90, reached: { appointment_booked: 2 } }),
      lead({ ageDays: 90, reached: { appointment_booked: 2, showed: 5 } }),
    ]);
    expect(stageOf(r, "appointment_booked").converted).toBe(2);
    expect(stageOf(r, "showed").converted).toBe(1);
    expect(stageOf(r, "closed_won").converted).toBe(0);
  });
});
