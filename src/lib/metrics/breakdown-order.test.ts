import { describe, it, expect } from "vitest";
import { orderSegments, type OrderableSegment } from "./breakdown-order";

/*
 * Imported from the pure module, never from `queries.ts` — a value import there
 * pulls in `@/db` and the suite dies on a missing DATABASE_URL.
 */
type BreakdownSegment = OrderableSegment & {
  impressions: number;
  linkClicks: number;
  leads: number;
  shareOfSegmented: number | null;
  cpLead: number | null;
  reach: number | null;
};

/*
 * Row order in an audience breakdown is a correctness property, not styling.
 *
 * Age is ordinal. Before this, every breakdown was sorted by spend descending —
 * so a client spending most on 25-34 saw that bracket rendered ABOVE 18-24, and
 * the distribution the panel exists to show was reordered out of existence. The
 * failure is invisible: the numbers are all correct, the shape is a lie.
 */

const seg = (value: string, spend: number): BreakdownSegment => ({
  value,
  spend,
  impressions: 0,
  linkClicks: 0,
  leads: 0,
  shareOfSegmented: null,
  cpLead: null,
  reach: null,
});

const values = (rows: BreakdownSegment[]) => rows.map((r) => r.value);

describe("🔴 age is ordinal and never sorted by spend", () => {
  it("keeps bracket order even when a later bracket spends far more", () => {
    const out = orderSegments("age", [
      seg("35-44", 10),
      seg("18-24", 900),
      seg("65+", 5),
      seg("25-34", 4000),
      seg("45-54", 40),
    ]);
    expect(values(out)).toEqual(["18-24", "25-34", "35-44", "45-54", "65+"]);
  });

  it("sorts 65+ after 55-64 rather than lexically", () => {
    // A string sort puts "65+" before "55-64"? No — but it puts "18-24" after
    // "13-17" only by luck, and breaks entirely once brackets reach 100+.
    // Parsing the lower bound is what makes this robust.
    const out = orderSegments("age", [seg("65+", 1), seg("55-64", 1), seg("13-17", 1)]);
    expect(values(out)).toEqual(["13-17", "55-64", "65+"]);
  });

  it("places a bracket Meta adds later in its numeric position, not at the end", () => {
    // The reason the bound is parsed instead of matched against a fixed list:
    // an unrecognised bracket swept to the end would silently misreport the
    // distribution rather than fail loudly.
    const out = orderSegments("age", [seg("75+", 1), seg("25-34", 1), seg("65-74", 1)]);
    expect(values(out)).toEqual(["25-34", "65-74", "75+"]);
  });
});

describe("gender holds a fixed order", () => {
  it("does not reorder when spend flips between periods", () => {
    // A two-row panel gains nothing from ranking, and rows that swap places
    // month to month cannot be compared at a glance.
    const janHeavyFemale = orderSegments("gender", [seg("male", 100), seg("female", 900)]);
    const febHeavyMale = orderSegments("gender", [seg("male", 900), seg("female", 100)]);
    expect(values(janHeavyFemale)).toEqual(values(febHeavyMale));
  });

  it("gives an unrecognised value a stable place rather than a spend-ranked one", () => {
    const out = orderSegments("gender", [
      seg("nonbinary", 5000),
      seg("male", 10),
      seg("female", 20),
    ]);
    expect(values(out)).toEqual(["female", "male", "nonbinary"]);
  });
});

describe("open-ended dimensions still rank by spend", () => {
  it.each(["region", "placement", "device"] as const)("%s sorts by spend desc", (key) => {
    // For these, ranking IS the information — the largest line of waste belongs
    // at the top, and region alone can run to dozens of rows.
    const out = orderSegments(key, [seg("b", 10), seg("c", 900), seg("a", 40)]);
    expect(values(out)).toEqual(["c", "a", "b"]);
  });
});

describe("🔴 unknown is last everywhere", () => {
  it.each(["region", "placement", "device", "age", "gender"] as const)(
    "%s puts unknown last even when it outspends every real segment",
    (key) => {
      /*
       * "unknown" is the absence of a segment, not a segment. Meta could not
       * classify those impressions. Letting it rank on spend puts a non-answer
       * at the top of the panel, which is exactly where a reader looks first.
       */
      const out = orderSegments(key, [
        seg("unknown", 99_999),
        seg("25-34", 10),
        seg("18-24", 20),
      ]);
      expect(out[out.length - 1].value).toBe("unknown");
      expect(out).toHaveLength(3);
    },
  );

  it("matches unknown case-insensitively and ignores surrounding space", () => {
    const out = orderSegments("device", [seg("  Unknown ", 900), seg("mobile", 10)]);
    expect(values(out)).toEqual(["mobile", "  Unknown "]);
  });
});

describe("ordering is total and lossless", () => {
  it.each(["region", "placement", "device", "age", "gender"] as const)(
    "%s returns every input row exactly once",
    (key) => {
      // A sort that drops a row would understate spend while still reconciling
      // against the account total via unsegmentedSpend — silently.
      const input = [seg("a", 3), seg("18-24", 2), seg("unknown", 1), seg("b", 4)];
      const out = orderSegments(key, input);
      expect(out).toHaveLength(input.length);
      expect([...values(out)].sort()).toEqual([...values(input)].sort());
    },
  );

  it("handles an empty group", () => {
    expect(orderSegments("age", [])).toEqual([]);
  });
});
