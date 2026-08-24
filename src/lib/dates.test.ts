import { describe, it, expect } from "vitest";
import {
  toDateKey,
  todayKey,
  dayStartUtc,
  dayEndUtc,
  localHourUtc,
  lastLocalHourBoundary,
  windowFromKeys,
  trailingWindow,
  trailingWindowInclusive,
  previousWindow,
  shiftDateKey,
  eachDateKey,
  localHour,
  currentMonthKey,
  dayLabel,
  rangeLabel,
  isValidTimeZone,
  isValidDateKey,
  isProvisional,
  META_PROVISIONAL_DAYS,
  MAX_RANGE_DAYS,
} from "./dates";

/**
 * The timezone primitives every number in this product is bucketed by.
 *
 * ── Why these needed their own tests ──────────────────────────────────
 *
 * They had none. Eight test files IMPORT this module, but to build inputs for
 * something else — so `toDateKey`, `dayStartUtc`, `dayEndUtc`, `previousWindow`,
 * `eachDateKey`, `shiftDateKey` and both URL validators had zero assertions
 * anywhere, while being the foundation of the product's central correctness
 * claim: every window is computed in the CLIENT's timezone, never the server's
 * and never UTC.
 *
 * That claim is not decorative. Meta buckets its daily insights in the ad
 * account's timezone, so a UTC-bucketed "Jul 20" would contain part of Meta's
 * Jul 19 — and every daily figure would be wrong by a few hours of spend, in a
 * way that reconciles against nothing and looks like ordinary variance.
 *
 * ── What makes these tests worth more than a fixed offset ─────────────
 *
 * A helper that adds a constant offset passes every naive test. The cases that
 * separate a real implementation from that are the days that are not 24 hours
 * long, so DST is the backbone of this file: US clocks in 2026 spring forward
 * on **2026-03-08** (a 23-hour day) and fall back on **2026-11-01** (25 hours).
 * Every offset here was computed against the platform's own tz database rather
 * than written from memory.
 *
 * Half-hour and quarter-hour zones are included for the same reason: Asia/
 * Kolkata (+05:30) and Pacific/Chatham (+12:45) break any implementation that
 * assumes whole-hour offsets.
 */

const LA = "America/Los_Angeles";
const LONDON = "Europe/London";
const KOLKATA = "Asia/Kolkata";
const CHATHAM = "Pacific/Chatham";

/** LA 2026: spring forward (23h day) and fall back (25h day). */
const SPRING_FORWARD = "2026-03-08";
const FALL_BACK = "2026-11-01";

const HOUR = 3_600_000;

/* ------------------------------------------------------------------ *
 * toDateKey — which local day an instant falls on
 * ------------------------------------------------------------------ */

describe("toDateKey", () => {
  it("🔴 answers with the LOCAL day, not the UTC one", () => {
    const instant = new Date("2026-07-20T03:00:00Z");

    // The same moment is two different calendar days depending on who is
    // looking. Bucketing this in UTC is the bug the whole module exists to
    // prevent.
    expect(toDateKey(instant, LA)).toBe("2026-07-19");
    expect(toDateKey(instant, LONDON)).toBe("2026-07-20");
  });

  it("handles zones ahead of UTC, including fractional offsets", () => {
    const instant = new Date("2026-07-20T19:00:00Z");
    expect(toDateKey(instant, KOLKATA)).toBe("2026-07-21"); // +05:30
    expect(toDateKey(instant, CHATHAM)).toBe("2026-07-21"); // +12:45
  });

  it("todayKey is toDateKey against now", () => {
    const now = new Date("2026-07-20T03:00:00Z");
    expect(todayKey(LA, now)).toBe("2026-07-19");
  });
});

/* ------------------------------------------------------------------ *
 * Day boundaries — where every SQL window opens and closes
 * ------------------------------------------------------------------ */

describe("dayStartUtc / dayEndUtc", () => {
  it("resolves local midnight to the right UTC instant", () => {
    // LA is UTC-7 in July.
    expect(dayStartUtc("2026-07-20", LA).toISOString()).toBe("2026-07-20T07:00:00.000Z");
    expect(dayEndUtc("2026-07-20", LA).toISOString()).toBe("2026-07-21T07:00:00.000Z");
  });

  it("🔴 handles half- and quarter-hour offsets", () => {
    // +05:30 — local midnight is the PREVIOUS UTC day at 18:30.
    expect(dayStartUtc("2026-07-20", KOLKATA).toISOString()).toBe("2026-07-19T18:30:00.000Z");
    // +12:45 — a zone that breaks any whole-hour assumption.
    expect(dayStartUtc("2026-07-20", CHATHAM).toISOString()).toBe("2026-07-19T11:15:00.000Z");
  });

  it("the end is EXCLUSIVE — it is the next day's start", () => {
    /*
     * Load-bearing: every metrics query filters `>= startUtc AND < endUtc`. An
     * inclusive end would double-count any row landing exactly on midnight, and
     * make two adjacent windows overlap by an instant.
     */
    expect(dayEndUtc("2026-07-20", LA).getTime()).toBe(
      dayStartUtc("2026-07-21", LA).getTime(),
    );
  });

  it("🔴 a spring-forward day is 23 hours long", () => {
    const span =
      dayEndUtc(SPRING_FORWARD, LA).getTime() - dayStartUtc(SPRING_FORWARD, LA).getTime();
    // This is the assertion a fixed-offset implementation cannot pass.
    expect(span).toBe(23 * HOUR);
  });

  it("🔴 a fall-back day is 25 hours long", () => {
    const span =
      dayEndUtc(FALL_BACK, LA).getTime() - dayStartUtc(FALL_BACK, LA).getTime();
    expect(span).toBe(25 * HOUR);
  });

  it("an ordinary day is 24 hours long", () => {
    const span =
      dayEndUtc("2026-07-20", LA).getTime() - dayStartUtc("2026-07-20", LA).getTime();
    expect(span).toBe(24 * HOUR);
  });

  it("round-trips: the start of a day is still that day", () => {
    for (const key of [SPRING_FORWARD, FALL_BACK, "2026-07-20", "2026-01-01", "2026-12-31"]) {
      expect(toDateKey(dayStartUtc(key, LA), LA)).toBe(key);
      expect(toDateKey(dayStartUtc(key, CHATHAM), CHATHAM)).toBe(key);
    }
  });
});

describe("localHourUtc / lastLocalHourBoundary", () => {
  it("resolves a local hour to UTC", () => {
    expect(localHourUtc("2026-07-20", 3, LA).toISOString()).toBe("2026-07-20T10:00:00.000Z");
  });

  it("returns today's boundary once local time has passed it", () => {
    // 11:00Z = 04:00 local, so local 03:00 has already happened today.
    const now = new Date("2026-07-20T11:00:00Z");
    expect(lastLocalHourBoundary(3, LA, now).toISOString()).toBe(
      "2026-07-20T10:00:00.000Z",
    );
  });

  it("🔴 falls back to yesterday's when local time has not reached it", () => {
    /*
     * The property that makes scheduled work survive a late or skipped run:
     * "has it happened since their local 3am" rather than "is it 3am for them
     * right now". The latter silently drops a client for the day.
     */
    const now = new Date("2026-07-20T09:00:00Z"); // 02:00 local, before 03:00
    expect(lastLocalHourBoundary(3, LA, now).toISOString()).toBe(
      "2026-07-19T10:00:00.000Z",
    );
  });

  it("still resolves a boundary on a spring-forward day", () => {
    // Local 02:00 does not exist on this date; the result must still be a real
    // instant at or before now rather than NaN.
    const now = new Date("2026-03-08T20:00:00Z");
    const b = lastLocalHourBoundary(3, LA, now);
    expect(Number.isNaN(b.getTime())).toBe(false);
    expect(b.getTime()).toBeLessThanOrEqual(now.getTime());
  });
});

/* ------------------------------------------------------------------ *
 * Windows
 * ------------------------------------------------------------------ */

describe("trailingWindow", () => {
  it("🔴 ends YESTERDAY — today is partial and would drag every average down", () => {
    const now = new Date("2026-07-20T18:00:00Z"); // 11:00 local
    const w = trailingWindow(7, LA, now);

    expect(w.endKey).toBe("2026-07-19");
    expect(w.startKey).toBe("2026-07-13");
    expect(eachDateKey(w, LA)).toHaveLength(7);
  });

  it("trailingWindowInclusive includes today instead", () => {
    const now = new Date("2026-07-20T18:00:00Z");
    const w = trailingWindowInclusive(7, LA, now);

    expect(w.endKey).toBe("2026-07-20");
    expect(w.startKey).toBe("2026-07-14");
    expect(eachDateKey(w, LA)).toHaveLength(7);
  });

  it("counts days in the CLIENT's zone, not the server's", () => {
    // 06:00Z is still the 19th in LA but already the 20th in London, so the two
    // windows must not agree.
    const now = new Date("2026-07-20T06:00:00Z");
    expect(trailingWindow(7, LA, now).endKey).toBe("2026-07-18");
    expect(trailingWindow(7, LONDON, now).endKey).toBe("2026-07-19");
  });
});

describe("previousWindow", () => {
  it("is the same length and ends the day before", () => {
    const w = windowFromKeys("2026-07-13", "2026-07-19", LA);
    const p = previousWindow(w, LA);

    // Anything else makes every "% change" compare unequal spans.
    expect(p.startKey).toBe("2026-07-06");
    expect(p.endKey).toBe("2026-07-12");
    expect(eachDateKey(p, LA)).toHaveLength(eachDateKey(w, LA).length);
  });

  it("handles a single-day window", () => {
    const p = previousWindow(windowFromKeys("2026-07-20", "2026-07-20", LA), LA);
    expect(p.startKey).toBe("2026-07-19");
    expect(p.endKey).toBe("2026-07-19");
  });

  it("🔴 stays equal-length across a DST boundary", () => {
    // The window containing the 25-hour day. Counting by elapsed milliseconds
    // rather than calendar days would come back a day short here.
    const w = windowFromKeys("2026-10-29", "2026-11-04", LA);
    const p = previousWindow(w, LA);

    expect(eachDateKey(w, LA)).toHaveLength(7);
    expect(eachDateKey(p, LA)).toHaveLength(7);
    expect(p.endKey).toBe("2026-10-28");
  });

  it("abuts the original window exactly, with no gap or overlap", () => {
    const w = windowFromKeys("2026-07-13", "2026-07-19", LA);
    const p = previousWindow(w, LA);
    expect(p.endUtc.getTime()).toBe(w.startUtc.getTime());
  });
});

describe("eachDateKey", () => {
  it("includes both ends", () => {
    const keys = eachDateKey(windowFromKeys("2026-07-18", "2026-07-20", LA), LA);
    expect(keys).toEqual(["2026-07-18", "2026-07-19", "2026-07-20"]);
  });

  it("🔴 emits each calendar day exactly once across both DST shifts", () => {
    /*
     * The classic failure is adding 24h at a time: a 23-hour day makes it skip
     * a date and a 25-hour day makes it repeat one. Both produce a chart with a
     * missing or doubled column that reads as a data problem.
     */
    for (const [start, end] of [
      ["2026-03-06", "2026-03-10"],
      ["2026-10-30", "2026-11-03"],
    ]) {
      const keys = eachDateKey(windowFromKeys(start, end, LA), LA);
      expect(keys).toHaveLength(5);
      expect(new Set(keys).size).toBe(5);
      expect(keys[0]).toBe(start);
      expect(keys[4]).toBe(end);
    }
  });

  it("returns a single key when start and end are the same day", () => {
    expect(eachDateKey(windowFromKeys("2026-07-20", "2026-07-20", LA), LA)).toEqual([
      "2026-07-20",
    ]);
  });

  it("returns nothing when the window is inverted", () => {
    // Not a crash and not an infinite loop — a bad URL must render an empty
    // chart, not hang the page.
    expect(eachDateKey(windowFromKeys("2026-07-20", "2026-07-18", LA), LA)).toEqual([]);
  });
});

describe("shiftDateKey", () => {
  it("shifts by calendar days in both directions", () => {
    expect(shiftDateKey("2026-07-20", -7)).toBe("2026-07-13");
    expect(shiftDateKey("2026-07-20", 7)).toBe("2026-07-27");
    expect(shiftDateKey("2026-07-20", 0)).toBe("2026-07-20");
  });

  it("crosses month and year ends", () => {
    expect(shiftDateKey("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftDateKey("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftDateKey("2028-02-28", 1)).toBe("2028-02-29"); // leap year
  });

  it("🔴 is unaffected by DST, because a date key is a label not an instant", () => {
    /*
     * Deliberately plain calendar arithmetic with no timezone. The key was
     * already resolved in the client's zone upstream, so routing it back
     * through a zone would apply that zone twice and land off by one exactly
     * here — which is the one place it is used, extending a window backwards to
     * give an anomaly baseline its lead-in.
     */
    expect(shiftDateKey(SPRING_FORWARD, 1)).toBe("2026-03-09");
    expect(shiftDateKey(SPRING_FORWARD, -1)).toBe("2026-03-07");
    expect(shiftDateKey(FALL_BACK, 1)).toBe("2026-11-02");
    expect(shiftDateKey(FALL_BACK, -1)).toBe("2026-10-31");
  });
});

/* ------------------------------------------------------------------ *
 * Validators — these guard URL params
 * ------------------------------------------------------------------ */

describe("isValidDateKey", () => {
  it("accepts a real calendar date", () => {
    expect(isValidDateKey("2026-07-20")).toBe(true);
    expect(isValidDateKey("2028-02-29")).toBe(true); // leap year
  });

  it("🔴 rejects a date that does not exist", () => {
    // JS would roll these forward silently, so a query for 2026-02-30 would
    // quietly return March data.
    expect(isValidDateKey("2026-02-30")).toBe(false);
    expect(isValidDateKey("2026-02-29")).toBe(false); // not a leap year
    expect(isValidDateKey("2026-04-31")).toBe(false);
    expect(isValidDateKey("2026-13-01")).toBe(false);
    expect(isValidDateKey("2026-00-10")).toBe(false);
  });

  it("rejects anything not in strict YYYY-MM-DD form", () => {
    for (const junk of [
      "2026-7-20", "20-07-2026", "2026/07/20", "2026-07-20T00:00:00Z",
      "", "  ", "today", null, undefined, 20260720, {}, ["2026-07-20"],
    ]) {
      expect(isValidDateKey(junk)).toBe(false);
    }
  });
});

describe("isValidTimeZone", () => {
  it("accepts real IANA zones", () => {
    for (const tz of [LA, LONDON, KOLKATA, CHATHAM, "UTC"]) {
      expect(isValidTimeZone(tz)).toBe(true);
    }
  });

  it("🔴 rejects empty strings and garbage rather than throwing", () => {
    // A bad zone reaching Intl throws a RangeError, which on a dashboard page
    // is a 500 instead of a validation message.
    for (const junk of ["", "   ", "Mars/Phobos", "America/Nowhere", null, undefined, 7, {}]) {
      expect(isValidTimeZone(junk)).toBe(false);
    }
  });

  it("⚠️ also accepts legacy abbreviations, and `EST` is a trap", () => {
    /*
     * These are not IANA region/city names but Intl accepts them, so the
     * validator does too — its contract is "a zone Intl accepts", and being
     * stricter than the thing that consumes the value would reject zones that
     * work.
     *
     * 🔴 The catch is that they are not equivalent. `PST` resolves to Pacific
     * WITH daylight saving, but `EST` is a FIXED UTC-5 zone that never shifts —
     * so a client stored as "EST" would have every day bucketed an hour off for
     * the ~8 months of the year Eastern is on EDT, quietly disagreeing with
     * their Ads Manager.
     *
     * Not a live risk today: Meta reports `timezone_name` as a real IANA name
     * and that is what a client adopts. Asserted so the difference is written
     * down rather than rediscovered from a client's numbers being slightly off.
     */
    expect(isValidTimeZone("PST")).toBe(true);
    expect(isValidTimeZone("EST")).toBe(true);

    const july = new Date("2026-07-20T18:00:00Z");
    expect(localHour("PST", july)).toBe(localHour(LA, july)); // both 11 — DST applied
    expect(localHour("EST", july)).toBe(13); // fixed UTC-5, NOT the 14 of EDT
    expect(localHour("America/New_York", july)).toBe(14);
  });
});

/* ------------------------------------------------------------------ *
 * Provisional data
 * ------------------------------------------------------------------ */

describe("isProvisional", () => {
  const now = new Date("2026-07-20T18:00:00Z"); // 11:00 local in LA

  it("today and yesterday are provisional", () => {
    expect(isProvisional("2026-07-20", LA, now)).toBe(true);
    expect(isProvisional("2026-07-19", LA, now)).toBe(true);
  });

  it("🔴 the horizon is exactly 28 days", () => {
    // Meta restates spend and conversions for up to 28 days as attribution
    // windows fill. Off by one here either flags settled data as unreliable or
    // presents restating data as final.
    const lastProvisional = shiftDateKey("2026-07-20", -(META_PROVISIONAL_DAYS - 1));
    const firstFinal = shiftDateKey("2026-07-20", -META_PROVISIONAL_DAYS);

    expect(isProvisional(lastProvisional, LA, now)).toBe(true);
    expect(isProvisional(firstFinal, LA, now)).toBe(false);
  });

  it("is measured in the client's calendar days", () => {
    // 06:00Z is still the 19th in LA and already the 20th in London, so a date
    // on the cusp is not provisional for both.
    const cusp = new Date("2026-07-20T06:00:00Z");
    const key = shiftDateKey("2026-07-20", -META_PROVISIONAL_DAYS);
    expect(isProvisional(key, LA, cusp)).toBe(true);
    expect(isProvisional(key, LONDON, cusp)).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Labels
 * ------------------------------------------------------------------ */

describe("rangeLabel / dayLabel", () => {
  it("🔴 reads the key literally, never through new Date()", () => {
    /*
     * `new Date("2026-07-01")` is UTC midnight, which renders as 30 June for
     * anyone west of Greenwich — the exact off-by-one that makes a report
     * disagree with the dashboard it was generated from.
     */
    expect(rangeLabel("2026-07-01", "2026-07-01")).toContain("1 Jul");
    expect(dayLabel("2026-07-01")).toContain("1");
  });

  it("collapses a range to the shortest unambiguous form", () => {
    expect(rangeLabel("2026-07-01", "2026-07-31")).toBe("1–31 Jul 2026");
    expect(rangeLabel("2026-06-28", "2026-07-04")).toBe("28 Jun – 4 Jul 2026");
    expect(rangeLabel("2025-12-28", "2026-01-03")).toBe("28 Dec 2025 – 3 Jan 2026");
    expect(rangeLabel("2026-07-20", "2026-07-20")).toBe("20 Jul 2026");
  });
});

describe("localHour / currentMonthKey", () => {
  it("reads the hour in the client's zone", () => {
    const now = new Date("2026-07-20T18:00:00Z");
    expect(localHour(LA, now)).toBe(11);
    expect(localHour(LONDON, now)).toBe(19);
  });

  it("resolves the month in the client's zone at a cusp", () => {
    // 2026-08-01T04:00Z is still July in LA.
    const cusp = new Date("2026-08-01T04:00:00Z");
    expect(currentMonthKey(LA, cusp)).toBe("2026-07");
    expect(currentMonthKey(LONDON, cusp)).toBe("2026-08");
  });
});

describe("MAX_RANGE_DAYS", () => {
  it("is shared so the picker and the page cannot drift", () => {
    // They did drift: the picker offered "All" as 800 days, the page clamped to
    // 365, and the control still rendered "All" as active — so the label named
    // a window the page was not showing.
    expect(MAX_RANGE_DAYS).toBe(365);
  });
});
