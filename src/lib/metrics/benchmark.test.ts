import { describe, it, expect } from "vitest";
import {
  benchmarkSegment,
  noiseFloor,
  MIN_NOTABLE_GAP,
  SURPRISING_ZERO_EXPECTED,
} from "./benchmark";

/*
 * The whole risk in this module is a chip that fires on noise.
 *
 * A breakdown panel splits tens of leads a month across up to dozens of rows,
 * so most segments hold one or two leads and their cost per lead is mostly
 * chance. A marker that shouts on those rows sends someone to switch off a
 * region for a reason that does not exist — a worse outcome than the column of
 * unannotated numbers it replaced, because it carries the authority of a
 * verdict.
 */

describe("noiseFloor", () => {
  it("shrinks as the lead count grows", () => {
    expect(noiseFloor(1)).toBeCloseTo(1);
    expect(noiseFloor(4)).toBeCloseTo(0.5);
    expect(noiseFloor(25)).toBeCloseTo(0.2);
    expect(noiseFloor(100)).toBeCloseTo(0.1);
  });

  it("is infinite with no leads, so nothing can clear it by ratio", () => {
    // The zero case is answered by expected-count, not by a ratio — there is no
    // cost per lead to compare. Returning a finite floor here would let
    // `benchmarkSegment` fall into the ratio branch and divide by zero.
    expect(noiseFloor(0)).toBe(Number.POSITIVE_INFINITY);
    expect(noiseFloor(-3)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("benchmarkSegment", () => {
  it("flags a segment that is clearly dearer than its panel", () => {
    // $400 for 10 leads = $40 each, against a $10 panel: 4× the average, and
    // ten leads is well past the point where that could be luck.
    const b = benchmarkSegment(400, 10, 10);
    expect(b.verdict).toBe("costlier");
    if (b.verdict === "costlier") expect(b.gap).toBeCloseTo(3);
  });

  it("flags a segment that is clearly cheaper", () => {
    // $50 for 10 leads = $5 each, against $10: half the panel average.
    const b = benchmarkSegment(50, 10, 10);
    expect(b.verdict).toBe("cheaper");
    if (b.verdict === "cheaper") expect(b.gap).toBeCloseTo(-0.5);
  });

  it("🔴 stays silent on a small segment whose gap is inside its own noise", () => {
    /*
     * THE assertion for this module. One lead at $18 against a $10 panel looks
     * 80% overpriced and is nothing of the sort — a single arrival either side
     * moves that figure further than the gap being reported. The old panel left
     * this to the reader's judgement; the danger in adding a marker is that it
     * removes the judgement and keeps the noise.
     */
    const b = benchmarkSegment(18, 1, 10);
    expect(b.verdict).toBe("none");
  });

  it("🔴 flags the SAME gap once the segment is big enough to mean it", () => {
    // Same 80% gap, now across 25 leads ($450 for 25 = $18 each). The noise
    // floor is 20% there, so the finding survives. Without this pair the test
    // above would also pass on a module that never flags anything.
    const b = benchmarkSegment(450, 25, 10);
    expect(b.verdict).toBe("costlier");
    if (b.verdict === "costlier") expect(b.gap).toBeCloseTo(0.8);
  });

  it("stays silent on a gap too small to act on, however many leads back it", () => {
    // 10% off the average across 400 leads: trustworthy, and still not a
    // decision. Flagging it trains people to ignore the column.
    const b = benchmarkSegment(1_100, 100, 10);
    expect(noiseFloor(100)).toBeLessThan(MIN_NOTABLE_GAP);
    expect(b.verdict).toBe("none");
  });

  it("🔴 calls out spend that bought nothing, where the cost per lead is blank", () => {
    /*
     * The row most worth reading is the one whose CP-Lead cell is empty:
     * dividing by zero leaves a dash exactly where the worst number in the
     * panel belongs, so pure waste renders as "no data".
     */
    const b = benchmarkSegment(100, 0, 10); // 10 leads expected, none arrived
    expect(b.verdict).toBe("no_leads");
    if (b.verdict === "no_leads") expect(b.expectedLeads).toBeCloseTo(10);
  });

  it("does not call out a zero-lead segment that barely spent anything", () => {
    // $12 against a $10 panel expects roughly one lead. Seeing none is an
    // ordinary short run, not a finding, and marking it red would put the
    // smallest row in the panel at the top of someone's attention.
    const b = benchmarkSegment(12, 0, 10);
    expect(b.verdict).toBe("none");
  });

  it("puts the zero-lead threshold at the documented expected count", () => {
    const panel = 10;
    const justUnder = benchmarkSegment((SURPRISING_ZERO_EXPECTED - 0.1) * panel, 0, panel);
    const justOver = benchmarkSegment((SURPRISING_ZERO_EXPECTED + 0.1) * panel, 0, panel);
    expect(justUnder.verdict).toBe("none");
    expect(justOver.verdict).toBe("no_leads");
  });

  it("says nothing when the panel produced no leads to average", () => {
    // Every segment would otherwise be judged against a baseline that does not
    // exist, and a whole panel of red would be the result.
    expect(benchmarkSegment(500, 0, null).verdict).toBe("none");
    expect(benchmarkSegment(500, 3, 0).verdict).toBe("none");
  });

  it("says nothing about a segment that did not spend", () => {
    // Zero spend and some leads is the organic/rounding case. "Infinitely
    // cheap" is not a finding about the ads.
    expect(benchmarkSegment(0, 5, 10).verdict).toBe("none");
  });

  it("survives the values a bad sync can produce, without throwing", () => {
    for (const [spend, leads, panel] of [
      [NaN, 5, 10],
      [100, NaN, 10],
      [100, 5, NaN],
      [Infinity, 5, 10],
      [-50, 5, 10],
      [100, -5, 10],
      [100, 5, -10],
    ] as const) {
      expect(() => benchmarkSegment(spend, leads, panel)).not.toThrow();
      expect(benchmarkSegment(spend, leads, panel).verdict).toBe("none");
    }
  });

  it("🔴 signs the gap the way the metric actually runs", () => {
    /*
     * Cost per lead FALLS when things go well. A positive gap therefore has to
     * mean worse, and the component paints on that sign — get it backwards and
     * the most efficient region in the account renders red while the wasteful
     * one renders green, which is worse than showing nothing at all.
     */
    const dear = benchmarkSegment(400, 10, 10);
    const cheap = benchmarkSegment(50, 10, 10);
    if (dear.verdict !== "costlier" || cheap.verdict !== "cheaper") {
      throw new Error("fixture no longer produces one of each verdict");
    }
    expect(dear.gap).toBeGreaterThan(0);
    expect(cheap.gap).toBeLessThan(0);
  });

  it("reports a gap that agrees with the cost per lead it is derived from", () => {
    // `expected / actual - 1` is written for the zero case, but it has to stay
    // arithmetically identical to comparing the two cost-per-lead figures, or
    // the caption and the chip would describe different quantities.
    const spend = 630;
    const leads = 21;
    const panel = 10;
    const b = benchmarkSegment(spend, leads, panel);
    const direct = spend / leads / panel - 1;
    if (b.verdict !== "costlier") throw new Error("expected a costlier verdict");
    expect(b.gap).toBeCloseTo(direct, 10);
  });
});
