import { describe, it, expect } from "vitest";
import {
  buildCallTiming,
  hourLabel,
  hourRangeLabel,
  CONNECTED_SECONDS,
  DAYTIME_END,
  DAYTIME_START,
  MIN_ATTEMPTS_TO_COMPARE,
  MIN_ATTEMPTS_TO_RATE,
  type HourInput,
} from "./calltime";

/**
 * The call-timing engine.
 *
 * The tests that matter are the ones asserting it REFUSES to name an hour. The
 * naive version of this feature always has an answer, and the answer is noise:
 * on the live account 80% of calls go out in two hours and ten hours have never
 * been dialled at all, so "6am is your best hour (3 of 5)" is what a
 * ranked-bar-chart implementation would confidently report.
 */

const h = (over: Partial<HourInput> & { hour: number }): HourInput => ({
  attempts: 0,
  connected: 0,
  arrivals: 0,
  ...over,
});

/** An hour with a given attempt count and connect rate, rounded down. */
const at = (hour: number, attempts: number, rate: number, arrivals = 0) =>
  h({ hour, attempts, connected: Math.floor(attempts * rate), arrivals });

const row = (r: ReturnType<typeof buildCallTiming>, hour: number) =>
  r.hours.find((x) => x.hour === hour)!;

/* ------------------------------------------------------------------ *
 * Shape
 * ------------------------------------------------------------------ */

describe("shape", () => {
  it("always returns a whole day, so an untried hour is visible", () => {
    const r = buildCallTiming([at(9, 30, 0.4)]);
    expect(r.hours).toHaveLength(24);
    expect(r.hours.map((x) => x.hour)).toEqual(Array.from({ length: 24 }, (_, i) => i));
    // 🔴 Never called is a state, not an absence. An hour missing from the
    // output would read as "no data" when it means "nobody has ever tried".
    expect(row(r, 3).attempts).toBe(0);
    expect(row(r, 3).rawRate).toBeNull();
  });

  it("totals across the day", () => {
    const r = buildCallTiming([at(9, 20, 0.5), at(10, 10, 0.2), h({ hour: 15, arrivals: 7 })]);
    expect(r.totals.attempts).toBe(30);
    expect(r.totals.connected).toBe(12);
    expect(r.totals.rate).toBeCloseTo(0.4, 10);
    expect(r.totals.arrivals).toBe(7);
  });

  it("merges duplicate rows for one hour", () => {
    const r = buildCallTiming([
      h({ hour: 9, attempts: 10, connected: 4 }),
      h({ hour: 9, attempts: 5, connected: 1, arrivals: 2 }),
    ]);
    expect(row(r, 9).attempts).toBe(15);
    expect(row(r, 9).connected).toBe(5);
    expect(row(r, 9).arrivals).toBe(2);
  });

  it("ignores rows outside 0–23 rather than throwing", () => {
    const r = buildCallTiming([
      h({ hour: 24, attempts: 99 }),
      h({ hour: -1, attempts: 99 }),
      h({ hour: 9.5, attempts: 99 }),
      at(9, 10, 0.5),
    ]);
    expect(r.totals.attempts).toBe(10);
  });

  it("clamps negative counts rather than letting them subtract", () => {
    const r = buildCallTiming([h({ hour: 9, attempts: -5, connected: -2, arrivals: -1 })]);
    expect(r.totals.attempts).toBe(0);
    expect(r.totals.arrivals).toBe(0);
  });

  it("🔴 clamps connected above attempts, which could only be a query bug", () => {
    // A rate above 1 renders as "140%" and reads as a real figure.
    const r = buildCallTiming([h({ hour: 9, attempts: 10, connected: 14 })]);
    expect(row(r, 9).connected).toBe(10);
    expect(row(r, 9).rawRate).toBe(1);
  });

  it("carries the connected-seconds threshold so the panel can name it", () => {
    expect(buildCallTiming([]).connectedSeconds).toBe(CONNECTED_SECONDS);
  });
});

/* ------------------------------------------------------------------ *
 * Rates: counts always, percentages only when earned
 * ------------------------------------------------------------------ */

describe("rate reporting", () => {
  it("🔴 withholds the percentage below the attempt floor but keeps the counts", () => {
    /*
     * "3 of 5" is honest and useful — hard suppression makes the tool look like
     * it knows less than it does. "60%" off five attempts reads as a finding
     * and is a coin flip.
     */
    const r = buildCallTiming([h({ hour: 6, attempts: 5, connected: 3 })]);
    expect(row(r, 6).attempts).toBe(5);
    expect(row(r, 6).connected).toBe(3);
    expect(row(r, 6).rawRate).toBeCloseTo(0.6, 10);
    expect(row(r, 6).rate).toBeNull();
  });

  it("quotes a rate at the floor and not one below it", () => {
    const below = buildCallTiming([at(9, MIN_ATTEMPTS_TO_RATE - 1, 0.5)]);
    const atFloor = buildCallTiming([at(9, MIN_ATTEMPTS_TO_RATE, 0.5)]);
    expect(row(below, 9).rate).toBeNull();
    expect(row(atFloor, 9).rate).not.toBeNull();
  });

  it("gives an untried hour no rate at all, not a zero", () => {
    const r = buildCallTiming([at(9, 30, 0.4)]);
    expect(row(r, 2).rawRate).toBeNull();
    expect(row(r, 2).lo).toBeNull();
    expect(row(r, 2).hi).toBeNull();
  });

  it("widens the interval as the sample shrinks", () => {
    const few = buildCallTiming([at(9, 8, 0.5)]);
    const many = buildCallTiming([at(9, 400, 0.5)]);
    const spread = (x: ReturnType<typeof buildCallTiming>) =>
      row(x, 9).hi! - row(x, 9).lo!;
    expect(spread(few)).toBeGreaterThan(spread(many));
  });

  it("computes arrival and attempt shares", () => {
    const r = buildCallTiming([
      h({ hour: 9, attempts: 30, connected: 10, arrivals: 4 }),
      h({ hour: 15, attempts: 10, connected: 2, arrivals: 6 }),
    ]);
    expect(row(r, 9).attemptShare).toBeCloseTo(0.75, 10);
    expect(row(r, 15).arrivalShare).toBeCloseTo(0.6, 10);
  });
});

/* ------------------------------------------------------------------ *
 * The verdict — mostly a refusal
 * ------------------------------------------------------------------ */

describe("verdict", () => {
  it("says nothing has been recorded when nothing has", () => {
    const r = buildCallTiming([h({ hour: 15, arrivals: 9 })]);
    expect(r.verdict).toBe("no_calls");
    expect(r.best).toBeNull();
    expect(r.concentration).toBeNull();
    // Arrivals still land, so the panel can say the pipe is alive.
    expect(r.totals.arrivals).toBe(9);
  });

  it("🔴 refuses to name a best hour when only one hour is ever called", () => {
    /*
     * The live case. One hour cannot be "the best hour" — there is nothing for
     * it to be better than, and quoting its rate would turn "this is when we
     * happen to call" into "this is when to call".
     */
    const r = buildCallTiming([at(8, 65, 0.22), at(9, 34, 0.41), at(6, 5, 0.6)]);
    expect(r.comparableHours).toBe(2);
    expect(["too_concentrated", "no_hour_stands_out", "hour_stands_out"]).toContain(r.verdict);

    const onlyOne = buildCallTiming([at(8, 99, 0.3), at(6, 5, 0.8), at(14, 4, 1)]);
    expect(onlyOne.comparableHours).toBe(1);
    expect(onlyOne.verdict).toBe("too_concentrated");
    expect(onlyOne.best).toBeNull();
  });

  it("🔴 never lets a tiny high-rate hour become the recommendation", () => {
    // 5 of 5 at 6am against 200 attempts at 9am. A ranked bar chart says 6am.
    const r = buildCallTiming([
      h({ hour: 6, attempts: 5, connected: 5 }),
      at(9, 200, 0.3),
      at(10, 60, 0.3),
    ]);
    expect(r.best?.hour).not.toBe(6);
    expect(r.verdict).toBe("no_hour_stands_out");
  });

  it("reports no winner when comparable hours are genuinely alike", () => {
    const r = buildCallTiming([at(9, 100, 0.3), at(10, 100, 0.32), at(11, 100, 0.29)]);
    expect(r.verdict).toBe("no_hour_stands_out");
    expect(r.best).toBeNull();
  });

  it("names an hour when the gap is real and the volume supports it", () => {
    const r = buildCallTiming([at(10, 200, 0.55), at(9, 200, 0.2), at(14, 200, 0.22)]);
    expect(r.verdict).toBe("hour_stands_out");
    expect(r.best?.hour).toBe(10);
    expect(r.best!.rate).toBeGreaterThan(r.best!.restRate);
    expect(r.best!.probability).toBeGreaterThanOrEqual(0.9);
  });

  it("🔴 compares an hour against the REST of the day, not against the total", () => {
    /*
     * An hour holding most of the calling would otherwise be compared with a
     * near-copy of itself and could never differ from it — so the hour a client
     * calls in most is precisely the one the naive comparison can never judge.
     */
    const r = buildCallTiming([at(8, 400, 0.5), at(9, 40, 0.1), at(10, 40, 0.1)]);
    expect(r.best?.hour).toBe(8);
    expect(r.best!.restRate).toBeCloseTo(0.1, 6);
  });

  it("picks the strongest hour when two clear it", () => {
    const r = buildCallTiming([at(10, 300, 0.7), at(11, 300, 0.55), at(9, 300, 0.1)]);
    expect(r.verdict).toBe("hour_stands_out");
    expect(r.best?.hour).toBe(10);
  });

  it("🔴 always has a comparable remainder to judge against", () => {
    /*
     * The invariant that lets the comparison drop its own floor on the
     * remainder: an hour is only judged when at least two hours clear
     * MIN_ATTEMPTS_TO_COMPARE, so whichever one is under test, the other is
     * already in the remainder and the remainder clears the floor too.
     *
     * Asserted rather than assumed, because a change to the gate above would
     * otherwise make the comparison start judging hours against a handful of
     * calls without anything failing.
     */
    const r = buildCallTiming([at(9, 300, 0.6), at(10, MIN_ATTEMPTS_TO_COMPARE, 0.05)]);
    expect(r.comparableHours).toBe(2);
    for (const hour of r.hours.filter((x) => x.attempts >= MIN_ATTEMPTS_TO_COMPARE)) {
      expect(r.totals.attempts - hour.attempts).toBeGreaterThanOrEqual(
        MIN_ATTEMPTS_TO_COMPARE,
      );
    }
    // And the genuinely better hour is still the one named.
    expect(r.best?.hour).toBe(9);
  });

  it("counts how many hours are comparable at all", () => {
    const r = buildCallTiming([
      at(8, MIN_ATTEMPTS_TO_COMPARE, 0.3),
      at(9, MIN_ATTEMPTS_TO_COMPARE - 1, 0.3),
      at(10, 100, 0.3),
    ]);
    expect(r.comparableHours).toBe(2);
  });
});

/* ------------------------------------------------------------------ *
 * Concentration
 * ------------------------------------------------------------------ */

describe("concentration", () => {
  it("reports the fewest hours holding most of the calling", () => {
    const r = buildCallTiming([at(8, 65, 0.2), at(9, 34, 0.4), at(10, 2, 0.5), at(14, 4, 0.25)]);
    expect(r.concentration).toEqual({ hours: 2, share: 99 / 105 });
  });

  it("reports one hour when one hour carries everything", () => {
    const r = buildCallTiming([at(8, 100, 0.3)]);
    expect(r.concentration).toEqual({ hours: 1, share: 1 });
  });

  it("reports more hours when calling is spread", () => {
    const spread = Array.from({ length: 10 }, (_, i) => at(8 + i, 20, 0.3));
    expect(buildCallTiming(spread).concentration!.hours).toBe(7);
  });

  it("is null when nothing was called", () => {
    expect(buildCallTiming([h({ hour: 9, arrivals: 5 })]).concentration).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Where the evidence is missing
 * ------------------------------------------------------------------ */

describe("untried hours", () => {
  it("names daytime hours with arrivals and almost no calls", () => {
    const r = buildCallTiming([
      h({ hour: 8, attempts: 65, connected: 14, arrivals: 15 }),
      h({ hour: 9, attempts: 34, connected: 14, arrivals: 2 }),
      h({ hour: 10, attempts: 2, connected: 1, arrivals: 11 }),
      h({ hour: 15, attempts: 0, connected: 0, arrivals: 7 }),
    ]);
    expect(r.untried.map((u) => u.hour)).toEqual([10, 15]);
    expect(r.untried[0]).toEqual({ hour: 10, arrivals: 11, attempts: 2 });
  });

  it("🔴 never suggests an hour outside the working day", () => {
    /*
     * Leads arrive at 2am. Nobody should call them at 2am, and a panel
     * suggesting it would be ignored along with everything next to it.
     */
    const r = buildCallTiming([
      at(9, 100, 0.3),
      h({ hour: 2, arrivals: 40 }),
      h({ hour: 23, arrivals: 40 }),
      h({ hour: DAYTIME_END, arrivals: 40 }),
      h({ hour: DAYTIME_START - 1, arrivals: 40 }),
    ]);
    expect(r.untried).toEqual([]);
  });

  it("includes the first daytime hour and excludes the one past the last", () => {
    const inside = buildCallTiming([at(9, 100, 0.3), h({ hour: DAYTIME_START, arrivals: 40 })]);
    expect(inside.untried.map((u) => u.hour)).toEqual([DAYTIME_START]);
    const outside = buildCallTiming([at(9, 100, 0.3), h({ hour: DAYTIME_END, arrivals: 40 })]);
    expect(outside.untried).toEqual([]);
  });

  it("ignores an hour with only a lead or two", () => {
    const r = buildCallTiming([at(9, 100, 0.3), h({ hour: 15, arrivals: 2 })]);
    expect(r.untried).toEqual([]);
  });

  it("ignores an hour already getting its share of the calling", () => {
    const r = buildCallTiming([
      h({ hour: 9, attempts: 50, connected: 15, arrivals: 10 }),
      h({ hour: 15, attempts: 50, connected: 15, arrivals: 10 }),
    ]);
    expect(r.untried).toEqual([]);
  });

  it("names the busiest first and caps the list", () => {
    const r = buildCallTiming([
      at(9, 200, 0.3),
      ...[10, 11, 12, 13, 14, 15].map((hr) => h({ hour: hr, arrivals: hr })),
    ]);
    expect(r.untried.map((u) => u.hour)).toEqual([15, 14, 13, 12]);
  });

  it("is empty when nothing has been called, because nothing is comparable yet", () => {
    const r = buildCallTiming([h({ hour: 15, arrivals: 20 })]);
    expect(r.untried).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Labels
 * ------------------------------------------------------------------ */

describe("hour labels", () => {
  it("reads as a person would say it, not as 24-hour time", () => {
    expect(hourLabel(0)).toBe("12am");
    expect(hourLabel(1)).toBe("1am");
    expect(hourLabel(11)).toBe("11am");
    expect(hourLabel(12)).toBe("12pm");
    expect(hourLabel(13)).toBe("1pm");
    expect(hourLabel(23)).toBe("11pm");
  });

  it("renders an hour as the span it is", () => {
    expect(hourRangeLabel(8)).toBe("8am–9am");
    expect(hourRangeLabel(11)).toBe("11am–12pm");
    expect(hourRangeLabel(23)).toBe("11pm–12am");
  });

  it("dashes anything that is not an hour", () => {
    expect(hourLabel(24)).toBe("–");
    expect(hourLabel(-1)).toBe("–");
    expect(hourLabel(9.5)).toBe("–");
    expect(hourRangeLabel(99)).toBe("–");
  });
});
