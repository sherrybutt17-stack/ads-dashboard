import { describe, it, expect } from "vitest";
import { barSlots, categorySlots, circleAllowed, shareLabel } from "./chart-rules";
import type { CategoryRow } from "./types";

const row = (key: string, tone?: CategoryRow["tone"]) => ({ key, tone });

describe("categorySlots", () => {
  it("🔴 pins gender and age colours whatever order the rows arrive in", () => {
    // Ranked by volume, so the order changes week to week; the colours must not.
    expect(categorySlots("gender", [row("male"), row("female")])).toEqual([2, 1]);
    expect(categorySlots("gender", [row("female"), row("male")])).toEqual([1, 2]);
    expect(categorySlots("age", [row("65+"), row("25-34"), row("18-24")])).toEqual([6, 2, 1]);
  });

  it("matches fixed keys case-insensitively", () => {
    expect(categorySlots("gender", [row("Female"), row("MALE")])).toEqual([1, 2]);
  });

  it("puts Other, Not reported and Meta's unknown bucket in neutral tones", () => {
    expect(
      categorySlots("gender", [row("female"), row("unknown"), row("_other", "other"), row("_nr", "not_reported")]),
    ).toEqual([1, "other", "other", "not_reported"]);
  });

  it("gives an unexpected value in a fixed split a free slot, never a pinned one", () => {
    // 1 and 2 belong to female and male; the next free hue is 3.
    expect(categorySlots("gender", [row("female"), row("nonbinary")])).toEqual([1, 3]);
  });

  it("🔴 never cycles: out of free hues, a row goes neutral", () => {
    // Age pins all seven slots, so a band Meta adds later has no hue to take.
    expect(categorySlots("age", [row("18-24"), row("75+")])).toEqual([1, "other"]);
    const campaigns = Array.from({ length: 9 }, (_, i) => row(`c${i}`));
    expect(categorySlots("campaign", campaigns)).toEqual([1, 2, 3, 4, 5, 6, 7, "other", "other"]);
  });

  it("never hands out the eighth slot, which is the status colour", () => {
    const many = Array.from({ length: 20 }, (_, i) => row(`r${i}`));
    for (const s of categorySlots("region", many)) {
      if (typeof s === "number") expect(s).toBeLessThanOrEqual(7);
    }
  });
});

describe("barSlots", () => {
  it("draws every bar of a free split in the one series colour", () => {
    const rows = Array.from({ length: 12 }, (_, i) => row(`c${i}`));
    expect(new Set(barSlots("campaign", rows))).toEqual(new Set([1]));
  });

  it("keeps the neutral tones", () => {
    expect(barSlots("campaign", [row("a"), row("_other", "other")])).toEqual([1, "other"]);
  });

  it("gives gender and age bars the colours of their donuts", () => {
    expect(barSlots("gender", [row("male"), row("female")])).toEqual([2, 1]);
  });
});

describe("circleAllowed", () => {
  it("allows parts of a positive whole", () => {
    expect(circleAllowed([{ value: 3 }, { value: 0 }, { value: null }])).toBe(true);
  });

  it("refuses a negative part, an empty whole and no data", () => {
    expect(circleAllowed([{ value: 5 }, { value: -1 }])).toBe(false);
    expect(circleAllowed([{ value: 0 }, { value: 0 }])).toBe(false);
    expect(circleAllowed([{ value: null }])).toBe(false);
    expect(circleAllowed([])).toBe(false);
  });
});

describe("shareLabel", () => {
  it("prints one place below 10% and none above", () => {
    expect(shareLabel(1, 40)).toBe("2.5%");
    expect(shareLabel(30, 40)).toBe("75%");
  });

  it("has no share without a whole", () => {
    expect(shareLabel(5, null)).toBeNull();
    expect(shareLabel(5, 0)).toBeNull();
    expect(shareLabel(null, 10)).toBeNull();
  });
});
