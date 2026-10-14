import { describe, it, expect } from "vitest";
import { periodProblem, presetRange } from "./PeriodFilter";

/*
 * The date maths behind the Share and Export period choices. Presets end
 * YESTERDAY, like the dashboard's own, because today is partial.
 */
describe("presetRange", () => {
  it("ends the trailing windows yesterday", () => {
    expect(presetRange("7", "2026-10-15")).toEqual({ start: "2026-10-08", end: "2026-10-14" });
    expect(presetRange("30", "2026-10-15")).toEqual({ start: "2026-09-15", end: "2026-10-14" });
  });

  it("takes last month as the whole previous calendar month, across a year end", () => {
    expect(presetRange("last-month", "2026-10-15")).toEqual({ start: "2026-09-01", end: "2026-09-30" });
    expect(presetRange("last-month", "2027-01-03")).toEqual({ start: "2026-12-01", end: "2026-12-31" });
    expect(presetRange("last-month", "2028-03-10")).toEqual({ start: "2028-02-01", end: "2028-02-29" });
  });

  it("runs this month from the 1st to yesterday", () => {
    expect(presetRange("this-month", "2026-10-15")).toEqual({ start: "2026-10-01", end: "2026-10-14" });
  });
});

describe("periodProblem", () => {
  const today = "2026-10-15";
  const sel = (start: string, end: string) => ({ start, end, platform: "meta" as const });

  it("accepts an ordinary range", () => {
    expect(periodProblem(sel("2026-09-01", "2026-09-30"), today)).toBeNull();
  });

  it("refuses a range that runs backwards, starts in the future, or is incomplete", () => {
    expect(periodProblem(sel("2026-10-10", "2026-10-01"), today)).toMatch(/after the end/);
    expect(periodProblem(sel("2026-10-20", "2026-10-21"), today)).toMatch(/future/);
    expect(periodProblem(sel("", "2026-10-01"), today)).toMatch(/both/);
  });

  it("refuses a range longer than the dashboard allows", () => {
    expect(periodProblem(sel("2025-01-01", "2026-10-14"), today)).toMatch(/or fewer/);
  });
});
