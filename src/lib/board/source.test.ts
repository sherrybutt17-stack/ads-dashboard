import { describe, it, expect } from "vitest";
import { BUILTIN_STATS } from "./catalog";
import {
  matchesSource,
  pickerGroup,
  pickerLabel,
  sourceBadge,
  sourceChoices,
  sourceNote,
  sourceTag,
  statSource,
  widgetSources,
} from "./source";

/**
 * Who counted a number — the ad platform or the CRM — as the Board picker
 * filters by it and as every tile names it. Meta's "Leads" and the CRM's
 * "Leads" are different numbers, and nothing on screen may let one pass for
 * the other.
 */

const def = (id: string) => BUILTIN_STATS.get(id as never)!;

describe("statSource", () => {
  it("🔴 tells the CRM's lead counts from the platforms'", () => {
    expect(statSource(def("leads"))).toBe("crm");
    expect(statSource(def("cp_lead"))).toBe("crm"); // spend ÷ CRM leads: the leads are the CRM's
    expect(statSource(def("appointments"))).toBe("crm");
    expect(statSource(def("revenue"))).toBe("crm");
    expect(statSource(def("results"))).toBe("platform");
    expect(statSource(def("spend"))).toBe("platform");
  });
});

describe("widgetSources", () => {
  it("reads every number a widget shows", () => {
    expect([...widgetSources({ kind: "kpi", platform: "meta", metric: "leads" }, BUILTIN_STATS)]).toEqual(["crm"]);
    expect([...widgetSources({ kind: "kpi", platform: "tiktok", metric: "results" }, BUILTIN_STATS)]).toEqual(["platform"]);
    const table = widgetSources(
      { kind: "table", platform: "meta", dimension: "campaign", metrics: ["spend", "leads", "cp_lead"], sort: "spend", topN: 10 },
      BUILTIN_STATS,
    );
    expect(table).toEqual(new Set(["platform", "crm"]));
  });

  it("knows the funnel is the CRM's, cards the platform's, and text nobody's", () => {
    expect([...widgetSources({ kind: "funnel", platform: "meta" } as never, BUILTIN_STATS)]).toEqual(["crm"]);
    expect([...widgetSources({ kind: "creatives", platform: "meta", by: "ad", stats: ["spend"], sort: "spend", topN: 6 } as never, BUILTIN_STATS)]).toEqual(["platform"]);
    expect(widgetSources({ kind: "text", text: "Hi", size: "heading" } as never, BUILTIN_STATS).size).toBe(0);
  });
});

describe("the picker's filter", () => {
  const crm = new Set(["crm"] as const);
  const own = new Set(["platform"] as const);
  const both = new Set(["platform", "crm"] as const);

  it("passes a widget whose numbers include the counter chosen", () => {
    expect(matchesSource(crm, "crm")).toBe(true);
    expect(matchesSource(own, "crm")).toBe(false);
    expect(matchesSource(both, "crm")).toBe(true);
    expect(matchesSource(both, "platform")).toBe(true);
    expect(matchesSource(new Set(), "all")).toBe(true);
    expect(matchesSource(new Set(), "platform")).toBe(false);
  });

  it("names the platform in its choices", () => {
    expect(sourceChoices("tiktok").map((c) => c.label)).toEqual(["All", "TikTok", "CRM"]);
  });

  it("badges every preset with its counter", () => {
    expect(sourceBadge(crm, "meta")).toBe("CRM");
    expect(sourceBadge(own, "tiktok")).toBe("TikTok");
    expect(sourceBadge(both, "meta")).toBe("Meta + CRM");
    expect(sourceBadge(new Set(), "meta")).toBeNull();
  });
});

describe("names in the picker", () => {
  it("🔴 says whose a stat is, so the closed select does too", () => {
    expect(pickerLabel("Leads", "crm", "meta")).toBe("Leads · CRM");
    expect(pickerLabel("Results", "platform", "tiktok")).toBe("Results · TikTok");
    // Already says whose it is.
    expect(pickerLabel("Leads (Meta-reported)", "platform", "meta")).toBe("Leads (Meta-reported)");
    expect(pickerLabel("On-Facebook leads", "platform", "meta")).toBe("On-Facebook leads");
  });

  it("heads each group with its counter", () => {
    expect(pickerGroup("CRM pipeline", ["leads", "appointments"], BUILTIN_STATS, "meta")).toBe("CRM · Pipeline");
    expect(pickerGroup("Revenue", ["revenue"], BUILTIN_STATS, "meta")).toBe("CRM · Revenue");
    expect(pickerGroup("Platform results", ["results"], BUILTIN_STATS, "tiktok")).toBe("TikTok · Platform results");
    // An agency's own metrics can mix counters; the heading says nothing it cannot.
    expect(pickerGroup("Custom metrics", ["spend", "leads"], BUILTIN_STATS, "meta")).toBe("Custom metrics");
  });

  it("explains, under the chosen stat, who counted it", () => {
    expect(sourceNote("crm", "tiktok")).toMatch(/CRM \(GoHighLevel\).*came from TikTok.*not TikTok's own count/);
    expect(sourceNote("platform", "meta")).toMatch(/Counted by Meta itself.*Not your CRM/);
    expect(sourceNote("platform", "tiktok")).toMatch(/Counted by TikTok itself/);
  });
});

describe("a tile's tag", () => {
  const crm = new Set(["crm"] as const);
  const own = new Set(["platform"] as const);

  it("🔴 always names the CRM — 'LEADS · META' over a CRM count said Meta counted it", () => {
    expect(sourceTag(crm, "meta", false)).toBe("CRM");
    expect(sourceTag(crm, "meta", true)).toBe("CRM · Meta");
    expect(sourceTag(new Set(["crm", "platform"] as const), "tiktok", false)).toBe("TikTok + CRM");
  });

  it("names the platform's own numbers only on a board that mixes platforms, as before", () => {
    expect(sourceTag(own, "meta", false)).toBeNull();
    expect(sourceTag(own, "meta", true)).toBe("Meta");
    expect(sourceTag(new Set(), null, true)).toBeNull();
  });
});
