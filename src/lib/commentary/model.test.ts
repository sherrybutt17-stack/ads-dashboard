import { describe, it, expect } from "vitest";
import type { PeriodMetrics } from "@/lib/metrics/queries";
import {
  defaultDirection,
  describeTarget,
  formatMetricValue,
  isEmptyCommentary,
  isTargetMetric,
  isValidMonthKey,
  judgeTarget,
  monthBounds,
  monthKeyForDateKey,
  monthLabel,
  nextMonthKey,
  orphanedOutcomes,
  parseCommitments,
  parseOutcomes,
  parseTarget,
  previousMonthKey,
  resolveAccountability,
  targetThreshold,
  MAX_COMMITMENTS,
  MAX_COMMITMENT_CHARS,
  TARGET_METRICS,
  TARGET_METRIC_DEFS,
  type Commitment,
  type CommitmentTarget,
  type MetricSource,
  type Outcome,
} from "./model";

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const actuals = (over: Partial<MetricSource> = {}): MetricSource => ({
  funnel: { new_lead: 20, appointment_booked: 7, showed: 4, closed_won: 2 },
  ads: { spend: 940 },
  revenue: { revenue: 18_400 },
  derived: {
    cpLead: 47,
    cpAppt: 134.29,
    cpWon: 470,
    bookPct: 0.35,
    showPct: 4 / 7,
    closePct: 0.5,
    ctr: 0.0212,
    cpc: 1.4,
    cpm: 12.5,
    roas: 19.57,
  },
  ...over,
});

const commit = (over: Partial<Commitment> = {}): Commitment => ({
  id: "c1",
  text: "Rebuild the top-of-funnel creative",
  target: null,
  ...over,
});

const target = (over: Partial<CommitmentTarget> = {}): CommitmentTarget => ({
  metric: "cpLead",
  direction: "at_most",
  value: 40,
  ...over,
});

/* ------------------------------------------------------------------ *
 * Month keys
 * ------------------------------------------------------------------ */

describe("month keys", () => {
  it("steps back and forward across a year boundary", () => {
    expect(previousMonthKey("2026-01")).toBe("2025-12");
    expect(nextMonthKey("2025-12")).toBe("2026-01");
    expect(previousMonthKey("2026-08")).toBe("2026-07");
    expect(nextMonthKey("2026-08")).toBe("2026-09");
  });

  it("keeps the two-digit padding", () => {
    expect(previousMonthKey("2026-10")).toBe("2026-09");
    expect(nextMonthKey("2026-09")).toBe("2026-10");
  });

  it("round-trips through both directions for every month of a year", () => {
    for (let m = 1; m <= 12; m++) {
      const key = `2026-${String(m).padStart(2, "0")}`;
      expect(nextMonthKey(previousMonthKey(key))).toBe(key);
      expect(previousMonthKey(nextMonthKey(key))).toBe(key);
    }
  });

  it("validates the format strictly", () => {
    expect(isValidMonthKey("2026-08")).toBe(true);
    expect(isValidMonthKey("2026-13")).toBe(false);
    expect(isValidMonthKey("2026-00")).toBe(false);
    expect(isValidMonthKey("2026-8")).toBe(false);
    expect(isValidMonthKey("26-08")).toBe(false);
    expect(isValidMonthKey("2026-08-01")).toBe(false);
    expect(isValidMonthKey(null)).toBe(false);
    expect(isValidMonthKey(202608)).toBe(false);
  });

  it("labels a month for a reader", () => {
    expect(monthLabel("2026-08")).toBe("August 2026");
    expect(monthLabel("2025-12")).toBe("December 2025");
    expect(monthLabel("2026-01")).toBe("January 2026");
  });

  it("takes the month from a date key by position, not by parsing a Date", () => {
    // The whole point: no `new Date()` anywhere near this, so a host in any
    // timezone answers the same.
    expect(monthKeyForDateKey("2026-08-01")).toBe("2026-08");
    expect(monthKeyForDateKey("2026-08-31")).toBe("2026-08");
  });

  it("bounds every month, including leap-year February", () => {
    expect(monthBounds("2026-08")).toEqual({ startKey: "2026-08-01", endKey: "2026-08-31" });
    expect(monthBounds("2026-04")).toEqual({ startKey: "2026-04-01", endKey: "2026-04-30" });
    expect(monthBounds("2026-02").endKey).toBe("2026-02-28");
    expect(monthBounds("2024-02").endKey).toBe("2024-02-29");
    // The century rules, both ways round.
    expect(monthBounds("2100-02").endKey).toBe("2100-02-28");
    expect(monthBounds("2000-02").endKey).toBe("2000-02-29");
  });

  it("bounds each month at its real length across a whole year", () => {
    const lengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    lengths.forEach((len, i) => {
      const key = `2026-${String(i + 1).padStart(2, "0")}`;
      expect(monthBounds(key).endKey).toBe(`${key}-${String(len).padStart(2, "0")}`);
    });
  });
});

/* ------------------------------------------------------------------ *
 * Metric definitions
 * ------------------------------------------------------------------ */

describe("target metrics", () => {
  it("every listed metric has a definition keyed to itself", () => {
    for (const m of TARGET_METRICS) {
      expect(TARGET_METRIC_DEFS[m]).toBeDefined();
      expect(TARGET_METRIC_DEFS[m].key).toBe(m);
      expect(TARGET_METRIC_DEFS[m].label.length).toBeGreaterThan(0);
    }
  });

  it("every metric reads a real figure out of a populated month", () => {
    const m = actuals();
    for (const key of TARGET_METRICS) {
      const value = TARGET_METRIC_DEFS[key].read(m);
      expect(value, `${key} read nothing`).not.toBeNull();
      expect(Number.isFinite(value as number)).toBe(true);
    }
  });

  it("reads null rather than throwing when a figure is absent", () => {
    const blank = actuals({
      revenue: null,
      derived: { ...actuals().derived, cpLead: null, roas: null },
    });
    expect(TARGET_METRIC_DEFS.revenue.read(blank)).toBeNull();
    expect(TARGET_METRIC_DEFS.cpLead.read(blank)).toBeNull();
    expect(TARGET_METRIC_DEFS.roas.read(blank)).toBeNull();
  });

  it("guards the membership test", () => {
    expect(isTargetMetric("cpLead")).toBe(true);
    expect(isTargetMetric("reach")).toBe(false);
    expect(isTargetMetric(null)).toBe(false);
  });

  it("defaults a cost target downward and a volume target upward", () => {
    expect(defaultDirection("cpLead")).toBe("at_most");
    expect(defaultDirection("cpAppt")).toBe("at_most");
    expect(defaultDirection("cpc")).toBe("at_most");
    expect(defaultDirection("leads")).toBe("at_least");
    expect(defaultDirection("won")).toBe("at_least");
    expect(defaultDirection("bookPct")).toBe("at_least");
    expect(defaultDirection("roas")).toBe("at_least");
    // Genuinely neutral — a target on spend is nearly always a budget.
    expect(defaultDirection("spend")).toBe("at_most");
  });

  it("PeriodMetrics satisfies MetricSource", () => {
    // A compile-time assertion in a runtime test: if `PeriodMetrics` ever loses
    // or renames a field this file reads, the typecheck fails here rather than
    // this module silently widening to accept less.
    const widen = (p: PeriodMetrics): MetricSource => p;
    expect(typeof widen).toBe("function");
  });
});

/* ------------------------------------------------------------------ *
 * Judging a target — the arithmetic nobody may overrule
 * ------------------------------------------------------------------ */

describe("judgeTarget", () => {
  it("meets an at-most target that came in under", () => {
    const r = judgeTarget(target({ value: 60 }), actuals());
    expect(r.status).toBe("met");
    expect(r.actual).toBe(47);
  });

  it("misses an at-most target that came in over", () => {
    const r = judgeTarget(target({ value: 40 }), actuals());
    expect(r.status).toBe("missed");
    expect(r.actual).toBe(47);
  });

  it("meets an at-least target that came in above", () => {
    const r = judgeTarget(
      target({ metric: "leads", direction: "at_least", value: 15 }),
      actuals(),
    );
    expect(r.status).toBe("met");
    expect(r.actual).toBe(20);
  });

  it("misses an at-least target that came in below", () => {
    const r = judgeTarget(
      target({ metric: "leads", direction: "at_least", value: 25 }),
      actuals(),
    );
    expect(r.status).toBe("missed");
  });

  it("treats landing exactly on the line as met, both directions", () => {
    expect(judgeTarget(target({ value: 47 }), actuals()).status).toBe("met");
    expect(
      judgeTarget(
        target({ metric: "leads", direction: "at_least", value: 20 }),
        actuals(),
      ).status,
    ).toBe("met");
  });

  it("🔴 lands the percentage knife-edge the right way, at least", () => {
    /*
     * The trap this whole `targetThreshold` design exists for, with the exact
     * numbers that trigger it.
     *
     * 29 booked out of 100 leads is a booking rate of 29%. Scaling that ratio UP
     * to compare against a target of 29 gives 28.999999999999996 — so a month
     * that hit its target exactly would be reported to the client as MISSED.
     * Scaling the TARGET down instead compares 0.29 against 0.29 and gets it
     * right. A sweep of every n/d with d ≤ 400 finds 70 such pairs; this is one.
     */
    expect(29 / 100 >= 29).toBe(false); // not the comparison — units differ
    expect((29 / 100) * 100 >= 29).toBe(false); // 🔴 the bug, made visible
    expect(29 / 100 >= targetThreshold(target({ metric: "bookPct", value: 29 }))).toBe(true);

    const exact = judgeTarget(
      target({ metric: "bookPct", direction: "at_least", value: 29 }),
      actuals({ derived: { ...actuals().derived, bookPct: 29 / 100 } }),
    );
    expect(exact.status).toBe("met");
    expect(exact.actual).toBe(0.29);

    const under = judgeTarget(
      target({ metric: "bookPct", direction: "at_least", value: 29 }),
      actuals({ derived: { ...actuals().derived, bookPct: 28 / 100 } }),
    );
    expect(under.status).toBe("missed");
  });

  it("🔴 lands the percentage knife-edge the right way, at most", () => {
    // The mirror hazard, which rounds the other way: 7/25 is a 28% show rate,
    // and scaling it up gives 28.000000000000004 — so "at most 28%" would be
    // reported as missed on a month that met it exactly.
    expect((7 / 25) * 100 <= 28).toBe(false); // 🔴 the bug, made visible
    const exact = judgeTarget(
      target({ metric: "showPct", direction: "at_most", value: 28 }),
      actuals({ derived: { ...actuals().derived, showPct: 7 / 25 } }),
    );
    expect(exact.status).toBe("met");
  });

  it("scales a percentage target rather than comparing raw units", () => {
    // 30% target against a 35% month. Comparing 30 against 0.35 unscaled would
    // call it missed.
    expect(
      judgeTarget(
        target({ metric: "bookPct", direction: "at_least", value: 30 }),
        actuals(),
      ).status,
    ).toBe("met");
  });

  it("reports an absent figure as unmeasurable, never as missed", () => {
    const noRevenue = actuals({
      revenue: null,
      derived: { ...actuals().derived, roas: null },
    });
    const r = judgeTarget(
      target({ metric: "roas", direction: "at_least", value: 3 }),
      noRevenue,
    );
    expect(r.status).toBe("unmeasurable");
    expect(r.actual).toBeNull();
  });

  it("reports unmeasurable when the figures could not be loaded at all", () => {
    // 🔴 A database that was unreachable is not an agency that failed.
    expect(judgeTarget(target(), null).status).toBe("unmeasurable");
  });

  it("refuses a non-finite figure rather than judging against it", () => {
    const broken = actuals({
      derived: { ...actuals().derived, cpLead: Number.POSITIVE_INFINITY },
    });
    expect(judgeTarget(target(), broken).status).toBe("unmeasurable");
    const nan = actuals({ derived: { ...actuals().derived, cpLead: NaN } });
    expect(judgeTarget(target(), nan).status).toBe("unmeasurable");
  });

  it("judges a zero actual as a real figure, not as absent", () => {
    // $0 spend is a fact about the month. Treating it as "no data" would let a
    // paused account quietly satisfy every cost target.
    const paused = actuals({
      ads: { spend: 0 },
      derived: { ...actuals().derived, cpLead: 0 },
    });
    const r = judgeTarget(target({ metric: "spend", value: 500 }), paused);
    expect(r.status).toBe("met");
    expect(r.actual).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */

describe("formatting", () => {
  it("renders each metric in its own units", () => {
    expect(formatMetricValue("cpLead", 47, "USD")).toBe("$47.00");
    expect(formatMetricValue("leads", 20)).toBe("20");
    expect(formatMetricValue("bookPct", 0.35)).toBe("35.0%");
    expect(formatMetricValue("roas", 3.4)).toBe("3.4×");
  });

  it("renders an absent figure as a dash", () => {
    expect(formatMetricValue("cpLead", null)).toBe("–");
    expect(formatMetricValue("bookPct", null)).toBe("–");
  });

  it("respects the client's currency", () => {
    expect(formatMetricValue("cpLead", 47, "GBP")).toBe("£47.00");
  });

  it("describes a target in the same units it will be judged in", () => {
    expect(describeTarget(target({ value: 40 }), "USD")).toBe(
      "Cost per lead at most $40.00",
    );
    expect(
      describeTarget(target({ metric: "bookPct", direction: "at_least", value: 35 })),
    ).toBe("Booking rate at least 35.0%");
    expect(
      describeTarget(target({ metric: "leads", direction: "at_least", value: 25 })),
    ).toBe("Leads at least 25");
  });
});

/* ------------------------------------------------------------------ *
 * The accountability resolution
 * ------------------------------------------------------------------ */

describe("resolveAccountability", () => {
  const base = {
    priorMonth: "2026-07",
    outcomes: [] as Outcome[],
    actuals: actuals(),
  };

  it("🔴 ignores a stated verdict on a commitment that carries a number", () => {
    /*
     * THE test. An agency that promised cost per lead under $40, delivered $47,
     * and ticked "Done" must still read as Missed. If this ever passes the other
     * way the feature has become a laundering tool.
     */
    const c = commit({ target: target({ value: 40 }) });
    const r = resolveAccountability({
      ...base,
      priorCommitments: [c],
      outcomes: [{ commitmentId: "c1", verdict: "done", note: "" }],
    });
    expect(r.items[0].status).toBe("missed");
    expect(r.items[0].actual).toBe(47);
    expect(r.counts.done).toBe(0);
    expect(r.counts.missed).toBe(1);
  });

  it("keeps the note on a commitment whose verdict was derived", () => {
    // A person may not overrule the number, but they may explain it.
    const r = resolveAccountability({
      ...base,
      priorCommitments: [commit({ target: target({ value: 40 }) })],
      outcomes: [
        { commitmentId: "c1", verdict: "done", note: "Includes a $900 test budget." },
      ],
    });
    expect(r.items[0].status).toBe("missed");
    expect(r.items[0].note).toBe("Includes a $900 test budget.");
  });

  it("reports an unanswered commitment as unanswered rather than dropping it", () => {
    const r = resolveAccountability({ ...base, priorCommitments: [commit()] });
    expect(r.items).toHaveLength(1);
    expect(r.items[0].status).toBe("unanswered");
    expect(r.unanswered).toBe(1);
    expect(r.answered).toBe(0);
    expect(r.total).toBe(1);
  });

  it("takes a person's verdict when no number was attached", () => {
    for (const verdict of ["done", "partly", "not_done", "dropped"] as const) {
      const r = resolveAccountability({
        ...base,
        priorCommitments: [commit()],
        outcomes: [{ commitmentId: "c1", verdict, note: "" }],
      });
      expect(r.items[0].status).toBe(verdict);
      expect(r.unanswered).toBe(0);
    }
  });

  it("carries no actual on an untargeted commitment", () => {
    const r = resolveAccountability({
      ...base,
      priorCommitments: [commit()],
      outcomes: [{ commitmentId: "c1", verdict: "done", note: "" }],
    });
    expect(r.items[0].actual).toBeNull();
  });

  it("counts a mixed month correctly", () => {
    const r = resolveAccountability({
      ...base,
      priorCommitments: [
        commit({ id: "a", target: target({ value: 60 }) }), // met
        commit({ id: "b", target: target({ value: 40 }) }), // missed
        commit({ id: "c", target: target({ metric: "roas", value: 3, direction: "at_least" }) }),
        commit({ id: "d" }), // answered
        commit({ id: "e" }), // unanswered
      ],
      outcomes: [{ commitmentId: "d", verdict: "partly", note: "Half of it." }],
      actuals: actuals({
        revenue: null,
        derived: { ...actuals().derived, roas: null },
      }),
    });
    expect(r.counts).toEqual({
      met: 1, missed: 1, unmeasurable: 1,
      done: 0, partly: 1, not_done: 0, dropped: 0, unanswered: 1,
    });
    expect(r.total).toBe(5);
    expect(r.unanswered).toBe(1);
    expect(r.answered).toBe(4);
  });

  it("preserves the order the commitments were written in", () => {
    const r = resolveAccountability({
      ...base,
      priorCommitments: [commit({ id: "z" }), commit({ id: "a" }), commit({ id: "m" })],
    });
    expect(r.items.map((i) => i.commitment.id)).toEqual(["z", "a", "m"]);
  });

  it("ignores an answer pointing at a commitment that is not in the plan", () => {
    const r = resolveAccountability({
      ...base,
      priorCommitments: [commit({ id: "a" })],
      outcomes: [{ commitmentId: "ghost", verdict: "done", note: "x" }],
    });
    expect(r.items).toHaveLength(1);
    expect(r.items[0].status).toBe("unanswered");
  });

  it("marks every target unmeasurable when the figures are missing entirely", () => {
    const r = resolveAccountability({
      ...base,
      priorCommitments: [
        commit({ id: "a", target: target({ value: 40 }) }),
        commit({ id: "b", target: target({ metric: "leads", value: 5, direction: "at_least" }) }),
      ],
      actuals: null,
    });
    expect(r.counts.unmeasurable).toBe(2);
    expect(r.counts.missed).toBe(0);
  });

  it("handles an empty plan without inventing anything", () => {
    const r = resolveAccountability({ ...base, priorCommitments: [] });
    expect(r.items).toHaveLength(0);
    expect(r.total).toBe(0);
    expect(r.unanswered).toBe(0);
    expect(r.answered).toBe(0);
  });

  it("keeps the month it is reporting on", () => {
    const r = resolveAccountability({ ...base, priorCommitments: [commit()] });
    expect(r.priorMonth).toBe("2026-07");
  });

  it("trims whitespace out of a note so a blank one reads as absent", () => {
    const r = resolveAccountability({
      ...base,
      priorCommitments: [commit()],
      outcomes: [{ commitmentId: "c1", verdict: "done", note: "   " }],
    });
    expect(r.items[0].note).toBe("");
  });
});

/* ------------------------------------------------------------------ *
 * Parsing — lenient on read
 * ------------------------------------------------------------------ */

describe("parseCommitments", () => {
  it("reads a well-formed list", () => {
    const list = parseCommitments([
      { id: "a", text: "Do the thing", target: null },
      { id: "b", text: "Do the other", target: { metric: "cpLead", direction: "at_most", value: 40 } },
    ]);
    expect(list).toHaveLength(2);
    expect(list[1].target).toEqual({ metric: "cpLead", direction: "at_most", value: 40 });
  });

  it("returns an empty list for anything that is not an array", () => {
    for (const junk of [null, undefined, {}, "[]", 7, true]) {
      expect(parseCommitments(junk)).toEqual([]);
    }
  });

  it("drops entries with no id or no text", () => {
    const list = parseCommitments([
      { id: "", text: "x" },
      { id: "a", text: "" },
      { id: "b", text: "   " },
      { text: "no id" },
      { id: "c" },
      null,
      "string",
      { id: "d", text: "keeper" },
    ]);
    expect(list.map((c) => c.id)).toEqual(["d"]);
  });

  it("🔴 drops a duplicate id rather than keeping both", () => {
    /*
     * Two commitments sharing an id would make next month's answer ambiguous —
     * one note would attach to both, and a reader would see a verdict against a
     * promise nobody judged.
     */
    const list = parseCommitments([
      { id: "a", text: "first" },
      { id: "a", text: "second" },
    ]);
    expect(list).toHaveLength(1);
    expect(list[0].text).toBe("first");
  });

  it("caps the list rather than accepting an unbounded one", () => {
    const many = Array.from({ length: MAX_COMMITMENTS + 5 }, (_, i) => ({
      id: `c${i}`,
      text: `line ${i}`,
    }));
    expect(parseCommitments(many)).toHaveLength(MAX_COMMITMENTS);
  });

  it("truncates over-long text instead of rejecting the row", () => {
    const list = parseCommitments([{ id: "a", text: "x".repeat(MAX_COMMITMENT_CHARS + 50) }]);
    expect(list[0].text).toHaveLength(MAX_COMMITMENT_CHARS);
  });

  it("keeps a commitment whose target is junk, with no target", () => {
    // The line someone wrote survives; only the unreadable number is dropped.
    const list = parseCommitments([
      { id: "a", text: "Do the thing", target: { metric: "made_up", direction: "at_most", value: 1 } },
    ]);
    expect(list).toHaveLength(1);
    expect(list[0].target).toBeNull();
  });
});

describe("parseTarget", () => {
  it("accepts a well-formed target", () => {
    expect(parseTarget({ metric: "cpLead", direction: "at_most", value: 40 })).toEqual({
      metric: "cpLead", direction: "at_most", value: 40,
    });
  });

  it("coerces a numeric string, because jsonb round-trips are not guaranteed", () => {
    expect(parseTarget({ metric: "leads", direction: "at_least", value: "25" })?.value).toBe(25);
  });

  it("rejects an unknown metric, an unknown direction and a non-number", () => {
    expect(parseTarget({ metric: "reach", direction: "at_most", value: 1 })).toBeNull();
    expect(parseTarget({ metric: "cpLead", direction: "under", value: 1 })).toBeNull();
    expect(parseTarget({ metric: "cpLead", direction: "at_most", value: "many" })).toBeNull();
    expect(parseTarget({ metric: "cpLead", direction: "at_most", value: Infinity })).toBeNull();
    expect(parseTarget(null)).toBeNull();
    expect(parseTarget("cpLead")).toBeNull();
  });
});

describe("parseOutcomes", () => {
  it("reads a well-formed list", () => {
    expect(parseOutcomes([{ commitmentId: "a", verdict: "done", note: "yes" }])).toEqual([
      { commitmentId: "a", verdict: "done", note: "yes" },
    ]);
  });

  it("drops an unrecognised verdict rather than defaulting it", () => {
    // Defaulting would put a verdict nobody chose against a real promise.
    expect(parseOutcomes([{ commitmentId: "a", verdict: "sort_of" }])).toEqual([]);
    expect(parseOutcomes([{ commitmentId: "a" }])).toEqual([]);
  });

  it("drops a duplicate answer for one commitment", () => {
    const list = parseOutcomes([
      { commitmentId: "a", verdict: "done", note: "first" },
      { commitmentId: "a", verdict: "not_done", note: "second" },
    ]);
    expect(list).toHaveLength(1);
    expect(list[0].note).toBe("first");
  });

  it("defaults a missing note to empty rather than dropping the answer", () => {
    expect(parseOutcomes([{ commitmentId: "a", verdict: "dropped" }])[0].note).toBe("");
  });

  it("returns an empty list for anything that is not an array", () => {
    expect(parseOutcomes(null)).toEqual([]);
    expect(parseOutcomes({ commitmentId: "a", verdict: "done" })).toEqual([]);
  });
});

describe("orphanedOutcomes", () => {
  it("names answers whose commitment is gone", () => {
    const orphans = orphanedOutcomes(
      [
        { commitmentId: "a", verdict: "done", note: "" },
        { commitmentId: "gone", verdict: "done", note: "kept" },
      ],
      [commit({ id: "a" })],
    );
    expect(orphans.map((o) => o.commitmentId)).toEqual(["gone"]);
  });

  it("is empty when every answer still has a home", () => {
    expect(
      orphanedOutcomes([{ commitmentId: "a", verdict: "done", note: "" }], [commit({ id: "a" })]),
    ).toEqual([]);
  });
});

describe("isEmptyCommentary", () => {
  it("is true only when nothing at all has been written", () => {
    expect(isEmptyCommentary({ did: "", commitments: [], outcomes: [] })).toBe(true);
    expect(isEmptyCommentary({ did: "   \n ", commitments: [], outcomes: [] })).toBe(true);
    expect(isEmptyCommentary({ did: "x", commitments: [], outcomes: [] })).toBe(false);
    expect(isEmptyCommentary({ did: "", commitments: [commit()], outcomes: [] })).toBe(false);
    expect(
      isEmptyCommentary({
        did: "",
        commitments: [],
        outcomes: [{ commitmentId: "a", verdict: "done", note: "" }],
      }),
    ).toBe(false);
  });
});
