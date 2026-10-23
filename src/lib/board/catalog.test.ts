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
      "clicks_all", "fb_leads", "cp_fb_lead", "reach", "frequency",
      "landing_page_views", "video_3s_views", "hook_rate", "thruplays",
      "post_reactions", "comments", "shares", "saves", "page_likes", "post_engagement",
      "purchases", "cp_purchase",
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
