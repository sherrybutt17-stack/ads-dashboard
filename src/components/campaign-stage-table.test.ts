import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AdsetPanel, CampaignStageTable } from "./CampaignStageTable";
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

describe("the ad set panel under an opened campaign", () => {
  const stages = buildCampaignStages(
    [{ campaignId: "c1", campaignName: "EVO - Seattle", platform: "meta", spend: 600, impressions: 0, linkClicks: 0 }],
    new Map([["c1", { new_lead: 4 }]]),
    { mappedStages: new Set<CanonicalStage>(["new_lead"]), lag: {} },
    {
      rows: [
        {
          campaignId: "c1", adsetId: "a1", adsetName: "EVO - FB (18-60)", spend: 500, impressions: 20000, linkClicks: 250, metaLeads: 10,
          result: { label: "Website leads", count: 10, costPer: 50, decimals: 0 },
        },
      ],
      funnel: new Map([["c1", new Map([["a1", { new_lead: 3 }]])]]),
      adLevelSince: "2026-09-25",
      ads: [{ adsetId: "a1", adId: "ad1", adName: "Video ad", spend: 500 }],
    },
  );
  const html = renderToStaticMarkup(
    createElement(AdsetPanel, {
      campaignName: "EVO - Seattle",
      adsets: stages.rows[0].adsets!,
      color: "#e66",
      option: stages.options[0],
      currency: "USD",
    }),
  );

  it("has its own headings — delivery first, then the CRM stage", () => {
    for (const h of ["1 ad set", "Spend", "Results", "Cost / result", "Impr.", "Link clicks", "CTR", "CPC", "CPM", "Leads", "CP-Lead"]) {
      expect(html).toContain(`>${h}</th>`);
    }
  });

  it("shows each ad set's own rates", () => {
    expect(html).toContain(">EVO - FB (18-60)<");
    expect(html).toContain(">20,000<"); // impressions
    expect(html).toContain(">1.25%<"); // CTR 250 / 20,000
    expect(html).toContain(">$2.00<"); // CPC 500 / 250
    expect(html).toContain(">$25.00<"); // CPM 500 / 20,000 × 1,000
    expect(html).toContain(">$50.00<"); // cost per result
    expect(html).toContain(">Website leads<"); // the result's type, under its count
  });

  it("opens each ad set onto its ads", () => {
    expect(html).toContain('aria-label="Show ads in EVO - FB (18-60)"');
    expect(html).not.toContain(">Video ad<"); // collapsed until asked
  });

  it("keeps the remainder honest: its spend and leads, no invented rates", () => {
    // $100 of campaign spend and 1 CRM lead have no ad set.
    expect(html).toContain("Not split by ad set");
    const rest = html.slice(html.indexOf("Not split by ad set"));
    expect(rest).toContain(">$100.00<");
    expect(rest.match(/>–</g)?.length).toBe(8); // impr, clicks, CTR, CPC, CPM, Meta leads, cost/Meta lead, CP-Lead
  });
});
