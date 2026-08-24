import { describe, it, expect } from "vitest";
import {
  INDEX_CEILING,
  INDEX_FLOOR,
  MIN_COMPLETE_DAYS,
  MIN_PER_WEEKDAY,
  buildForecast,
  isoDow,
  weekdayIndices,
  type ForecastDay,
} from "./forecast";

/** July 2026 begins on a Wednesday and has 31 days. */
const JULY_START_DOW = 3;

function july(day: number, spend: number, leads: number): ForecastDay {
  const dateKey = `2026-07-${String(day).padStart(2, "0")}`;
  return { dateKey, dow: isoDow(dateKey), spend, leads };
}

/** Every day of July from `from` to `to`, at a flat rate. */
function flat(from: number, to: number, spend: number, leads: number) {
  const out: ForecastDay[] = [];
  for (let d = from; d <= to; d++) out.push(july(d, spend, leads));
  return out;
}

const remaining = (from: number, to = 31) => {
  const out: number[] = [];
  for (let d = from; d <= to; d++) out.push(isoDow(`2026-07-${String(d).padStart(2, "0")}`));
  return out;
};

const opts = (todayDay: number, extra = {}) => ({
  monthKey: "2026-07",
  todayKey: `2026-07-${String(todayDay).padStart(2, "0")}`,
  daysInMonth: 31,
  remainingDows: remaining(todayDay),
  ...extra,
});

describe("isoDow", () => {
  it("returns Monday as 1 and Sunday as 7", () => {
    expect(isoDow("2026-07-06")).toBe(1); // a Monday
    expect(isoDow("2026-07-05")).toBe(7); // a Sunday
  });

  it("🔴 reads the key as a calendar date, not through the host timezone", () => {
    /*
     * A date key is already resolved into the client's timezone upstream. Built
     * with `new Date("2026-07-01")` in a negative-offset zone the runtime would
     * hand back the previous day and every weekday index would sit on the wrong
     * bucket. This assertion is the canary for that.
     */
    expect(isoDow("2026-07-01")).toBe(JULY_START_DOW);
    expect(isoDow("2026-01-01")).toBe(4);
    expect(isoDow("2026-12-31")).toBe(4);
  });
});

describe("guards", () => {
  it("says too_early rather than multiplying two days by fifteen", () => {
    const r = buildForecast(flat(1, 2, 100, 10), opts(3));
    expect(r.verdict).toBe("too_early");
    expect(r.metrics).toEqual([]);
  });

  it(`forecasts once there are ${MIN_COMPLETE_DAYS} complete days`, () => {
    const r = buildForecast(flat(1, MIN_COMPLETE_DAYS, 100, 10), opts(MIN_COMPLETE_DAYS + 1));
    expect(r.verdict).toBe("ok");
  });

  it("says no_data for a month with nothing in it yet", () => {
    expect(buildForecast([], opts(10)).verdict).toBe("no_data");
  });

  it("🔴 reports a finished month as complete, not as a forecast", () => {
    const r = buildForecast(flat(1, 31, 100, 10), {
      ...opts(31),
      remainingDows: [],
    });
    expect(r.verdict).toBe("month_over");
  });

  it("🔴 calls a finished month over even when it holds too few days to project", () => {
    // A client onboarded on the 29th. The month IS complete; it is not early.
    const r = buildForecast(flat(29, 31, 100, 10), {
      ...opts(31),
      remainingDows: [],
    });
    expect(r.verdict).toBe("month_over");
  });
});

describe("today is projected, not observed", () => {
  it("🔴 excludes today from the observations", () => {
    /*
     * Today is in progress. Counting a part-day as a whole one drags the daily
     * mean down by however much of the day is left, and the effect is largest
     * at the start of a month where the multiplier is largest.
     */
    const days = [...flat(1, 9, 100, 10), july(10, 3, 1)]; // today, barely begun
    const r = buildForecast(days, opts(10));
    expect(r.completeDays).toBe(9);
    expect(r.metrics[0].observed).toBe(900);
  });

  it("counts today among the days remaining", () => {
    const r = buildForecast(flat(1, 9, 100, 10), opts(10));
    expect(r.remainingDays).toBe(22); // the 10th through the 31st
    expect(r.completeDays + r.remainingDays).toBe(31);
  });
});

describe("flat data", () => {
  const r = buildForecast(flat(1, 14, 100, 10), opts(15));

  it("projects the month at the observed daily rate", () => {
    // 14 complete days at $100, 17 remaining. Nothing to weight, so 31 × 100.
    expect(r.metrics[0].projected).toBeCloseTo(3100, 6);
    expect(r.metrics[1].projected).toBeCloseTo(310, 6);
  });

  it("reports no weekday weighting when the data shows no weekday effect", () => {
    expect(r.weekdayWeighted).toBe(false);
  });

  it("produces a zero-width band when every day is identical", () => {
    // Variance is genuinely zero here, so a band would be false precision in
    // the other direction.
    expect(r.metrics[0].low).toBeCloseTo(r.metrics[0].high, 6);
  });

  it("derives cost per lead from the projections, not from the observations", () => {
    expect(r.projectedCpl).toBeCloseTo(10, 6);
    expect(r.observedCpl).toBeCloseTo(10, 6);
  });
});

describe("weekday weighting", () => {
  /**
   * Weekdays at 20 leads, weekends at 4. July 2026 starts on a Wednesday, so
   * the first nine days hold three weekend days — the case a flat pace gets
   * wrong, and gets wrong hardest early in the month.
   */
  const seasonal = (from: number, to: number) => {
    const out: ForecastDay[] = [];
    for (let d = from; d <= to; d++) {
      const dow = isoDow(`2026-07-${String(d).padStart(2, "0")}`);
      const weekend = dow >= 6;
      out.push(july(d, weekend ? 20 : 100, weekend ? 4 : 20));
    }
    return out;
  };

  it("🔴 beats a flat pace when the days elapsed are not representative", () => {
    const days = seasonal(1, 16);
    const r = buildForecast(days, opts(17));
    expect(r.weekdayWeighted).toBe(true);

    // The truth, if the pattern simply continues to the 31st.
    const truth = seasonal(1, 31).reduce((a, d) => a + d.leads, 0);
    const observedLeads = days.reduce((a, d) => a + d.leads, 0);
    const flatPace = (observedLeads / 16) * 31;

    expect(Math.abs(r.metrics[1].projected - truth)).toBeLessThan(
      Math.abs(flatPace - truth),
    );
  });

  it("lands within a lead of the truth on a cleanly periodic month", () => {
    const truth = seasonal(1, 31).reduce((a, d) => a + d.leads, 0);
    const r = buildForecast(seasonal(1, 16), opts(17));
    expect(r.metrics[1].projected).toBeCloseTo(truth, 0);
  });

  it("stays flat while a weekday has too few observations to index", () => {
    // Six days: one of each weekday but Tuesday, so nothing reaches the
    // threshold and every index stays at 1.
    const days = seasonal(1, 6);
    expect(days.length).toBeGreaterThanOrEqual(MIN_COMPLETE_DAYS);
    expect(weekdayIndices(days, (d) => d.leads)).toBeNull();
  });

  it("indexes only the weekdays that have enough, leaving the rest flat", () => {
    const days = seasonal(1, 9); // two Wednesdays, two Thursdays, and singles
    const idx = weekdayIndices(days, (d) => d.leads);
    expect(idx).not.toBeNull();
    // Monday appears once in the 1st–9th, so it stays neutral.
    expect(idx!.get(1)).toBe(1);
    expect(idx!.get(3)).toBeGreaterThan(1); // Wednesday, seen twice, above mean
  });

  it("🔴 clamps an index so one anomalous day cannot rewrite the month", () => {
    /*
     * A Saturday that happened to carry a launch would otherwise produce an
     * index of 6 and be applied to every remaining Saturday.
     */
    const days = [
      ...flat(1, 14, 10, 1),
      july(18, 10_000, 500),
      july(25, 10_000, 500),
    ];
    const idx = weekdayIndices(days, (d) => d.spend);
    for (const v of idx!.values()) {
      expect(v).toBeGreaterThanOrEqual(INDEX_FLOOR);
      expect(v).toBeLessThanOrEqual(INDEX_CEILING);
    }
  });

  it("returns null rather than indices when nothing was spent at all", () => {
    expect(weekdayIndices(flat(1, 14, 0, 0), (d) => d.spend)).toBeNull();
  });

  it(`requires ${MIN_PER_WEEKDAY} observations of a weekday before trusting it`, () => {
    const oneEach = flat(1, 7, 100, 10);
    expect(weekdayIndices(oneEach, (d) => d.leads)).toBeNull();
  });
});

describe("the interval", () => {
  const noisy = () => {
    const out: ForecastDay[] = [];
    for (let d = 1; d <= 10; d++) out.push(july(d, d % 2 ? 20 : 180, d % 2 ? 2 : 18));
    return out;
  };

  it("brackets the point estimate", () => {
    const r = buildForecast(noisy(), opts(11));
    for (const m of r.metrics) {
      expect(m.low).toBeLessThanOrEqual(m.projected);
      expect(m.high).toBeGreaterThanOrEqual(m.projected);
    }
  });

  it("🔴 narrows as the month fills in", () => {
    /*
     * The band carries our uncertainty about the daily mean as well as the
     * day-to-day noise, and the first of those shrinks with both more
     * observations and fewer days left to project.
     */
    const early = buildForecast(noisy(), opts(11));
    const late = buildForecast(
      [...noisy(), ...flat(11, 25, 100, 10)],
      opts(26),
    );
    const width = (r: ReturnType<typeof buildForecast>) =>
      r.metrics[0].high - r.metrics[0].low;
    expect(width(late)).toBeLessThan(width(early));
  });

  it("🔴 never puts the lower bound below the leads already banked", () => {
    // A month cannot end with fewer leads than it has. On a volatile client the
    // raw interval dips below the observed count, which is arithmetically wrong.
    const spiky = [...flat(1, 9, 10, 1), july(10, 5000, 400)];
    const r = buildForecast(spiky, opts(11));
    expect(r.metrics[1].low).toBeGreaterThanOrEqual(r.metrics[1].observed);
  });

  it("never puts projected spend below zero", () => {
    const r = buildForecast(noisy(), opts(11));
    expect(r.metrics[0].low).toBeGreaterThanOrEqual(0);
  });
});

describe("what is deliberately absent", () => {
  it("🔴 forecasts spend and leads and nothing further down the funnel", () => {
    /*
     * Appointments, shows and closes mature over weeks (§6.9). Month-to-date
     * counts for them are censored, not sampled, so pacing them forward reports
     * the calendar as a decline. See the header of `forecast.ts`.
     */
    const r = buildForecast(flat(1, 14, 100, 10), opts(15));
    expect(r.metrics.map((m) => m.key)).toEqual(["spend", "leads"]);
  });
});

describe("prior month context", () => {
  it("carries last month through untouched", () => {
    const r = buildForecast(
      flat(1, 14, 100, 10),
      opts(15, { previous: { spend: 2500, leads: 240 } }),
    );
    expect(r.metrics[0].previous).toBe(2500);
    expect(r.metrics[1].previous).toBe(240);
  });

  it("is null when not supplied, rather than zero", () => {
    // Zero would render as "down 100% on last month" for a new client.
    const r = buildForecast(flat(1, 14, 100, 10), opts(15));
    expect(r.metrics[0].previous).toBeNull();
  });
});

describe("degenerate input", () => {
  it("handles a month with spend but no leads", () => {
    const r = buildForecast(flat(1, 14, 100, 0), opts(15));
    expect(r.verdict).toBe("ok");
    expect(r.projectedCpl).toBeNull();
    expect(r.observedCpl).toBeNull();
  });

  it("handles a paused account — zero everywhere", () => {
    const r = buildForecast(flat(1, 14, 0, 0), opts(15));
    expect(r.metrics[0].projected).toBe(0);
    expect(r.metrics[0].low).toBe(0);
    expect(r.weekdayWeighted).toBe(false);
  });

  it("ignores days belonging to another month", () => {
    const days = [
      { dateKey: "2026-06-30", dow: 2, spend: 9999, leads: 999 },
      ...flat(1, 14, 100, 10),
    ];
    const r = buildForecast(days, opts(15));
    // The June day sorts before today and would otherwise be observed. The
    // loader never passes one; the guard is that the arithmetic does not
    // silently absorb it into the daily mean if it ever did.
    expect(r.metrics[0].observed).toBeGreaterThan(1400);
  });

  it("survives unsorted input", () => {
    const shuffled = [...flat(1, 14, 100, 10)].reverse();
    expect(buildForecast(shuffled, opts(15)).metrics[0].projected).toBeCloseTo(
      3100,
      6,
    );
  });
});
