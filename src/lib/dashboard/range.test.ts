import { describe, it, expect } from "vitest";
import { MAX_RANGE_DAYS, eachDateKey, trailingWindow } from "@/lib/dates";
import { carriedRange, comparisonBasis, parseRangeParams, withRange } from "./range";

const TZ = "America/Los_Angeles";

describe("parseRangeParams", () => {
  it("defaults to the last 30 days, ending yesterday", () => {
    const w = parseRangeParams({}, TZ);
    const expected = trailingWindow(30, TZ);
    expect([w.startKey, w.endKey]).toEqual([expected.startKey, expected.endKey]);
  });

  it("uses a valid explicit range as given", () => {
    const w = parseRangeParams({ start: "2026-09-01", end: "2026-09-30", days: "7" }, TZ);
    expect([w.startKey, w.endKey]).toEqual(["2026-09-01", "2026-09-30"]);
  });

  it("falls back on junk rather than building an invalid window", () => {
    for (const sp of [
      { start: "foo", end: "2026-09-30" },
      { start: "2026-09-30", end: "2026-09-01" },
      { days: "1e11" },
      { days: "-4" },
      { days: "abc" },
    ]) {
      const w = parseRangeParams(sp, TZ);
      expect(w.startKey <= w.endKey).toBe(true);
      expect(eachDateKey(w, TZ).length).toBeLessThanOrEqual(MAX_RANGE_DAYS);
    }
  });

  it("caps days at the maximum range", () => {
    const w = parseRangeParams({ days: "5000" }, TZ);
    expect(eachDateKey(w, TZ).length).toBe(MAX_RANGE_DAYS);
  });

  it("caps a hand-typed decade to the maximum when asked, keeping its end", () => {
    const sp = { start: "2016-01-01", end: "2026-09-30" };
    const loose = parseRangeParams(sp, TZ);
    expect(loose.startKey).toBe("2016-01-01");
    const capped = parseRangeParams(sp, TZ, { clampExplicit: true });
    expect(capped.endKey).toBe("2026-09-30");
    expect(eachDateKey(capped, TZ).length).toBe(MAX_RANGE_DAYS);
  });

  it("reads the first value of a repeated parameter", () => {
    const w = parseRangeParams({ start: ["2026-09-01", "2020-01-01"], end: "2026-09-02" }, TZ);
    expect(w.startKey).toBe("2026-09-01");
  });
});

describe("comparisonBasis", () => {
  it("names the window the way the Overview tiles do", () => {
    expect(comparisonBasis(parseRangeParams({ start: "2026-09-01", end: "2026-09-30" }, TZ), TZ)).toBe(
      "previous 30 days",
    );
    expect(comparisonBasis(parseRangeParams({ start: "2026-09-01", end: "2026-09-01" }, TZ), TZ)).toBe(
      "previous day",
    );
  });
});

describe("carriedRange", () => {
  it("keeps a preset as a preset, so the picker still lights it", () => {
    expect(carriedRange({ range: "14d", days: "14" })).toBe("range=14d&days=14");
  });

  it("keeps a custom range as its dates", () => {
    expect(carriedRange({ start: "2026-09-01", end: "2026-09-30", days: "7" })).toBe(
      "start=2026-09-01&end=2026-09-30",
    );
  });

  it("drops anything malformed and carries nothing for the default", () => {
    expect(carriedRange({})).toBe("");
    expect(carriedRange({ days: "1e11", range: "<script>" })).toBe("");
    expect(carriedRange({ start: "2026-09-30", end: "2026-09-01" })).toBe("");
  });

  it("adds a query string only when there is one", () => {
    expect(withRange("/c/acme/board", "")).toBe("/c/acme/board");
    expect(withRange("/c/acme/board", "days=7")).toBe("/c/acme/board?days=7");
  });
});
