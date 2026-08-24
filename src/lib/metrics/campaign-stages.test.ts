import { describe, it, expect } from "vitest";
import {
  buildCampaignStages,
  COST_STAGES,
  type CampaignInput,
  type StageLag,
} from "./campaign-stages";
import type { CanonicalStage } from "@/db/schema";

/**
 * The blind spot this closes, stated as a fixture.
 *
 * `Cheap` produces leads at half the price of `Solid` and never books one.
 * Every screen in this category ranks it first, keep/kill scored it `scale`
 * before the deep-stage counts existed, and it is the most expensive thing in
 * the account. One click down the funnel inverts the ranking, and that
 * inversion is the whole feature.
 */

const campaign = (o: Partial<CampaignInput> & { campaignId: string }): CampaignInput => ({
  campaignName: o.campaignId,
  platform: "meta",
  spend: 0,
  impressions: 0,
  linkClicks: 0,
  ...o,
});

const funnel = (
  entries: Record<string, Partial<Record<CanonicalStage, number>>>,
): Map<string, Partial<Record<CanonicalStage, number>>> => new Map(Object.entries(entries));

const ALL_MAPPED = new Set<CanonicalStage>([
  "new_lead",
  "contacted",
  "appointment_booked",
  "showed",
  "no_show",
  "closed_won",
  "lost",
]);

const build = (
  campaigns: CampaignInput[],
  f: Map<string, Partial<Record<CanonicalStage, number>>>,
  opts: { mappedStages?: Set<CanonicalStage>; lag?: StageLag } = {},
) =>
  buildCampaignStages(campaigns, f, {
    mappedStages: opts.mappedStages ?? ALL_MAPPED,
    lag: opts.lag ?? {},
  });

/* ------------------------------------------------------------------ *
 * The blind spot
 * ------------------------------------------------------------------ */

describe("cheap leads that never book", () => {
  const campaigns = [
    campaign({ campaignId: "cheap", spend: 1000 }),
    campaign({ campaignId: "solid", spend: 1000 }),
  ];
  const counts = funnel({
    cheap: { new_lead: 50, appointment_booked: 1, closed_won: 0 },
    solid: { new_lead: 25, appointment_booked: 12, closed_won: 4 },
  });

  it("ranks Cheap first on leads, as every other tool does", () => {
    const b = build(campaigns, counts);
    const cheap = b.rows.find((r) => r.campaignId === "cheap")!;
    const solid = b.rows.find((r) => r.campaignId === "solid")!;
    expect(cheap.costs.new_lead.cost).toBeCloseTo(20, 6);
    expect(solid.costs.new_lead.cost).toBeCloseTo(40, 6);
  });

  it("🔴 inverts the ranking one stage down", () => {
    const b = build(campaigns, counts);
    const cheap = b.rows.find((r) => r.campaignId === "cheap")!;
    const solid = b.rows.find((r) => r.campaignId === "solid")!;
    // $1,000 for one appointment against $1,000 for twelve.
    expect(cheap.costs.appointment_booked.cost).toBeCloseTo(1000, 6);
    expect(solid.costs.appointment_booked.cost).toBeCloseTo(1000 / 12, 6);
    expect(cheap.costs.appointment_booked.cost!).toBeGreaterThan(
      solid.costs.appointment_booked.cost!,
    );
  });

  it("opens on the deepest stage the account actually reached", () => {
    // Opening on Leads would bury the number that answers whether the money
    // produced business; opening on Closed when nothing has closed would greet
    // the reader with an empty column.
    expect(build(campaigns, counts).defaultStage).toBe("closed_won");
  });

  it("falls back up the funnel when nothing reached the bottom", () => {
    const shallow = funnel({
      cheap: { new_lead: 50, appointment_booked: 3 },
      solid: { new_lead: 25, appointment_booked: 2 },
    });
    expect(build(campaigns, shallow).defaultStage).toBe("appointment_booked");
  });

  it("falls all the way back to leads for an account with only leads", () => {
    expect(build(campaigns, funnel({ cheap: { new_lead: 5 } })).defaultStage).toBe(
      "new_lead",
    );
  });

  it("defaults to leads rather than throwing on an account with nothing", () => {
    expect(build(campaigns, funnel({})).defaultStage).toBe("new_lead");
  });
});

/* ------------------------------------------------------------------ *
 * The denominator
 * ------------------------------------------------------------------ */

describe("every cost carries the count it came from", () => {
  it("🔴 pairs the figure with its conversions, at every stage", () => {
    /*
     * "$1,345 per closed deal" from one deal is not a rate. The plan's rule is
     * to show both rather than suppress the number — a tool that prints "3 of
     * 7" instead of a percentage looks like it knows less than it does — so the
     * pairing is structural: there is no way to read the cost without it.
     */
    const b = build(
      [campaign({ campaignId: "a", spend: 1345 })],
      funnel({ a: { new_lead: 9, closed_won: 1 } }),
    );
    const row = b.rows[0];
    expect(row.costs.closed_won).toEqual({ cost: 1345, conversions: 1 });
    for (const stage of COST_STAGES) {
      expect(row.costs[stage]).toHaveProperty("conversions");
    }
  });

  it("🔴 never reports free conversions when spend is zero", () => {
    // The exact figure the source spreadsheet printed: real conversions against
    // $0.00 spend, rendered as though they cost nothing.
    const b = build(
      [campaign({ campaignId: "unattributed", spend: 0 })],
      funnel({ unattributed: { new_lead: 25, appointment_booked: 4 } }),
    );
    expect(b.rows[0].costs.new_lead.cost).toBeNull();
    expect(b.rows[0].costs.appointment_booked.cost).toBeNull();
    // The counts survive — they are real, only the rate is undefined.
    expect(b.rows[0].counts.new_lead).toBe(25);
  });

  it("returns null, not zero, where nothing converted", () => {
    const b = build(
      [campaign({ campaignId: "a", spend: 500 })],
      funnel({ a: { new_lead: 10 } }),
    );
    expect(b.rows[0].costs.closed_won).toEqual({ cost: null, conversions: 0 });
  });

  it("gives a campaign with no ledger entry zeros rather than dropping it", () => {
    // A campaign that spent money and produced nothing is a finding. Omitting
    // its row would make the table's spend fail to reconcile with the KPI tile.
    const b = build([campaign({ campaignId: "silent", spend: 800 })], funnel({}));
    expect(b.rows).toHaveLength(1);
    expect(b.rows[0].counts).toEqual({
      new_lead: 0,
      appointment_booked: 0,
      showed: 0,
      closed_won: 0,
    });
  });
});

/* ------------------------------------------------------------------ *
 * Empty stages — result or misconfiguration
 * ------------------------------------------------------------------ */

describe("a stage with nothing in it", () => {
  const campaigns = [campaign({ campaignId: "a", spend: 500 })];
  const counts = funnel({ a: { new_lead: 20, appointment_booked: 6 } });

  it("🔴 says 'nobody showed' when the stage IS mapped", () => {
    const b = build(campaigns, counts);
    const showed = b.options.find((o) => o.stage === "showed")!;
    expect(showed.total).toBe(0);
    expect(showed.emptyReason).toContain("recorded in this period");
    expect(showed.emptyReason).not.toContain("mapped");
  });

  it("🔴 says 'nothing can be counted' when it is NOT mapped", () => {
    /*
     * The distinction the source spreadsheet could not make. It reported
     * SHOWN = 0 for its whole history against 13 real appointments, and nobody
     * could tell whether the clients never showed up or the column was never
     * wired. Those are opposite conclusions about a business.
     */
    const partial = new Set<CanonicalStage>(["new_lead", "appointment_booked"]);
    const b = build(campaigns, counts, { mappedStages: partial });
    const showed = b.options.find((o) => o.stage === "showed")!;
    expect(showed.emptyReason).toContain("No GHL stage is mapped");
  });

  it("says nothing at all when the stage has data", () => {
    const b = build(campaigns, counts);
    expect(b.options.find((o) => o.stage === "appointment_booked")!.emptyReason).toBeNull();
  });

  it("🔴 stays silent about mapping when the stage has data anyway", () => {
    // An unmapped stage that somehow has counts is not a story worth telling —
    // and claiming "nothing can be counted here" beside six appointments would
    // be visibly false.
    const b = build(campaigns, counts, {
      mappedStages: new Set<CanonicalStage>(["new_lead"]),
    });
    expect(b.options.find((o) => o.stage === "appointment_booked")!.emptyReason).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * The lag
 * ------------------------------------------------------------------ */

describe("how stale a deep-stage cost is", () => {
  const campaigns = [campaign({ campaignId: "a", spend: 500 })];
  const counts = funnel({ a: { new_lead: 20, appointment_booked: 6, closed_won: 3 } });

  it("carries the measured lag per stage", () => {
    const b = build(campaigns, counts, {
      lag: { appointment_booked: 4.2, closed_won: 34 },
    });
    expect(b.options.find((o) => o.stage === "appointment_booked")!.lagDays).toBeCloseTo(4.2, 6);
    expect(b.options.find((o) => o.stage === "closed_won")!.lagDays).toBe(34);
  });

  it("🔴 is zero for leads by definition, not merely unmeasured", () => {
    // A lead arrives the moment the click does. If this were null the UI would
    // print "the lag cannot be measured" against the one stage where there is
    // nothing to measure.
    const b = build(campaigns, counts, { lag: {} });
    expect(b.options.find((o) => o.stage === "new_lead")!.lagDays).toBe(0);
  });

  it("is null for a stage the query declined to measure", () => {
    const b = build(campaigns, counts, { lag: { closed_won: null } });
    expect(b.options.find((o) => o.stage === "closed_won")!.lagDays).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Shape
 * ------------------------------------------------------------------ */

describe("the stage list", () => {
  it("runs shallowest to deepest, which is the order a funnel is read in", () => {
    expect(COST_STAGES).toEqual([
      "new_lead",
      "appointment_booked",
      "showed",
      "closed_won",
    ]);
  });

  it("offers every stage, including the empty ones", () => {
    // Removing an empty stage from the control would hide the misconfiguration
    // message that only appears when it is selected.
    const b = build([campaign({ campaignId: "a", spend: 10 })], funnel({ a: { new_lead: 1 } }));
    expect(b.options.map((o) => o.stage)).toEqual([...COST_STAGES]);
  });

  it("totals each stage across every campaign", () => {
    const b = build(
      [campaign({ campaignId: "a", spend: 10 }), campaign({ campaignId: "b", spend: 10 })],
      funnel({ a: { closed_won: 2 }, b: { closed_won: 3 } }),
    );
    expect(b.options.find((o) => o.stage === "closed_won")!.total).toBe(5);
  });
});
