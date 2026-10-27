import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CampaignStageTable } from "./CampaignStageTable";
import { buildCampaignStages } from "@/lib/metrics/campaign-stages";
import type { CanonicalStage } from "@/db/schema";

/** The Ads tab's campaign table renders its ad-set controls, and only where there are ad sets. */

const data = buildCampaignStages(
  [
    { campaignId: "c1", campaignName: "EVO - Seattle", platform: "meta", spend: 500, impressions: 0, linkClicks: 0 },
    { campaignId: "c2", campaignName: "Webinar", platform: "meta", spend: 80, impressions: 0, linkClicks: 0 },
  ],
  new Map([["c1", { new_lead: 4 }]]),
  { mappedStages: new Set<CanonicalStage>(["new_lead"]), lag: {} },
  {
    rows: [{ campaignId: "c1", adsetId: "a1", adsetName: "Broad", spend: 300 }],
    funnel: new Map([["c1", new Map([["a1", { new_lead: 3 }]])]]),
    adLevelSince: "2026-10-03",
  },
);

const html = renderToStaticMarkup(
  createElement(CampaignStageTable, {
    data,
    currency: "USD",
    campaignColors: { c1: "#e66", c2: "#66e" },
    spendLabel: "Meta",
    lagUnmeasurable: 0,
  }),
);

describe("CampaignStageTable with ad sets", () => {
  it("offers ad sets for the campaign that has them, and only that one", () => {
    expect(html).toContain('aria-label="Show ad sets for EVO - Seattle"');
    expect(html).not.toContain("Show ad sets for Webinar");
    expect(html).toContain("Show all ad sets");
    // Collapsed until asked.
    expect(html).not.toContain(">Broad<");
  });

  it("explains spend it can't split", () => {
    expect(html).toContain("Some spend isn’t split by ad set");
    expect(html).toContain("Oct 3, 2026");
  });

  it("renders as before when there are no ad sets (Google, TikTok)", () => {
    const plain = renderToStaticMarkup(
      createElement(CampaignStageTable, {
        data: buildCampaignStages(
          [{ campaignId: "g1", campaignName: "Search", platform: "google", spend: 50, impressions: 0, linkClicks: 0 }],
          new Map(),
          { mappedStages: new Set<CanonicalStage>(["new_lead"]), lag: {} },
        ),
        currency: "USD",
        campaignColors: {},
        spendLabel: "Google",
        lagUnmeasurable: 0,
      }),
    );
    expect(plain).toContain("Search");
    expect(plain).not.toMatch(/ad sets?/i);
  });
});
