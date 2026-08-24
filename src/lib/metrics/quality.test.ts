import { describe, it, expect } from "vitest";
import {
  buildQuality,
  dayTypeOf,
  describeSignal,
  hourBandOf,
  CONFIDENT,
  MIN_LEADS_PER_LEVEL,
  UNATTRIBUTED,
  type QualityLead,
} from "./quality";

/**
 * The lead-quality engine.
 *
 * What is being defended here is mostly restraint: that a segment is not called
 * better or worse without the volume to say so, that a young lead is not
 * counted as a failure, and that the comparison is against the REST of the
 * feature rather than against a base rate containing the segment itself.
 */

const DAY = 86_400_000;
const NOW = new Date("2026-08-14T12:00:00Z");
/** Old enough to be judged under any maturation rule this engine can pick. */
const OLD = new Date(NOW.getTime() - 120 * DAY).toISOString();

const lead = (over: Partial<QualityLead> = {}): QualityLead => ({
  leadAt: OLD,
  dow: 3,
  hour: 10,
  campaignId: "camp_a",
  reached: {},
  ...over,
});

/** `n` leads sharing attributes, `k` of which booked. */
function group(n: number, k: number, over: Partial<QualityLead> = {}): QualityLead[] {
  return Array.from({ length: n }, (_, i) =>
    lead({ ...over, reached: i < k ? { appointment_booked: 2 } : {} }),
  );
}

const build = (leads: QualityLead[], stage: "appointment_booked" | "closed_won" = "appointment_booked") =>
  buildQuality(leads, { stage, asOf: NOW });

const feature = (r: ReturnType<typeof build>, f: string) =>
  r.features.find((x) => x.feature === f)!;
const level = (r: ReturnType<typeof build>, f: string, key: string) =>
  feature(r, f).levels.find((l) => l.key === key)!;

/* ------------------------------------------------------------------ *
 * Bucketing
 * ------------------------------------------------------------------ */

describe("bucketing", () => {
  it("splits the week at Saturday", () => {
    expect(dayTypeOf(1)).toBe("weekday");
    expect(dayTypeOf(5)).toBe("weekday");
    expect(dayTypeOf(6)).toBe("weekend");
    expect(dayTypeOf(7)).toBe("weekend");
  });

  it("rejects anything that is not an ISO weekday", () => {
    expect(dayTypeOf(0)).toBeNull();
    expect(dayTypeOf(8)).toBeNull();
    expect(dayTypeOf(3.5)).toBeNull();
  });

  it("bands the day at its boundaries", () => {
    expect(hourBandOf(7)).toBe("overnight");
    expect(hourBandOf(8)).toBe("business");
    expect(hourBandOf(17)).toBe("business");
    expect(hourBandOf(18)).toBe("evening");
    expect(hourBandOf(22)).toBe("evening");
    expect(hourBandOf(23)).toBe("overnight");
    expect(hourBandOf(0)).toBe("overnight");
  });

  it("rejects anything that is not an hour", () => {
    expect(hourBandOf(24)).toBeNull();
    expect(hourBandOf(-1)).toBeNull();
    expect(hourBandOf(9.5)).toBeNull();
  });

  it("files an unattributed lead as its own level rather than dropping it", () => {
    const r = build([...group(60, 20, { campaignId: null })]);
    expect(level(r, "campaign", UNATTRIBUTED).leads).toBe(60);
  });
});

/* ------------------------------------------------------------------ *
 * Censoring
 * ------------------------------------------------------------------ */

describe("censoring", () => {
  it("🔴 counts a young lead that already converted", () => {
    /*
     * The order that matters. A lead that booked yesterday is settled however
     * young it is — testing age alone would discard the fastest-converting
     * leads from whichever segment they belong to, and the fast segments are
     * exactly what this panel is looking for.
     */
    const young = new Date(NOW.getTime() - 1 * DAY).toISOString();
    const r = build([
      lead({ leadAt: young, reached: { appointment_booked: 0.5 } }),
      lead({ leadAt: young }),
    ]);
    expect(r.judged).toBe(1);
    expect(r.converted).toBe(1);
    expect(r.maturing).toBe(1);
  });

  it("withholds a young lead that has not converted, rather than counting it as a no", () => {
    const young = new Date(NOW.getTime() - 1 * DAY).toISOString();
    const r = build([...group(40, 0, { leadAt: young })]);
    expect(r.judged).toBe(0);
    expect(r.maturing).toBe(40);
    expect(r.baseRate).toBeNull();
  });

  it("reports the maturation rule it used", () => {
    const r = build(group(40, 20));
    expect(r.maturationDays).toBeGreaterThan(0);
    expect(typeof r.maturationMeasured).toBe("boolean");
  });

  it("measures maturation from this client's own conversions once there are enough", () => {
    const fast = Array.from({ length: 20 }, () =>
      lead({ reached: { appointment_booked: 1 } }),
    );
    const r = build(fast);
    expect(r.maturationMeasured).toBe(true);
    // Every observed booking landed on day 1, so the rule collapses to ~1 day.
    expect(r.maturationDays).toBeLessThanOrEqual(2);
  });

  it("falls back to a default when too few have converted to measure", () => {
    const r = build(group(40, 1));
    expect(r.maturationMeasured).toBe(false);
  });

  it("🔴 judges a lead that has reached the maturation boundary exactly", () => {
    /*
     * The boundary is inclusive, and a mutation making it exclusive survived
     * every other test here — every fixture was either 120 days old or one day
     * old, so the edge was never touched.
     *
     * It matters because the boundary is where the whole cohort sits on any
     * account with a tight, measured maturation window: 20 conversions all
     * landing on day 1 collapse the rule to 1 day, and then "exactly one day
     * old" is a large share of the book on any given morning.
     */
    const fast = Array.from({ length: 20 }, () =>
      lead({ reached: { appointment_booked: 1 } }),
    );
    const r = build([
      ...fast,
      lead({ leadAt: new Date(NOW.getTime() - 1 * DAY).toISOString() }),
    ]);
    expect(r.maturationDays).toBe(1);
    // Exactly one day old, never converted: old enough to count as a no.
    expect(r.maturing).toBe(0);
    expect(r.judged).toBe(21);
  });
});

/* ------------------------------------------------------------------ *
 * The comparison
 * ------------------------------------------------------------------ */

describe("comparison", () => {
  it("🔴 will not judge a level below the volume floor", () => {
    const r = build([
      ...group(200, 60, { dow: 3 }),
      ...group(MIN_LEADS_PER_LEVEL - 1, 0, { dow: 6 }),
    ]);
    expect(level(r, "day_type", "weekend").verdict).toBe("not_enough");
    expect(level(r, "day_type", "weekend").probability).toBeNull();
    // The counts still render — hiding them would make the tool look like it
    // knows less than it does.
    expect(level(r, "day_type", "weekend").leads).toBe(MIN_LEADS_PER_LEVEL - 1);
  });

  it("will not judge a level whose REMAINDER is below the floor", () => {
    const r = build([
      ...group(200, 60, { dow: 3 }),
      ...group(MIN_LEADS_PER_LEVEL - 1, 20, { dow: 6 }),
    ]);
    expect(level(r, "day_type", "weekday").verdict).toBe("not_enough");
  });

  it("judges at the floor exactly", () => {
    const r = build([
      ...group(MIN_LEADS_PER_LEVEL, 1, { dow: 6 }),
      ...group(MIN_LEADS_PER_LEVEL, 20, { dow: 3 }),
    ]);
    expect(level(r, "day_type", "weekend").verdict).not.toBe("not_enough");
  });

  it("calls a genuinely worse segment worse", () => {
    const r = build([
      ...group(200, 80, { dow: 3 }),
      ...group(100, 8, { dow: 6 }),
    ]);
    const weekend = level(r, "day_type", "weekend");
    expect(weekend.verdict).toBe("worse");
    expect(weekend.probability!).toBeLessThanOrEqual(1 - CONFIDENT);
    expect(weekend.rate).toBeCloseTo(0.08, 6);
    expect(weekend.restRate).toBeCloseTo(0.4, 6);
  });

  it("calls a genuinely better segment better", () => {
    const r = build([
      ...group(200, 20, { dow: 3 }),
      ...group(100, 60, { dow: 6 }),
    ]);
    expect(level(r, "day_type", "weekend").verdict).toBe("better");
  });

  it("🔴 calls two similar segments the same rather than ranking them", () => {
    // 30% against 32% on good volume is not a finding, and presenting it as one
    // is how a client is talked into moving budget on noise.
    const r = build([
      ...group(300, 90, { dow: 3 }),
      ...group(300, 96, { dow: 6 }),
    ]);
    expect(level(r, "day_type", "weekend").verdict).toBe("same");
    expect(feature(r, "day_type").verdict).toBe("no_difference");
    expect(r.signals).toEqual([]);
  });

  it("🔴 compares against the rest of the feature, not the base rate", () => {
    /*
     * A level holding most of the volume would otherwise be compared with a
     * near-copy of itself: the base rate contains it. That makes the segment a
     * client cares most about the one segment the comparison can never judge.
     */
    const r = build([
      ...group(400, 160, { dow: 3 }),
      ...group(40, 2, { dow: 6 }),
    ]);
    const weekday = level(r, "day_type", "weekday");
    expect(weekday.restRate).toBeCloseTo(0.05, 6);
    expect(weekday.verdict).toBe("better");
  });

  it("keeps a level's own counts separate from the remainder's", () => {
    const r = build([...group(100, 30, { dow: 3 }), ...group(60, 6, { dow: 6 })]);
    const weekend = level(r, "day_type", "weekend");
    expect(weekend.leads).toBe(60);
    expect(weekend.converted).toBe(6);
    expect(weekend.restLeads).toBe(100);
  });
});

/* ------------------------------------------------------------------ *
 * Feature verdicts and signals
 * ------------------------------------------------------------------ */

describe("features and signals", () => {
  it("reports every feature, even ones with nothing to say", () => {
    const r = build(group(60, 20));
    expect(r.features.map((f) => f.feature)).toEqual([
      "day_type",
      "hour_band",
      "campaign",
    ]);
  });

  it("🔴 marks a feature as differing when one of its levels does", () => {
    // Asserted directly: the roll-up from level verdicts to the feature verdict
    // had no test of its positive case, so a feature could have stopped
    // reporting `differs` while every level below it still said `worse`.
    const r = build([
      ...group(200, 80, { dow: 3 }),
      ...group(100, 8, { dow: 6 }),
    ]);
    expect(level(r, "day_type", "weekend").verdict).toBe("worse");
    expect(feature(r, "day_type").verdict).toBe("differs");
  });

  it("marks a feature not_enough when no level clears the floor", () => {
    const r = build(group(10, 3));
    expect(feature(r, "day_type").verdict).toBe("not_enough");
  });

  it("promotes only judged differences into signals", () => {
    const r = build([
      ...group(200, 80, { dow: 3, hour: 10 }),
      ...group(100, 8, { dow: 6, hour: 10 }),
    ]);
    expect(r.signals.map((s) => s.key)).toContain("weekend");
    expect(r.signals.every((s) => s.direction === "better" || s.direction === "worse")).toBe(true);
  });

  it("🔴 orders signals by the size of the gap, not by feature order", () => {
    // A reader takes the top line as the finding.
    const r = build([
      // Day type: a small gap. Hour band: a large one.
      ...group(150, 60, { dow: 3, hour: 10 }),
      ...group(150, 51, { dow: 6, hour: 10 }),
      ...group(150, 3, { dow: 3, hour: 2 }),
    ]);
    const gaps = r.signals.map((s) => Math.abs(s.rate - s.restRate));
    expect(gaps).toEqual([...gaps].sort((a, b) => b - a));
    expect(r.signals[0].feature).toBe("hour_band");
  });

  it("sorts campaign levels by volume, biggest first", () => {
    const r = build([
      ...group(40, 10, { campaignId: "small" }),
      ...group(200, 60, { campaignId: "big" }),
      ...group(90, 20, { campaignId: "mid" }),
    ]);
    expect(feature(r, "campaign").levels.map((l) => l.key)).toEqual([
      "big",
      "mid",
      "small",
    ]);
  });

  it("labels a campaign by name when one is known and by id when it is not", () => {
    const r = buildQuality(
      [...group(60, 20, { campaignId: "c_1" }), ...group(60, 20, { campaignId: "c_2" })],
      {
        stage: "appointment_booked",
        asOf: NOW,
        campaignNames: { c_1: "Leads | GG" },
      },
    );
    const levels = feature(r, "campaign").levels;
    expect(levels.find((l) => l.key === "c_1")!.label).toBe("Leads | GG");
    expect(levels.find((l) => l.key === "c_2")!.label).toBe("c_2");
  });
});

/* ------------------------------------------------------------------ *
 * Degenerate input
 * ------------------------------------------------------------------ */

describe("nothing to report", () => {
  it("survives an empty book", () => {
    const r = build([]);
    expect(r.judged).toBe(0);
    expect(r.baseRate).toBeNull();
    expect(r.signals).toEqual([]);
    expect(r.features.every((f) => f.verdict === "not_enough")).toBe(true);
  });

  it("gives a rate of null rather than zero when nothing was judged", () => {
    const r = build([]);
    expect(level(r, "day_type", "weekday").rate).toBeNull();
    expect(level(r, "day_type", "weekday").restRate).toBeNull();
  });

  it("does not fall over on an unparseable arrival time", () => {
    const r = build([lead({ leadAt: "not a date" })]);
    // NaN age fails the maturity test, so the lead is withheld, not counted.
    expect(r.maturing).toBe(1);
    expect(r.judged).toBe(0);
  });

  it("files a lead with an impossible weekday or hour under no level", () => {
    const r = build(group(60, 20, { dow: 99, hour: 99 }));
    expect(level(r, "day_type", "weekday").leads).toBe(0);
    expect(level(r, "day_type", "weekend").leads).toBe(0);
    expect(level(r, "hour_band", "business").leads).toBe(0);
    // It is still judged overall — only its bucketing is unknown.
    expect(r.judged).toBe(60);
  });

  it("computes a different stage's outcome from the same leads", () => {
    const leads = [
      ...Array.from({ length: 60 }, () =>
        lead({ reached: { appointment_booked: 2, closed_won: 9 } }),
      ),
      ...Array.from({ length: 60 }, () => lead({ reached: { appointment_booked: 2 } })),
    ];
    expect(build(leads, "appointment_booked").converted).toBe(120);
    expect(build(leads, "closed_won").converted).toBe(60);
  });
});

describe("describeSignal", () => {
  it("reads as a sentence with the counts behind it", () => {
    const r = build([
      ...group(200, 80, { dow: 3 }),
      ...group(100, 8, { dow: 6 }),
    ]);
    const s = r.signals.find((x) => x.key === "weekend")!;
    expect(describeSignal(s, "appointment_booked")).toBe(
      "Weekend leads booked 8% of the time, against 40% for the rest — 8 of 100 appointments.",
    );
  });
});
