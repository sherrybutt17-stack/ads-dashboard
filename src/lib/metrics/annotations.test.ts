import { describe, it, expect } from "vitest";
// Imported from `./annotations`, NOT from `./queries` — the latter opens a
// database connection at module scope, which is the whole reason this logic
// lives in its own file.
import { deriveSpendAnnotations } from "./annotations";

/**
 * Trend annotations answer "what happened on the 14th?" — but only where
 * something actually did. An annotation layer that fires on noise is worse than
 * none: it trains the reader to ignore the marks, and then the one that mattered
 * goes unread too.
 */

const row = (date: string, campaign_id: string, spend: number, name = "Camp A") => ({
  date,
  campaign_id,
  campaign_name: name,
  spend,
});

const START = "2026-08-02";

describe("campaign launches and pauses", () => {
  it("marks the day a campaign starts spending", () => {
    const out = deriveSpendAnnotations(
      [row("2026-08-01", "c1", 0), row("2026-08-02", "c1", 40)],
      START,
    );
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("campaign_launched");
    expect(out[0].dateKey).toBe("2026-08-02");
  });

  it("marks the day it stops", () => {
    const out = deriveSpendAnnotations(
      [row("2026-08-02", "c1", 40), row("2026-08-03", "c1", 0)],
      START,
    );
    expect(out.map((a) => a.kind)).toEqual(["campaign_paused"]);
  });

  /*
   * The subtle one. The first row we hold is not the first day the campaign
   * ran — it is the first day we have DATA for. Calling that a launch would
   * announce a "campaign started" on the left edge of every chart, every time,
   * for campaigns that had been running for months.
   */
  it("does not call the first day of data a launch", () => {
    const out = deriveSpendAnnotations([row("2026-08-02", "c1", 40)], START);
    expect(out).toHaveLength(0);
  });

  it("never marks the lead-in day, which sits outside the visible range", () => {
    // The day before the window exists only to give day one something to
    // compare against. A mark there would render off the chart or on the wrong
    // tick.
    const out = deriveSpendAnnotations(
      [row("2026-08-01", "c1", 0), row("2026-08-02", "c1", 40)],
      START,
    );
    expect(out.every((a) => a.dateKey >= START)).toBe(true);
  });
});

describe("spend jumps", () => {
  /** Four steady days then the jump — enough history for a trailing baseline. */
  const steadyThen = (base: number, jump: number) => [
    row("2026-08-01", "c1", base),
    row("2026-08-02", "c1", base),
    row("2026-08-03", "c1", base),
    row("2026-08-04", "c1", jump),
  ];

  it("marks a 3x rise above the trailing average", () => {
    const out = deriveSpendAnnotations(steadyThen(100, 300), "2026-08-01");
    expect(out.map((a) => a.kind)).toEqual(["spend_jump"]);
    expect(out[0].label).toContain("×3.0");
    expect(out[0].dateKey).toBe("2026-08-04");
  });

  it("ignores a rise below 3x", () => {
    expect(deriveSpendAnnotations(steadyThen(100, 250), "2026-08-01")).toHaveLength(0);
  });

  /*
   * THE test, and it comes from production rather than imagination.
   *
   * A live account oscillates between $8 and $57 a day on one campaign at an
   * unchanged budget — ordinary delivery variance. Compared against YESTERDAY
   * that is a 5.6× "jump", and the chart would carry marks on a campaign where
   * nothing happened, repeatedly, until the reader stopped seeing them.
   */
  it("ignores ordinary daily oscillation at a steady budget", () => {
    const out = deriveSpendAnnotations(
      [
        row("2026-08-01", "c1", 37.81),
        row("2026-08-02", "c1", 14.61),
        row("2026-08-03", "c1", 49.51),
        row("2026-08-04", "c1", 8.16), // a big drop…
        row("2026-08-05", "c1", 45.74), // …then 5.6x yesterday. Not an event.
        row("2026-08-06", "c1", 54.34),
      ],
      "2026-08-01",
    );
    expect(out).toHaveLength(0);
  });

  it("still catches a budget that was actually raised and stayed raised", () => {
    const out = deriveSpendAnnotations(
      [
        row("2026-08-01", "c1", 40),
        row("2026-08-02", "c1", 45),
        row("2026-08-03", "c1", 38),
        row("2026-08-04", "c1", 160),
        row("2026-08-05", "c1", 155),
      ],
      "2026-08-01",
    );
    expect(out.map((a) => a.kind)).toEqual(["spend_jump"]);
    expect(out[0].dateKey).toBe("2026-08-04");
  });

  /*
   * The floor stays, but low — its job is only to stop pennies reading as
   * events. Set high it would silence small accounts entirely, and for a client
   * spending $40 a day a jump to $120 is the most significant thing that month.
   */
  it("ignores a 3x jump from a trivially small base", () => {
    expect(deriveSpendAnnotations(steadyThen(2, 20), "2026-08-01")).toHaveLength(0);
  });

  it("marks the same multiple once the base is material", () => {
    expect(deriveSpendAnnotations(steadyThen(50, 150), "2026-08-01")).toHaveLength(1);
  });

  it("says nothing until there is enough history to form a baseline", () => {
    // Two days is not a baseline. Guessing from one would reintroduce exactly
    // the day-to-day comparison this rule exists to avoid.
    const out = deriveSpendAnnotations(
      [row("2026-08-01", "c1", 40), row("2026-08-02", "c1", 400)],
      "2026-08-01",
    );
    expect(out).toHaveLength(0);
  });
});

describe("scoping", () => {
  it("tracks each campaign independently", () => {
    // c1 pauses while c2 launches on the same day: two separate facts, both
    // worth marking, neither cancelling the other out.
    const out = deriveSpendAnnotations(
      [
        row("2026-08-02", "c1", 80, "Alpha"),
        row("2026-08-03", "c1", 0, "Alpha"),
        row("2026-08-02", "c2", 0, "Beta"),
        row("2026-08-03", "c2", 90, "Beta"),
      ],
      START,
    );
    expect(out).toHaveLength(2);
    expect(out.map((a) => a.kind).sort()).toEqual([
      "campaign_launched",
      "campaign_paused",
    ]);
  });

  it("ignores the unattributed bucket, which is not a campaign", () => {
    const out = deriveSpendAnnotations(
      [row("2026-08-01", "", 0), row("2026-08-02", "", 500)],
      START,
    );
    expect(out).toHaveLength(0);
  });

  it("survives rows arriving out of order", () => {
    // The query orders them, but a caller need not — and a launch detected from
    // an unsorted list would compare the wrong pair of days.
    const out = deriveSpendAnnotations(
      [row("2026-08-03", "c1", 40), row("2026-08-02", "c1", 0)],
      "2026-08-01",
    );
    expect(out.map((a) => a.kind)).toEqual(["campaign_launched"]);
    expect(out[0].dateKey).toBe("2026-08-03");
  });

  it("uses the campaign name, falling back to its id", () => {
    const out = deriveSpendAnnotations(
      [
        { date: "2026-08-02", campaign_id: "c9", campaign_name: null, spend: 0 },
        { date: "2026-08-03", campaign_id: "c9", campaign_name: null, spend: 40 },
      ],
      START,
    );
    expect(out[0].label).toContain("c9");
  });
});
