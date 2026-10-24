import { describe, it, expect } from "vitest";
import { METRIC_POLARITY } from "@/lib/metrics/compute";
import { METRIC_DEFINITIONS } from "@/lib/metrics/definitions";
import { AD_PLATFORMS } from "@/lib/platforms";
import {
  METRICS,
  METRIC_IDS,
  PRESETS,
  checkWidget,
  canBeCircle,
  defaultTitle,
  metricDims,
  metricSeries,
  starterBoard,
  type MetricId,
} from "./catalog";
import { BoardWidgetSchema, WidgetQuerySchema } from "./schema";
import type { BoardWidget } from "./types";

const STARTERS = [
  { hasMeta: true, hasGoogle: false, hasTiktok: false, hasCrm: true, hasLogo: true },
  { hasMeta: true, hasGoogle: true, hasTiktok: false, hasCrm: true, hasLogo: false },
  { hasMeta: false, hasGoogle: true, hasTiktok: false, hasCrm: false, hasLogo: false },
  { hasMeta: false, hasGoogle: false, hasTiktok: true, hasCrm: true, hasLogo: true },
].map((c) => ({ ...c, clientName: "Acme Aesthetics" }));

function overlaps(a: BoardWidget, b: BoardWidget): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

describe("every stat explains itself", () => {
  it("has a definition and a good/bad direction for every key it uses", () => {
    const keys = new Set<string>();
    for (const m of Object.values(METRICS)) {
      keys.add(m.statKey);
      for (const k of Object.values(m.statKeys ?? {})) keys.add(k);
    }
    const undocumented = [...keys].filter((k) => !METRIC_DEFINITIONS[k]);
    const undirected = [...keys].filter((k) => !METRIC_POLARITY[k]);
    expect(undocumented).toEqual([]);
    expect(undirected).toEqual([]);
  });

  it("lists every stat once, in the record and the id list alike", () => {
    expect(Object.keys(METRICS).sort()).toEqual([...METRIC_IDS].sort());
    for (const id of METRIC_IDS) expect(METRICS[id].id).toBe(id);
  });

  /*
   * 🔴 A review gate, deliberately brittle. Every stat here is an aggregate —
   * none names a person, and none is an agency-only working tool — which is
   * what lets a client edit their own board and lets share links and PDFs
   * include every widget. Adding a stat that lists leads by name, or one only
   * staff should see, must come back here and add a gate to the save path,
   * the share snapshot and the PDF first.
   */
  it("contains only aggregate, client-safe stats", () => {
    expect([...METRIC_IDS]).toEqual([
      "spend", "impressions", "clicks", "ctr", "cpc", "cpm",
      "clicks_all", "ctr_all", "cpc_all", "fb_leads", "cp_fb_lead",
      // Meta's two lead counts apart — totals per ad, no lead details.
      "fb_onsite_leads", "cp_onsite_lead", "fb_pixel_leads", "cp_pixel_lead",
      "reach", "frequency",
      "landing_page_views", "land_rate", "video_3s_views", "hook_rate", "hold_rate", "thruplays",
      "post_reactions", "comments", "shares", "saves", "page_likes", "post_engagement",
      "purchases", "cp_purchase",
      // Each platform's own results: counts and spend, no lead details.
      "results", "cost_per_result",
      "leads", "contacted", "appointments", "showed", "no_show", "won", "lost",
      "cp_lead", "cp_appt", "cp_show", "cp_won",
      "book_pct", "show_pct", "close_pct", "optin_pct",
      "qualified_leads", "revenue", "roas", "avg_deal",
    ]);
  });
});

describe("the rules a chart cannot break", () => {
  it("never draws a rate or a cost as a pie", () => {
    const ratios = METRIC_IDS.filter((id) => !METRICS[id].additive);
    expect(ratios).toEqual(expect.arrayContaining(["ctr", "cpc", "cp_lead", "book_pct", "roas", "frequency"]));
    for (const metric of ratios) {
      for (const platform of METRICS[metric].platforms) {
        for (const dimension of metricDims(metric, platform)) {
          const v = checkWidget({ kind: "category", platform, metric, dimension, form: "pie", topN: 6 });
          expect(v.ok, `${metric} as a pie`).toBe(false);
        }
      }
    }
  });

  it("keeps reach and frequency to a single number for the exact range", () => {
    for (const metric of ["reach", "frequency"] as MetricId[]) {
      expect(metricSeries(metric, "meta")).toBe(false);
      expect(metricDims(metric, "meta")).toEqual([]);
      expect(canBeCircle(metric)).toBe(false);
      const series = checkWidget({ kind: "series", platform: "meta", metric, form: "line", compare: false });
      expect(series.ok).toBe(false);
      if (!series.ok) expect(series.reason).toMatch(/distinct people/i);
    }
  });

  it("only splits Google and TikTok by campaign", () => {
    for (const platform of ["google", "tiktok"] as const) {
      const v = checkWidget({
        kind: "category",
        platform,
        metric: "spend",
        dimension: "age",
        form: "bar",
        topN: 6,
      });
      expect(v.ok).toBe(false);
      expect(
        checkWidget({ kind: "category", platform, metric: "spend", dimension: "campaign", form: "bar", topN: 6 }).ok,
      ).toBe(true);
    }
  });

  it("refuses Meta-only stats on other platforms", () => {
    expect(checkWidget({ kind: "kpi", platform: "google", metric: "post_reactions" }).ok).toBe(false);
    expect(checkWidget({ kind: "kpi", platform: "meta", metric: "post_reactions" }).ok).toBe(true);
  });

  it("refuses a table sorted by a column it does not have, or a daily table of a single-value stat", () => {
    expect(
      checkWidget({ kind: "table", platform: "meta", dimension: "ad", metrics: ["spend"], sort: "ctr", topN: 10 }).ok,
    ).toBe(false);
    expect(
      checkWidget({ kind: "table", platform: "meta", dimension: "date", metrics: ["spend", "reach"], sort: "spend", topN: 10 }).ok,
    ).toBe(false);
  });

  it("has a split for every platform a stat that splits supports", () => {
    for (const id of METRIC_IDS) {
      for (const p of AD_PLATFORMS) {
        if (!METRICS[id].platforms.includes(p)) {
          expect(metricDims(id, p), `${id} on ${p}`).toEqual([]);
          expect(metricSeries(id, p), `${id} over time on ${p}`).toBe(false);
        }
      }
    }
  });
});

describe("presets and the starter board", () => {
  it("builds every preset from a query the validator accepts", () => {
    for (const p of PRESETS) {
      const parsed = WidgetQuerySchema.safeParse(p.query);
      expect(parsed.success, `${p.id}: ${parsed.success ? "" : parsed.error.message}`).toBe(true);
      expect(defaultTitle(p.query).length).toBeGreaterThan(0);
    }
    expect(new Set(PRESETS.map((p) => p.id)).size).toBe(PRESETS.length);
  });

  it("starts every kind of client with a valid board that has no overlaps", () => {
    for (const ctx of STARTERS) {
      const board = starterBoard(ctx);
      expect(board.length).toBeGreaterThan(3);
      expect(new Set(board.map((w) => w.id)).size).toBe(board.length);
      for (const w of board) {
        const parsed = BoardWidgetSchema.safeParse(w);
        expect(parsed.success, `${w.id}: ${parsed.success ? "" : parsed.error.message}`).toBe(true);
        expect(w.x + w.w).toBeLessThanOrEqual(12);
      }
      for (let i = 0; i < board.length; i++) {
        for (let j = i + 1; j < board.length; j++) {
          expect(overlaps(board[i], board[j]), `${board[i].id} overlaps ${board[j].id}`).toBe(false);
        }
      }
    }
  });

  it("leads with the platform the client actually runs", () => {
    const google = starterBoard(STARTERS[2]);
    const adWidgets = google.filter((w) => "platform" in w);
    expect(adWidgets.every((w) => "platform" in w && w.platform === "google")).toBe(true);
    // No Meta-only stats on a Google-only board, and no CRM rows without a CRM.
    expect(google.some((w) => w.kind === "funnel")).toBe(false);
  });

  it("adds a Google row only when Google is connected alongside Meta", () => {
    expect(starterBoard(STARTERS[0]).some((w) => "platform" in w && w.platform === "google")).toBe(false);
    expect(starterBoard(STARTERS[1]).some((w) => "platform" in w && w.platform === "google")).toBe(true);
  });
});

describe("platform results", () => {
  it("are on every platform, in each platform's own words", () => {
    for (const platform of AD_PLATFORMS) {
      expect(checkWidget({ kind: "kpi", platform, metric: "results" }).ok).toBe(true);
      expect(checkWidget({ kind: "kpi", platform, metric: "cost_per_result" }).ok).toBe(true);
    }
    expect(METRICS.results.labels?.google).toBe("Conversions");
    expect(METRICS.cost_per_result.labels?.google).toBe("Cost per conversion");
  });

  it("🔴 never adds two kinds of result into one whole", () => {
    const byType = (form: "pie" | "donut" | "hbar", platform: "meta" | "tiktok" = "meta") =>
      checkWidget({ kind: "category", platform, metric: "results", dimension: "result_type", form, topN: 6 });
    expect(byType("pie").ok).toBe(false);
    expect(byType("donut", "tiktok").ok).toBe(false);
    expect(byType("hbar").ok).toBe(true);
    // Google's results are one type, so there is nothing to split.
    expect(
      checkWidget({ kind: "category", platform: "google", metric: "results", dimension: "result_type", form: "hbar", topN: 6 }).ok,
    ).toBe(false);
    // And no other stat can be split by result type.
    expect(
      checkWidget({ kind: "category", platform: "meta", metric: "spend", dimension: "result_type", form: "hbar", topN: 6 }).ok,
    ).toBe(false);
  });

  it("ranks cost per result by results, never draws it as a pie", () => {
    expect(METRICS.cost_per_result.additive).toBe(false);
    expect(METRICS.cost_per_result.rankBy).toBe("results");
  });

  it("only lets a results widget pin a result type", () => {
    expect(
      checkWidget({ kind: "kpi", platform: "meta", metric: "results", resultType: "offsite_conversion.fb_pixel_lead" }).ok,
    ).toBe(true);
    expect(checkWidget({ kind: "kpi", platform: "meta", metric: "spend", resultType: "lead" }).ok).toBe(false);
    expect(
      WidgetQuerySchema.safeParse({ kind: "kpi", platform: "meta", metric: "results", resultType: "x y" }).success,
    ).toBe(false);
  });

  it("title a results table apart from the campaign performance one", () => {
    const table = (platform: "meta" | "google", metrics: Array<"spend" | "results" | "clicks">) =>
      defaultTitle({ kind: "table", platform, dimension: "campaign", metrics, sort: "spend", topN: 10 });
    expect(table("meta", ["spend", "results"])).toBe("Results by campaign");
    expect(table("google", ["spend", "results"])).toBe("Conversions by campaign");
    expect(table("meta", ["spend", "clicks"])).toBe("Performance by campaign");
  });

  it("are on the starter board for every connected platform, with or without a CRM", () => {
    for (const hasCrm of [true, false]) {
      const board = starterBoard({ hasMeta: true, hasGoogle: true, hasTiktok: true, hasCrm, hasLogo: false, clientName: "Acme" });
      const results = board.filter((w) => w.kind === "kpi" && w.metric === "results").map((w) => (w as { platform: string }).platform);
      expect(results.sort()).toEqual(["google", "meta", "tiktok"]);
      for (const w of board) expect(BoardWidgetSchema.safeParse(w).success, w.id).toBe(true);
    }
  });
});

describe("creative cards", () => {
  type Cards = Extract<Parameters<typeof checkWidget>[0], { kind: "creatives" }>;
  const cards = (over: Partial<Cards> = {}): Cards => ({
    kind: "creatives",
    platform: "meta",
    by: "ad",
    stats: ["impressions", "fb_onsite_leads", "cp_onsite_lead"],
    sort: "fb_onsite_leads",
    topN: 6,
    ...over,
  });

  it("are Meta's alone — Google and TikTok report no individual ads", () => {
    expect(checkWidget(cards()).ok).toBe(true);
    for (const platform of ["google", "tiktok"] as const) {
      const v = checkWidget(cards({ platform }));
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason).toMatch(/Meta only/);
    }
  });

  it("carry 1 to 6 different stats, each reported per ad or per creative", () => {
    expect(checkWidget(cards({ stats: [] })).ok).toBe(false);
    expect(checkWidget(cards({ stats: ["spend", "spend"] })).ok).toBe(false);
    expect(
      checkWidget(cards({ stats: ["spend", "impressions", "clicks", "ctr", "cpc", "cpm", "clicks_all"] })).ok,
    ).toBe(false);
    // Reach is one figure for a whole range: there is no per-ad reach to put on a card.
    expect(checkWidget(cards({ stats: ["reach"] })).ok).toBe(false);
    // Hook and hold exist per ad and per creative; so does every new Meta stat.
    for (const by of ["ad", "creative"] as const) {
      expect(
        checkWidget(cards({ by, stats: ["hook_rate", "hold_rate", "land_rate", "ctr_all", "cpc_all"], sort: "hook_rate" })).ok,
      ).toBe(true);
    }
  });

  it("🔴 refuse CRM stats with the reason, not a bare 'not supported'", () => {
    const v = checkWidget(cards({ stats: ["spend", "leads"] }));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/comes from the CRM/);
    expect(checkWidget(cards({ sort: "cp_lead" })).ok).toBe(false);
  });

  it("may rank by a stat that is not on the card", () => {
    expect(checkWidget(cards({ stats: ["impressions"], sort: "spend" })).ok).toBe(true);
  });

  it("bound the cards and the campaign filter", () => {
    expect(checkWidget(cards({ topN: 0 })).ok).toBe(false);
    expect(checkWidget(cards({ topN: 13 })).ok).toBe(false);
    expect(checkWidget(cards({ campaigns: ["120", "121"] })).ok).toBe(true);
    expect(checkWidget(cards({ campaigns: [] })).ok).toBe(false);
    expect(checkWidget(cards({ campaigns: ["120", "120"] })).ok).toBe(false);
    expect(checkWidget(cards({ campaigns: Array.from({ length: 21 }, (_, i) => String(100 + i)) })).ok).toBe(false);
  });

  it("take a pinned result type only when they read results", () => {
    expect(checkWidget(cards({ resultType: "onsite_conversion.lead_grouped" })).ok).toBe(false);
    expect(
      checkWidget(cards({ stats: ["spend", "results"], sort: "results", resultType: "onsite_conversion.lead_grouped" })).ok,
    ).toBe(true);
  });

  it("are titled by what ranks them", () => {
    expect(defaultTitle(cards())).toBe("Top ads by On-Facebook leads");
    expect(defaultTitle(cards({ by: "creative", sort: "spend" }))).toBe("Top creatives by Ad spend");
  });

  it("offer Whatagraph's two reports and the Overview's cards as presets", () => {
    const ids = PRESETS.filter((p) => p.query.kind === "creatives").map((p) => p.id);
    expect(ids).toEqual(["creative_cards", "ad_cards_leads", "ad_cards_clicks"]);
    for (const p of PRESETS.filter((x) => x.query.kind === "creatives")) {
      expect(WidgetQuerySchema.safeParse(p.query).success, p.id).toBe(true);
    }
  });
});
