import { describe, it, expect } from "vitest";
import {
  GOOGLE_RESULT_TYPE,
  formatResultCount,
  mainResultType,
  metaResultType,
  metaResultsOf,
  othersFootnote,
  resultsHeadline,
  tiktokResultType,
  type TypedResults,
} from "./results";

/**
 * The rules for platform "Results", pure.
 *
 * Fixtures are the shapes Meta and TikTok actually returned on live accounts on
 * 24 Oct 2026 — including the zero day that has an indicator but no values.
 */

describe("metaResultType", () => {
  it("names the indicators seen on live accounts the way Ads Manager does", () => {
    expect(metaResultType("actions:offsite_conversion.fb_pixel_lead").label).toBe("Website leads");
    expect(metaResultType("actions:click_to_call_native_call_placed").label).toBe("Calls placed");
    expect(metaResultType("actions:post_engagement").label).toBe("Post engagements");
    expect(metaResultType("conversions:submit_application_website").label).toBe(
      "Website applications submitted",
    );
    expect(metaResultType("actions:lead").family).toBe("lead");
  });

  it("maps aliases onto one key, so a campaign that switched still adds up", () => {
    expect(metaResultType("actions:landing_page_view").key).toBe(
      metaResultType("actions:omni_landing_page_view").key,
    );
    expect(metaResultType("actions:purchase").key).toBe(metaResultType("actions:omni_purchase").key);
  });

  it("keeps an unknown or custom type readable, and its own key", () => {
    const custom = metaResultType("actions:offsite_conversion.custom.123456");
    expect(custom.label).toBe("Custom conversions");
    expect(custom.key).toBe("offsite_conversion.custom.123456");
    expect(metaResultType("actions:onsite_conversion.something_new").label).toBe("Something new");
  });

  it("marks reach as not additive", () => {
    expect(metaResultType("reach").additive).toBe(false);
    expect(metaResultType("actions:lead").additive).toBe(true);
  });
});

describe("metaResultsOf", () => {
  it("reads the live shape, including a zero day with no values", () => {
    expect(
      metaResultsOf({
        results: [
          { indicator: "actions:offsite_conversion.fb_pixel_lead", values: [{ value: "3", attribution_windows: ["default"] }] },
          { indicator: "actions:omni_landing_page_view" },
        ],
      }),
    ).toEqual([
      { indicator: "actions:offsite_conversion.fb_pixel_lead", count: 3 },
      { indicator: "actions:omni_landing_page_view", count: 0 },
    ]);
  });

  it("tolerates anything else", () => {
    expect(metaResultsOf(null)).toEqual([]);
    expect(metaResultsOf({ results: "x" })).toEqual([]);
    expect(metaResultsOf({ results: [{ values: [{ value: "1" }] }, null, { indicator: "a", values: [{ value: "lots" }] }] })).toEqual([
      { indicator: "a", count: 0 },
    ]);
  });
});

describe("tiktokResultType", () => {
  it("names the result from the campaign objective", () => {
    expect(tiktokResultType("LEAD_GENERATION")).toMatchObject({ label: "Leads", family: "lead", key: "tiktok:LEAD_GENERATION" });
    expect(tiktokResultType("REACH").additive).toBe(false);
    expect(tiktokResultType(null)).toMatchObject({ label: "Results", key: "tiktok:UNKNOWN" });
  });
});

const lead = metaResultType("actions:offsite_conversion.fb_pixel_lead");
const lpv = metaResultType("actions:omni_landing_page_view");
const reach = metaResultType("reach");
const t = (type: typeof lead, count: number, spend: number, pricedCount = count): TypedResults => ({
  type,
  count,
  spend,
  pricedCount,
});

describe("mainResultType", () => {
  it("is the additive type most money went to", () => {
    // King LASIK, 24 Oct: $8,679 on pixel-lead campaigns with 0 results, $108
    // on landing-page views. The headline is the leads — at 0 — not the views.
    expect(mainResultType([t(lead, 0, 8679.43), t(lpv, 826, 108.12)])?.key).toBe(lead.key);
  });

  it("never picks a non-additive type, and is null with nothing to show", () => {
    expect(mainResultType([t(reach, 5000, 900), t(lpv, 3, 10)])?.key).toBe(lpv.key);
    expect(mainResultType([])).toBeNull();
    expect(mainResultType([t(lead, 0, 0)])).toBeNull();
  });
});

describe("resultsHeadline", () => {
  it("shows the main type, its cost per result and the others", () => {
    const h = resultsHeadline([t(lead, 13, 806.34), t(lpv, 40, 12)]);
    expect(h.type?.key).toBe(lead.key);
    expect(h.count).toBe(13);
    expect(h.costPer).toBeCloseTo(62.03, 2);
    expect(h.others.map((o) => o.type.key)).toEqual([lpv.key]);
  });

  it("honours a pinned type, even at zero", () => {
    const h = resultsHeadline([t(lead, 13, 806.34), t(lpv, 40, 12)], { pinned: lpv.key });
    expect(h.type?.key).toBe(lpv.key);
    expect(h.costPer).toBeCloseTo(0.3, 5);
    const zero = resultsHeadline([t(lead, 13, 806)], {
      pinned: "click_to_call_native_call_placed",
      types: new Map([["click_to_call_native_call_placed", metaResultType("actions:click_to_call_native_call_placed")]]),
    });
    expect(zero).toMatchObject({ count: 0, costPer: null });
    expect(zero.type?.label).toBe("Calls placed");
  });

  it("has no cost per result without results", () => {
    expect(resultsHeadline([t(lead, 0, 500)]).costPer).toBeNull();
  });

  it("🔴 prices only the results from single-type days, so a mixed day is not free", () => {
    // 10 leads: 4 on a $100 lead-only day, 6 on a day that also optimised for
    // messages (its spend can't be split, so it is in no type's cost).
    const h = resultsHeadline([t(lead, 10, 100, 4)]);
    expect(h.count).toBe(10);
    expect(h.costPer).toBe(25); // $100 ÷ 4, not $100 ÷ 10
  });
});

describe("formatting", () => {
  it("keeps Google's fractions and rounds the rest", () => {
    expect(formatResultCount(3.75, GOOGLE_RESULT_TYPE)).toBe("3.75");
    expect(formatResultCount(1204, lead)).toBe("1,204");
  });

  it("names the other types in a footnote", () => {
    expect(othersFootnote([])).toBeNull();
    expect(othersFootnote([t(lpv, 826, 0)])).toBe("Also 826 landing page views.");
    expect(
      othersFootnote([t(lpv, 826, 0), t(metaResultType("actions:post_engagement"), 10, 0), t(lead, 2, 0)]),
    ).toBe("Also 826 landing page views and 10 post engagements (+1 more type).");
  });
});
