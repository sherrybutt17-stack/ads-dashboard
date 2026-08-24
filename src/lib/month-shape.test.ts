import { describe, it, expect } from "vitest";
import { monthShape, currentMonthKey, localHour } from "./dates";

/**
 * The three helpers budget pacing divides by.
 *
 * They are worth their own file because a timezone slip here does not throw —
 * it produces a plausible number. `dayOfMonth` off by one moves every client's
 * pace verdict by a day's spend; `daysInMonth` wrong in February prices the
 * whole month's target at the wrong daily rate. Neither shows up as an error,
 * and both are exactly the class of silent wrongness this dashboard replaced a
 * spreadsheet to avoid.
 */

const LA = "America/Los_Angeles"; // UTC-8/-7, DST
const KARACHI = "Asia/Karachi"; // UTC+5, no DST
const KOLKATA = "Asia/Kolkata"; // UTC+5:30 — half-hour offset
const SYDNEY = "Australia/Sydney"; // southern hemisphere DST
const UTC = "UTC";

describe("monthShape — the calendar", () => {
  it("gets the length of ordinary months right", () => {
    expect(monthShape("2026-08", UTC).daysInMonth).toBe(31);
    expect(monthShape("2026-09", UTC).daysInMonth).toBe(30);
    expect(monthShape("2026-02", UTC).daysInMonth).toBe(28);
  });

  it("gets February right in a leap year", () => {
    // 2028 is a leap year; 2100 is not, despite being divisible by 4.
    expect(monthShape("2028-02", UTC).daysInMonth).toBe(29);
    expect(monthShape("2100-02", UTC).daysInMonth).toBe(28);
  });

  it("spans the whole month, first day to last", () => {
    const s = monthShape("2026-02", UTC);
    expect(s.startKey).toBe("2026-02-01");
    expect(s.endKey).toBe("2026-02-28");
    expect(s.monthKey).toBe("2026-02");
  });

  it("is not shifted by a DST transition inside the month", () => {
    /*
     * US clocks jump forward at 02:00 on the second Sunday in March and back in
     * November; southern-hemisphere zones transition in April and October.
     * None of that may change how many days the month has.
     */
    expect(monthShape("2026-03", LA).daysInMonth).toBe(31);
    expect(monthShape("2026-03", LA).startKey).toBe("2026-03-01");
    expect(monthShape("2026-11", LA).daysInMonth).toBe(30); // clocks fall back
    // Southern hemisphere transitions run the other way, in other months.
    expect(monthShape("2026-04", SYDNEY).daysInMonth).toBe(30);
    expect(monthShape("2026-10", SYDNEY).daysInMonth).toBe(31);
  });

  it("holds for zones that skip local midnight on the 1st", () => {
    /*
     * These are the real cases behind the noon anchor in `monthShape`, found by
     * sweeping the zone database rather than assumed: America/Asuncion moved
     * its clocks forward at 00:00 on 2017-10-01 and 2023-10-01, and Asia/Amman
     * on 2016-04-01, so local midnight on those first-of-months never happened.
     *
     * Stated honestly: a midnight anchor also survives them, because TZDate
     * normalises the missing hour forward to 01:00 on the same date. The point
     * of noon is not to fix a live bug — it is that noon exists in every zone
     * on every day and so depends on no normalisation rule at all.
     */
    const asuncion = "America/Asuncion";
    expect(monthShape("2017-10", asuncion).startKey).toBe("2017-10-01");
    expect(monthShape("2017-10", asuncion).daysInMonth).toBe(31);
    expect(monthShape("2023-10", asuncion).startKey).toBe("2023-10-01");
    expect(monthShape("2016-04", "Asia/Amman").startKey).toBe("2016-04-01");
    expect(monthShape("2016-04", "Asia/Amman").daysInMonth).toBe(30);
  });
});

describe("monthShape — how far into the month we are", () => {
  /** 10th of August 2026, 09:00 in Los Angeles. */
  const AUG_10_LA_9AM = new Date("2026-08-10T16:00:00Z");

  it("reports today's day number in the client's timezone", () => {
    expect(monthShape("2026-08", LA, AUG_10_LA_9AM).dayOfMonth).toBe(10);
  });

  it("🔴 reads the day in the CLIENT's zone, not the server's", () => {
    /*
     * The bug this guards. 2026-08-11T04:00Z is already the 11th in UTC and in
     * Karachi, but still the 10th in Los Angeles — so a client there has nine
     * complete days, not ten, and crediting the extra one would compare their
     * spend against a target a day ahead of reality.
     */
    const justAfterUtcMidnight = new Date("2026-08-11T04:00:00Z");
    expect(monthShape("2026-08", LA, justAfterUtcMidnight).dayOfMonth).toBe(10);
    expect(monthShape("2026-08", UTC, justAfterUtcMidnight).dayOfMonth).toBe(11);
    expect(monthShape("2026-08", KARACHI, justAfterUtcMidnight).dayOfMonth).toBe(11);
  });

  it("handles a half-hour offset zone", () => {
    // 18:45 UTC on the 10th is 00:15 on the 11th in Kolkata.
    const now = new Date("2026-08-10T18:45:00Z");
    expect(monthShape("2026-08", KOLKATA, now).dayOfMonth).toBe(11);
    expect(monthShape("2026-08", UTC, now).dayOfMonth).toBe(10);
  });

  it("🔴 reads a CLOSED month as one day past its end", () => {
    /*
     * `daysInMonth + 1` is the contract: every day complete. Reporting the last
     * day instead would leave the 31st permanently "in progress" and exclude
     * its spend from the run rate forever — a month that would never finish
     * reconciling itself.
     */
    const september = new Date("2026-09-15T12:00:00Z");
    const s = monthShape("2026-08", UTC, september);
    expect(s.dayOfMonth).toBe(s.daysInMonth + 1);
  });

  it("reads a month that has not started as day 1", () => {
    // Nothing has happened yet, so there are zero complete days — never a
    // negative count, which would flip the sign of every projection downstream.
    const august = new Date("2026-08-10T12:00:00Z");
    expect(monthShape("2026-10", UTC, august).dayOfMonth).toBe(1);
  });

  it("is day 1 on the first of the month", () => {
    const first = new Date("2026-08-01T16:00:00Z"); // 09:00 LA
    expect(monthShape("2026-08", LA, first).dayOfMonth).toBe(1);
  });

  it("is the last day on the last day, not yet closed", () => {
    const last = new Date("2026-08-31T16:00:00Z"); // 09:00 LA on the 31st
    const s = monthShape("2026-08", LA, last);
    expect(s.dayOfMonth).toBe(31);
    expect(s.dayOfMonth).toBeLessThanOrEqual(s.daysInMonth);
  });
});

describe("currentMonthKey", () => {
  it("is the month it is in the client's timezone", () => {
    // 2026-09-01T04:00Z is September in UTC, still August in Los Angeles — so
    // an LA client's "this month" panel must still be showing August.
    const rollover = new Date("2026-09-01T04:00:00Z");
    expect(currentMonthKey(UTC, rollover)).toBe("2026-09");
    expect(currentMonthKey(LA, rollover)).toBe("2026-08");
  });

  it("agrees with monthShape about which month is current", () => {
    const now = new Date("2026-08-10T16:00:00Z");
    const key = currentMonthKey(LA, now);
    const shape = monthShape(key, LA, now);
    expect(shape.dayOfMonth).toBeLessThanOrEqual(shape.daysInMonth);
    expect(shape.monthKey).toBe(key);
  });
});

describe("localHour", () => {
  it("is the hour where the client is, not where the server is", () => {
    const t = new Date("2026-08-10T16:00:00Z");
    expect(localHour(UTC, t)).toBe(16);
    expect(localHour(LA, t)).toBe(9); // UTC-7 in summer
    expect(localHour(KARACHI, t)).toBe(21); // UTC+5
  });

  it("floors a half-hour offset rather than rounding it up", () => {
    // Kolkata is UTC+5:30: 16:00Z is 21:30 local, which is hour 21.
    expect(localHour(KOLKATA, new Date("2026-08-10T16:00:00Z"))).toBe(21);
  });

  it("stays inside 0–23 across midnight", () => {
    // 07:30Z is 00:30 in LA — hour 0, not 24.
    expect(localHour(LA, new Date("2026-08-11T07:30:00Z"))).toBe(0);
  });

  it("🔴 tracks the DST offset rather than a fixed one", () => {
    /*
     * The pacing alert's working-hours gate reads this. A fixed -8 for Los
     * Angeles would put every summer alert an hour early — and in the shoulder
     * hours, on the wrong side of the gate entirely.
     */
    const summer = new Date("2026-08-10T15:30:00Z"); // 08:30 PDT (UTC-7)
    const winter = new Date("2026-12-10T15:30:00Z"); // 07:30 PST (UTC-8)
    expect(localHour(LA, summer)).toBe(8);
    expect(localHour(LA, winter)).toBe(7);
  });
});
