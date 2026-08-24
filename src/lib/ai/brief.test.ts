import { describe, it, expect } from "vitest";
import { buildBrief, renderBrief } from "./brief";
import { verifyFigures } from "./verify";
import { EMPTY_FUNNEL, EMPTY_ADS, derive } from "@/lib/metrics/compute";
import type { DashboardData } from "@/lib/metrics/dashboard";
import type { RevenueTotals } from "@/lib/metrics/compute";

/**
 * What the model is told, and — more importantly — what it is told it may not
 * say.
 *
 * The brief is the only input to a generated summary, so a fact missing from it
 * is a fact the model has to invent or omit, and a caveat missing from it is a
 * claim nothing prevents.
 */

function makeData(over: Partial<DashboardData> = {}): DashboardData {
  const funnel = { ...EMPTY_FUNNEL, new_lead: 46, appointment_booked: 12, closed_won: 2 };
  const ads = { ...EMPTY_ADS, spend: 2847.32, impressions: 96_191, linkClicks: 742 };
  const revenue: RevenueTotals = { wonOpps: 2, wonWithValue: 2, revenue: 9600 };
  const current = {
    label: "Selected range",
    funnel,
    ads,
    derived: derive(funnel, ads, revenue),
    revenue,
  };
  return {
    platform: "meta",
    client: {
      id: "c1",
      name: "Parfaire",
      slug: "parfaire",
      timezone: "America/Los_Angeles",
      currency: "USD",
      lastSyncedAt: null,
      firstWebhookAt: null,
    },
    range: { startKey: "2026-07-15", endKey: "2026-08-13", label: "Jul 15 – Aug 13" },
    current,
    previous: current,
    deltas: { spend: 0.489, new_lead: 0.077, cpLead: 0.383 },
    funnel: [],
    daily: [],
    campaigns: [],
    pipelineDistribution: { stages: [], total: 0 },
    leads: [],
    speedToLead: {} as DashboardData["speedToLead"],
    heatmap: {} as DashboardData["heatmap"],
    prevDaily: [],
    annotations: [],
    anomalies: { findings: [], judgedDays: 30, testedDays: 30 },
    provisional: { totalRows: 0, provisionalRows: 0, since: null },
    creatives: [],
    creativeLeads: {} as DashboardData["creativeLeads"],
    adLevelSynced: true,
    creativesError: null,
    revenueCoverage: {
      totalDeals: 2,
      attributedDeals: 2,
      recentContactsWithAdId: 5,
      recentContacts: 10,
    },
    breakdowns: {} as DashboardData["breakdowns"],
    attributionGap: false,
    leadFilter: { mode: "all", tag: "", total: 46, attributed: 46, tagged: 0, paid: 46 },
    ...over,
  } as DashboardData;
}

const caveats = (d: DashboardData) => buildBrief(d, []).caveats.join(" ");

/* ------------------------------------------------------------------ *
 * The allow-list
 * ------------------------------------------------------------------ */

describe("the allowed figures", () => {
  it("admits every headline number the brief states", () => {
    const brief = buildBrief(makeData(), []);
    const text = brief.facts.map((f) => f.display).join(" ");
    // Round-trip: everything printed in the brief must survive its own check,
    // or the model is being handed figures it will be flagged for repeating.
    expect(verifyFigures(text, brief.allowed).ok).toBe(true);
  });

  it("admits a delta both as a ratio and as a percentage", () => {
    const brief = buildBrief(makeData(), []);
    expect(verifyFigures("Spend rose 48.9%.", brief.allowed).ok).toBe(true);
    // And the sign-flipped magnitude, because prose says "down 62.8%" for −0.628.
    const withFall = makeData({ deltas: { cpAppt: -0.628 } });
    const b2 = buildBrief(withFall, []);
    expect(verifyFigures("Cost per appointment fell 62.8%.", b2.allowed).ok).toBe(true);
  });

  it("does not admit a number that is merely nearby", () => {
    const brief = buildBrief(makeData(), []);
    expect(verifyFigures("We saw 47 leads.", brief.allowed).ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Revenue has three states
 * ------------------------------------------------------------------ */

describe("revenue", () => {
  const withRevenue = (r: RevenueTotals | null) => {
    const d = makeData();
    const funnel = { ...d.current.funnel };
    const ads = { ...d.current.ads };
    return makeData({
      current: {
        ...d.current,
        revenue: r,
        derived: derive(funnel, ads, r),
      } as DashboardData["current"],
    });
  };

  it("🔴 says UNKNOWN, not zero, when deals closed with no values recorded", () => {
    /*
     * The state that produces the confident false sentence: "the campaigns
     * generated no revenue" about a client who simply never types deal values
     * into GoHighLevel.
     */
    const d = withRevenue({ wonOpps: 3, wonWithValue: 0, revenue: 0 });
    const brief = buildBrief(d, []);
    const revenueFact = brief.facts.find((f) => f.label === "Revenue")!;

    expect(revenueFact.display).toContain("–");
    expect(revenueFact.display).not.toContain("$0.00");
    expect(caveats(d)).toMatch(/UNKNOWN, not zero/);

    // 🔴 And the enforcement, not merely the instruction: "$0" is not an
    // allowed money figure, so writing it is flagged.
    expect(verifyFigures("Revenue was $0 this period.", brief.allowed).ok).toBe(false);
  });

  it("🔴 does not contradict itself between the figures and the caveats", () => {
    /*
     * Found in this file's own live output: the brief printed "Revenue: $0.00,
     * ROAS 0.0×" directly above a caveat saying revenue was unknown. Two stories
     * in one document is worse than either, because the model picks.
     */
    const d = withRevenue({ wonOpps: 3, wonWithValue: 0, revenue: 0 });
    const rendered = renderBrief(buildBrief(d, []));
    expect(rendered).not.toMatch(/Revenue: \$0\.00/);
    expect(rendered).not.toMatch(/Return on ad spend: 0\.0×/);
  });

  it("says zero — and that it can still grow — when nothing closed at all", () => {
    // A different fact from "we do not know", and a genuinely true one.
    const d = withRevenue({ wonOpps: 0, wonWithValue: 0, revenue: 0 });
    expect(caveats(d)).toMatch(/genuinely zero/);
    expect(caveats(d)).toMatch(/can still close later/);
    expect(buildBrief(d, []).facts.find((f) => f.label === "Revenue")!.display).toBe("$0.00");
  });

  it("calls a partially valued figure a floor", () => {
    const d = withRevenue({ wonOpps: 5, wonWithValue: 2, revenue: 9600 });
    expect(caveats(d)).toMatch(/floor rather than a total/);
  });

  it("states the figure plainly when every deal carries a value", () => {
    const d = withRevenue({ wonOpps: 2, wonWithValue: 2, revenue: 9600 });
    expect(caveats(d)).not.toMatch(/floor|UNKNOWN|genuinely zero/);
  });
});

/* ------------------------------------------------------------------ *
 * The other constraints
 * ------------------------------------------------------------------ */

describe("caveats name what the data cannot support", () => {
  it("🔴 distinguishes missing attribution from absent leads", () => {
    // "The advertising produced no leads" is a claim about the ads. The truth
    // may be a claim about the tracking, and they lead opposite ways.
    const d = makeData({ attributionGap: true });
    expect(caveats(d)).toMatch(/attribution is missing|NOT ONE lead/);
    expect(caveats(makeData())).not.toMatch(/NOT ONE lead/);
  });

  it("names the paid-lead filter so the count is not read as total volume", () => {
    const d = makeData({
      leadFilter: { mode: "attributed", tag: "", total: 702, attributed: 14, tagged: 0, paid: 14 },
    });
    expect(caveats(d)).toContain("14 paid leads out of 702");
  });

  it("warns that recent Meta figures can still move", () => {
    const d = makeData({
      provisional: { totalRows: 30, provisionalRows: 12, since: "2026-08-01" },
    });
    expect(caveats(d)).toContain("2026-08-01");
  });

  it("forbids commenting on creatives when creative data failed to load", () => {
    const d = makeData({ creativesError: "column does not exist" });
    expect(caveats(d)).toMatch(/Do not comment on individual images or videos/);
  });

  it("forbids attributing a deal to an ad when no lead carries an ad id", () => {
    const d = makeData({
      revenueCoverage: {
        totalDeals: 4,
        attributedDeals: 0,
        recentContactsWithAdId: 0,
        recentContacts: 20,
      },
    });
    expect(caveats(d)).toMatch(/specific ad or video/);
  });

  it("does not pad — a healthy account gets few constraints", () => {
    // A caveat block that always fires is one the model learns to skim, exactly
    // like a disclaimer footer that appears on every page.
    expect(buildBrief(makeData(), []).caveats.length).toBeLessThanOrEqual(1);
  });
});

describe("the rendered brief", () => {
  it("carries the constraints section wherever there are constraints", () => {
    const d = makeData({ attributionGap: true });
    expect(renderBrief(buildBrief(d, []))).toContain("WHAT THIS DATA CANNOT SUPPORT");
  });

  it("names the client, the period, the platform and the currency", () => {
    const out = renderBrief(buildBrief(makeData(), []));
    expect(out).toContain("Parfaire");
    expect(out).toContain("Jul 15 – Aug 13");
    expect(out).toContain("Facebook / Meta");
    expect(out).toContain("USD");
  });
});
