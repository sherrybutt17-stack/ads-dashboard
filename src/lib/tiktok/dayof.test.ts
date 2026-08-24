import { describe, it, expect } from "vitest";
import { dayOf } from "./client";

describe("dayOf", () => {
  it("🔴 truncates TikTok's datetime to a date key", () => {
    /*
     * `stat_time_day` arrives as "2026-07-01 00:00:00", not "2026-07-01".
     * Postgres would accept the full string into a `date` column and discard
     * the time — but as a unique-constraint value the two strings are
     * different, so one day would produce two rows and every total would
     * double.
     */
    expect(dayOf("2026-07-01 00:00:00")).toBe("2026-07-01");
  });

  it("passes through a value that is already a date key", () => {
    expect(dayOf("2026-07-01")).toBe("2026-07-01");
  });

  it("returns null for anything it cannot date", () => {
    // A row that cannot be dated is skipped rather than dated today, which
    // would push yesterday's spend across a month boundary.
    expect(dayOf(undefined)).toBeNull();
    expect(dayOf("")).toBeNull();
    expect(dayOf("not a date")).toBeNull();
    expect(dayOf("07/01/2026")).toBeNull();
  });
});
