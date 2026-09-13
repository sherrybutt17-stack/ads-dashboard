import { describe, expect, it } from "vitest";
import { outOfRangeNotice } from "./data-extent";

const w = { startKey: "2026-08-14", endKey: "2026-09-13" };

describe("outOfRangeNotice", () => {
  it("says nothing when the client has no ad data at all", () => {
    // That is the ad pipe's story (not connected / backfilling), not ours.
    expect(outOfRangeNotice(w, null)).toBeNull();
  });

  it("says nothing when the data overlaps the selected range", () => {
    // An empty result here is a real "no spend in this period — ads paused".
    expect(
      outOfRangeNotice(w, { firstKey: "2026-01-08", lastKey: "2026-09-13" }),
    ).toBeNull();
  });

  it("says nothing when the data merely touches the range on one day", () => {
    expect(
      outOfRangeNotice(w, { firstKey: "2024-01-01", lastKey: "2026-08-14" }),
    ).toBeNull();
    expect(
      outOfRangeNotice(w, { firstKey: "2026-09-13", lastKey: "2027-01-01" }),
    ).toBeNull();
  });

  it("points backwards for an account that stopped spending", () => {
    // The GIVR Media case: $13k of spend, all of it before April 2025.
    expect(
      outOfRangeNotice(w, { firstKey: "2024-07-20", lastKey: "2025-04-18" }),
    ).toEqual({
      firstKey: "2024-07-20",
      lastKey: "2025-04-18",
      direction: "before",
    });
  });

  it("points forwards when the range is behind the data", () => {
    // Someone shared a link to last year while the account only has this year.
    expect(
      outOfRangeNotice(
        { startKey: "2024-01-01", endKey: "2024-01-31" },
        { firstKey: "2026-01-08", lastKey: "2026-09-13" },
      ),
    ).toEqual({
      firstKey: "2026-01-08",
      lastKey: "2026-09-13",
      direction: "after",
    });
  });

  it("treats a single-day extent outside the range as out of range", () => {
    expect(
      outOfRangeNotice(w, { firstKey: "2025-04-18", lastKey: "2025-04-18" }),
    ).toEqual({
      firstKey: "2025-04-18",
      lastKey: "2025-04-18",
      direction: "before",
    });
  });
});
