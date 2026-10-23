import type { AdPlatform } from "@/lib/platforms";
import type { BoardWidget, WidgetQuery } from "./types";

/**
 * Everything a board widget can show: its stats, the ways they can be split,
 * the widget kinds, and the rules for which combinations are honest.
 *
 * ── Why one catalogue ──────────────────────────────────────────────────
 *
 * The dashboard's labels, formats, good/bad direction and definitions are
 * spread over about eight maps, each written for one screen. A board lets
 * anyone put any stat in any chart, so the rules that those screens enforce by
 * construction — never a pie of a ratio, never reach summed across days — have
 * to live in one place that every path (the picker, the save validation, the
 * aggregator) consults. This is that place.
 *
 * Pure and dependency-free apart from types, so the editor can import it in the
 * browser and the API can validate with it on the server.
 *
 * Every `statKey` points into `METRIC_POLARITY` (delta colour) and
 * `METRIC_DEFINITIONS` (the "what does this mean" popover); `catalog.test.ts`
 * holds the three in step.
 */

export const METRIC_IDS = [
  // Ad platform delivery (every platform).
  "spend",
  "impressions",
  "clicks",
  "ctr",
  "cpc",
  "cpm",
  // Meta only, from campaign and ad rows.
  "clicks_all",
  "fb_leads",
  "cp_fb_lead",
  "reach",
  "frequency",
  "landing_page_views",
  "video_3s_views",
  "hook_rate",
  "thruplays",
  // Meta only, parsed from the stored `actions` array.
  "post_reactions",
  "comments",
  "shares",
  "saves",
  "page_likes",
  "post_engagement",
  "purchases",
  "cp_purchase",
  // Each platform's own "Results" — what its Ads Manager counts.
  "results",
  "cost_per_result",
  // CRM, counted with the chosen platform's paid-lead rule.
  "leads",
  "contacted",
  "appointments",
  "showed",
  "no_show",
  "won",
  "lost",
  "cp_lead",
  "cp_appt",
  "cp_show",
  "cp_won",
  "book_pct",
  "show_pct",
  "close_pct",
  "optin_pct",
  "qualified_leads",
  "revenue",
  "roas",
  "avg_deal",
] as const;

export type MetricId = (typeof METRIC_IDS)[number];

export function isMetricId(v: unknown): v is MetricId {
  return typeof v === "string" && (METRIC_IDS as readonly string[]).includes(v);
}

export const DIMENSION_IDS = [
  "campaign",
  "adset",
  "ad",
  "creative",
  "age",
  "gender",
  "region",
  "placement",
  "device",
  // One row per kind of result — never added together.
  "result_type",
] as const;

export type DimensionId = (typeof DIMENSION_IDS)[number];

/** A table can also run one row per day; a chart split cannot (that is a series). */
export type TableDimension = DimensionId | "date";

export function isDimensionId(v: unknown): v is DimensionId {
  return typeof v === "string" && (DIMENSION_IDS as readonly string[]).includes(v);
}

export type MetricFormat = "currency" | "count" | "percent" | "decimal" | "multiple";

/**
 * Which stored data a stat is computed from. The aggregator loads only what the
 * widgets on a board actually need.
 *
 * - `ads`: platform delivery totals (campaign rows; Google/TikTok daily rows).
 * - `extras`: Meta campaign-row columns outside `AdTotals` and the `actions`
 *   array in `raw` (engagement, purchases, landing-page views, 3s plays).
 * - `adlevel`: Meta ad rows — the only rows carrying ThruPlays and plays.
 * - `crm`: funnel counts from the stage ledger.
 * - `revenue`: closed-won values.
 * - `reach`: one de-duplicated figure for the exact window.
 * - `results`: each platform's own "Results", per type (`metrics/results.ts`).
 */
export type MetricNeed = "ads" | "extras" | "adlevel" | "crm" | "revenue" | "reach" | "results";

export type MetricGroup =
  | "Spend and delivery"
  | "Platform results"
  | "Clicks"
  | "Engagement"
  | "Video"
  | "Meta conversions"
  | "CRM pipeline"
  | "CRM costs"
  | "CRM rates"
  | "Revenue";

export interface MetricDef {
  id: MetricId;
  label: string;
  /** A platform's own word for the same quantity ("Clicks" on Google). */
  labels?: Partial<Record<AdPlatform, string>>;
  format: MetricFormat;
  group: MetricGroup;
  /** Key into METRIC_POLARITY / METRIC_DEFINITIONS. */
  statKey: string;
  statKeys?: Partial<Record<AdPlatform, string>>;
  platforms: readonly AdPlatform[];
  /**
   * Sums across rows and days, and is never negative — so it may be a pie, and
   * a table total is a plain sum. Ratios and reach are not.
   */
  additive: boolean;
  /** May be drawn over time, per platform. */
  series: readonly AdPlatform[];
  /** The splits it supports, per platform. Empty = single value only. */
  dims: Partial<Record<AdPlatform, readonly DimensionId[]>>;
  /**
   * For a ratio split by a dimension: which volume decides the top N. Ranking a
   * cost-per by the cost itself puts the one-click campaign first.
   */
  rankBy?: MetricId;
  needs: readonly MetricNeed[];
}

const ALL: readonly AdPlatform[] = ["meta", "google", "tiktok"];
const META: readonly AdPlatform[] = ["meta"];

const AUDIENCE: readonly DimensionId[] = ["age", "gender", "region", "placement", "device"];
const META_EVERY: readonly DimensionId[] = ["campaign", "adset", "ad", "creative", ...AUDIENCE];
const CAMPAIGN_ONLY: readonly DimensionId[] = ["campaign"];
const AD_ROWS: readonly DimensionId[] = ["campaign", "adset", "ad"];
const DELIVERY_DIMS = { meta: META_EVERY, google: CAMPAIGN_ONLY, tiktok: CAMPAIGN_ONLY } as const;
const CRM_DIMS = { meta: CAMPAIGN_ONLY, google: CAMPAIGN_ONLY, tiktok: CAMPAIGN_ONLY } as const;
/**
 * Meta reports results per campaign and per ad; Google's are one type, so a
 * split by type would be a single bar. No creative or audience split: results
 * are not stored that way.
 */
const RESULT_DIMS = {
  meta: ["campaign", "adset", "ad", "result_type"],
  google: CAMPAIGN_ONLY,
  tiktok: ["campaign", "result_type"],
} as const satisfies Partial<Record<AdPlatform, readonly DimensionId[]>>;

function crmCount(id: MetricId, label: string, statKey: string): MetricDef {
  return {
    id,
    label,
    format: "count",
    group: "CRM pipeline",
    statKey,
    platforms: ALL,
    additive: true,
    series: ALL,
    dims: CRM_DIMS,
    needs: ["crm"],
  };
}

function crmCost(id: MetricId, label: string, statKey: string): MetricDef {
  return {
    id,
    label,
    format: "currency",
    group: "CRM costs",
    statKey,
    platforms: ALL,
    additive: false,
    series: ALL,
    dims: CRM_DIMS,
    rankBy: "spend",
    needs: ["ads", "crm"],
  };
}

function crmRate(id: MetricId, label: string, statKey: string, rankBy: MetricId): MetricDef {
  return {
    id,
    label,
    format: "percent",
    group: "CRM rates",
    statKey,
    platforms: ALL,
    additive: false,
    series: ALL,
    dims: CRM_DIMS,
    rankBy,
    needs: id === "optin_pct" ? ["ads", "crm"] : ["crm"],
  };
}

function metaAction(id: MetricId, label: string, statKey: string): MetricDef {
  return {
    id,
    label,
    format: "count",
    group: id === "purchases" ? "Meta conversions" : "Engagement",
    statKey,
    platforms: META,
    additive: true,
    series: META,
    dims: { meta: AD_ROWS },
    needs: ["extras", "adlevel"],
  };
}

export const METRICS: Record<MetricId, MetricDef> = {
  spend: {
    id: "spend",
    label: "Ad spend",
    format: "currency",
    group: "Spend and delivery",
    statKey: "spend",
    platforms: ALL,
    additive: true,
    series: ALL,
    dims: DELIVERY_DIMS,
    needs: ["ads"],
  },
  impressions: {
    id: "impressions",
    label: "Impressions",
    format: "count",
    group: "Spend and delivery",
    statKey: "impressions",
    platforms: ALL,
    additive: true,
    series: ALL,
    dims: DELIVERY_DIMS,
    needs: ["ads"],
  },
  clicks: {
    id: "clicks",
    label: "Link clicks",
    labels: { google: "Clicks", tiktok: "Clicks" },
    format: "count",
    group: "Clicks",
    statKey: "linkClicks",
    statKeys: { google: "clicks", tiktok: "clicks" },
    platforms: ALL,
    additive: true,
    series: ALL,
    dims: DELIVERY_DIMS,
    needs: ["ads"],
  },
  ctr: {
    id: "ctr",
    label: "CTR",
    format: "percent",
    group: "Clicks",
    statKey: "ctr",
    platforms: ALL,
    additive: false,
    series: ALL,
    dims: DELIVERY_DIMS,
    rankBy: "impressions",
    needs: ["ads"],
  },
  cpc: {
    id: "cpc",
    label: "Cost per link click",
    labels: { google: "Cost per click", tiktok: "Cost per click" },
    format: "currency",
    group: "Clicks",
    statKey: "cpc",
    platforms: ALL,
    additive: false,
    series: ALL,
    dims: DELIVERY_DIMS,
    rankBy: "spend",
    needs: ["ads"],
  },
  cpm: {
    id: "cpm",
    label: "CPM",
    format: "currency",
    group: "Spend and delivery",
    statKey: "cpm",
    platforms: ALL,
    additive: false,
    series: ALL,
    dims: DELIVERY_DIMS,
    rankBy: "spend",
    needs: ["ads"],
  },
  clicks_all: {
    id: "clicks_all",
    label: "Clicks (all)",
    format: "count",
    group: "Clicks",
    statKey: "clicksAll",
    platforms: META,
    additive: true,
    series: META,
    dims: { meta: AD_ROWS },
    needs: ["ads", "adlevel"],
  },
  fb_leads: {
    id: "fb_leads",
    label: "Leads (Meta-reported)",
    format: "count",
    group: "Meta conversions",
    statKey: "fbLeads",
    platforms: META,
    additive: true,
    series: META,
    dims: { meta: META_EVERY },
    needs: ["ads"],
  },
  cp_fb_lead: {
    id: "cp_fb_lead",
    label: "Cost per Meta lead",
    format: "currency",
    group: "Meta conversions",
    statKey: "cpFbLead",
    platforms: META,
    additive: false,
    series: META,
    dims: { meta: META_EVERY },
    rankBy: "spend",
    needs: ["ads"],
  },
  /*
   * Ads Manager's own "Results". A result is whatever a campaign optimises for,
   * so a widget counts ONE type — the range's main type, or the one it pins —
   * and never adds two together (see `metrics/results.ts`). Additive within
   * that type, so a pie of "Website leads by campaign" is honest; a pie by
   * result type is refused in `checkWidget`.
   */
  results: {
    id: "results",
    label: "Results",
    labels: { google: "Conversions" },
    format: "count",
    group: "Platform results",
    statKey: "results",
    statKeys: { google: "googleConversions" },
    platforms: ALL,
    additive: true,
    series: ALL,
    dims: RESULT_DIMS,
    needs: ["results"],
  },
  cost_per_result: {
    id: "cost_per_result",
    label: "Cost per result",
    labels: { google: "Cost per conversion" },
    format: "currency",
    group: "Platform results",
    statKey: "cpResult",
    statKeys: { google: "cpConversion" },
    platforms: ALL,
    additive: false,
    series: ALL,
    dims: RESULT_DIMS,
    rankBy: "results",
    needs: ["results"],
  },
  reach: {
    id: "reach",
    label: "Reach",
    format: "count",
    group: "Spend and delivery",
    statKey: "reach",
    platforms: META,
    additive: false,
    series: [],
    dims: {},
    needs: ["reach"],
  },
  frequency: {
    id: "frequency",
    label: "Frequency",
    format: "decimal",
    group: "Spend and delivery",
    statKey: "frequency",
    platforms: META,
    additive: false,
    series: [],
    dims: {},
    needs: ["reach"],
  },
  landing_page_views: {
    id: "landing_page_views",
    label: "Landing page views",
    format: "count",
    group: "Clicks",
    statKey: "landingPageViews",
    platforms: META,
    additive: true,
    series: META,
    dims: { meta: ["campaign", "adset", "ad", "creative"] },
    needs: ["extras", "adlevel"],
  },
  video_3s_views: {
    id: "video_3s_views",
    label: "3-second video plays",
    format: "count",
    group: "Video",
    statKey: "video3sViews",
    platforms: META,
    additive: true,
    series: META,
    dims: { meta: ["campaign", "adset", "ad", "creative"] },
    needs: ["extras", "adlevel"],
  },
  hook_rate: {
    id: "hook_rate",
    label: "Hook rate",
    format: "percent",
    group: "Video",
    statKey: "hookRate",
    platforms: META,
    additive: false,
    series: META,
    dims: { meta: ["adset", "ad", "creative"] },
    rankBy: "impressions",
    needs: ["adlevel"],
  },
  thruplays: {
    id: "thruplays",
    label: "ThruPlays",
    format: "count",
    group: "Video",
    statKey: "thruPlays",
    platforms: META,
    additive: true,
    series: META,
    dims: { meta: ["adset", "ad", "creative"] },
    needs: ["adlevel"],
  },
  post_reactions: metaAction("post_reactions", "Post reactions", "postReactions"),
  comments: metaAction("comments", "Post comments", "postComments"),
  shares: metaAction("shares", "Post shares", "postShares"),
  saves: metaAction("saves", "Post saves", "postSaves"),
  page_likes: metaAction("page_likes", "Page likes", "pageLikes"),
  post_engagement: metaAction("post_engagement", "Post engagement", "postEngagement"),
  purchases: metaAction("purchases", "Website purchases", "purchases"),
  cp_purchase: {
    id: "cp_purchase",
    label: "Cost per purchase",
    format: "currency",
    group: "Meta conversions",
    statKey: "cpPurchase",
    platforms: META,
    additive: false,
    series: META,
    dims: { meta: AD_ROWS },
    rankBy: "spend",
    needs: ["extras", "adlevel"],
  },
  leads: crmCount("leads", "Leads", "new_lead"),
  contacted: crmCount("contacted", "Contacted", "contacted"),
  appointments: crmCount("appointments", "Appointments", "appointment_booked"),
  showed: crmCount("showed", "Showed", "showed"),
  no_show: crmCount("no_show", "No-shows", "no_show"),
  won: crmCount("won", "Closed / won", "closed_won"),
  lost: crmCount("lost", "Lost", "lost"),
  cp_lead: crmCost("cp_lead", "Cost per lead", "cpLead"),
  cp_appt: crmCost("cp_appt", "Cost per appointment", "cpAppt"),
  cp_show: crmCost("cp_show", "Cost per show", "cpShow"),
  cp_won: crmCost("cp_won", "Cost per close", "cpWon"),
  book_pct: crmRate("book_pct", "Book rate", "bookPct", "leads"),
  show_pct: crmRate("show_pct", "Show rate", "showPct", "appointments"),
  close_pct: crmRate("close_pct", "Close rate", "closePct", "showed"),
  optin_pct: crmRate("optin_pct", "Opt-in rate", "optinPct", "clicks"),
  qualified_leads: {
    id: "qualified_leads",
    label: "Qualified leads",
    format: "count",
    group: "CRM pipeline",
    statKey: "new_lead_qualified",
    platforms: ALL,
    additive: true,
    series: [],
    dims: {},
    needs: ["crm"],
  },
  revenue: {
    id: "revenue",
    label: "Revenue",
    format: "currency",
    group: "Revenue",
    statKey: "revenue",
    platforms: ALL,
    additive: true,
    series: [],
    dims: {},
    needs: ["crm", "revenue"],
  },
  roas: {
    id: "roas",
    label: "ROAS",
    format: "multiple",
    group: "Revenue",
    statKey: "roas",
    platforms: ALL,
    additive: false,
    series: [],
    dims: {},
    needs: ["ads", "crm", "revenue"],
  },
  avg_deal: {
    id: "avg_deal",
    label: "Average deal",
    format: "currency",
    group: "Revenue",
    statKey: "avgDeal",
    platforms: ALL,
    additive: false,
    series: [],
    dims: {},
    needs: ["crm", "revenue"],
  },
};

export const METRIC_GROUPS: readonly MetricGroup[] = [
  "Spend and delivery",
  "Platform results",
  "Clicks",
  "Engagement",
  "Video",
  "Meta conversions",
  "CRM pipeline",
  "CRM costs",
  "CRM rates",
  "Revenue",
];

export function metricLabel(id: MetricId, platform: AdPlatform): string {
  const m = METRICS[id];
  return m.labels?.[platform] ?? m.label;
}

export function metricStatKey(id: MetricId, platform: AdPlatform): string {
  const m = METRICS[id];
  return m.statKeys?.[platform] ?? m.statKey;
}

export function metricSupports(id: MetricId, platform: AdPlatform): boolean {
  return METRICS[id].platforms.includes(platform);
}

export function metricDims(id: MetricId, platform: AdPlatform): readonly DimensionId[] {
  return METRICS[id].dims[platform] ?? [];
}

export function metricSeries(id: MetricId, platform: AdPlatform): boolean {
  return METRICS[id].series.includes(platform);
}

/** Stats a platform can show at all, in catalogue order. */
export function metricsFor(platform: AdPlatform): MetricId[] {
  return METRIC_IDS.filter((id) => metricSupports(id, platform));
}

/** May this stat be drawn as parts of a whole? Only sums that are never negative. */
export function canBeCircle(id: MetricId): boolean {
  return METRICS[id].additive;
}

export interface DimensionDef {
  id: DimensionId;
  label: string;
  /** Plural noun for a table heading, "Performance by ad". */
  rowNoun: string;
  /** Where the split comes from — decides history and coverage notes. */
  source: "campaign" | "ad_level" | "creative" | "breakdown" | "results";
  /**
   * Segments read in a natural order (age bands, genders) rather than by size.
   * A pie of age bands sorted by value scrambles the one ordering a reader expects.
   */
  natural: boolean;
}

export const DIMENSIONS: Record<DimensionId, DimensionDef> = {
  campaign: { id: "campaign", label: "Campaign", rowNoun: "campaign", source: "campaign", natural: false },
  adset: { id: "adset", label: "Ad set", rowNoun: "ad set", source: "ad_level", natural: false },
  ad: { id: "ad", label: "Ad", rowNoun: "ad", source: "ad_level", natural: false },
  creative: { id: "creative", label: "Creative", rowNoun: "creative", source: "creative", natural: false },
  age: { id: "age", label: "Age", rowNoun: "age band", source: "breakdown", natural: true },
  gender: { id: "gender", label: "Gender", rowNoun: "gender", source: "breakdown", natural: true },
  region: { id: "region", label: "Region", rowNoun: "region", source: "breakdown", natural: false },
  placement: { id: "placement", label: "Placement", rowNoun: "placement", source: "breakdown", natural: false },
  device: { id: "device", label: "Device", rowNoun: "device", source: "breakdown", natural: false },
  result_type: { id: "result_type", label: "Result type", rowNoun: "result type", source: "results", natural: false },
};

export function dimensionLabel(d: TableDimension): string {
  return d === "date" ? "Day" : DIMENSIONS[d].label;
}

/* ------------------------------------------------------------------ *
 * Widget kinds and visual forms
 * ------------------------------------------------------------------ */

export const WIDGET_KIND_IDS = [
  "kpi",
  "series",
  "category",
  "table",
  "funnel",
  "text",
  "logo",
] as const;

export type WidgetKind = (typeof WIDGET_KIND_IDS)[number];

export const SERIES_FORMS = ["line", "area", "column"] as const;
export type SeriesForm = (typeof SERIES_FORMS)[number];

export const CATEGORY_FORMS = ["bar", "hbar", "pie", "donut"] as const;
export type CategoryForm = (typeof CATEGORY_FORMS)[number];

export interface Size {
  w: number;
  h: number;
}

export interface WidgetKindDef {
  kind: WidgetKind;
  label: string;
  size: Size;
  min: Size;
  max: Size;
}

/**
 * Sizes in grid units: 12 columns, rows of 40px with 16px gaps.
 *
 * Every `max.h` stops at 12 rows (656px) so any widget fits on one landscape
 * PDF page — a widget taller than a page would have to be cut, and a chart cut
 * in half is two wrong charts.
 */
export const WIDGET_KINDS: Record<WidgetKind, WidgetKindDef> = {
  kpi: { kind: "kpi", label: "Single value", size: { w: 3, h: 3 }, min: { w: 2, h: 3 }, max: { w: 6, h: 6 } },
  series: { kind: "series", label: "Over time", size: { w: 6, h: 7 }, min: { w: 3, h: 5 }, max: { w: 12, h: 12 } },
  category: { kind: "category", label: "Split", size: { w: 4, h: 7 }, min: { w: 3, h: 5 }, max: { w: 12, h: 12 } },
  table: { kind: "table", label: "Table", size: { w: 12, h: 8 }, min: { w: 4, h: 4 }, max: { w: 12, h: 12 } },
  // Nine rows hold five stages, their drop-offs and the exits line unscrolled.
  funnel: { kind: "funnel", label: "Funnel", size: { w: 12, h: 9 }, min: { w: 6, h: 6 }, max: { w: 12, h: 12 } },
  text: { kind: "text", label: "Text", size: { w: 6, h: 2 }, min: { w: 2, h: 1 }, max: { w: 12, h: 12 } },
  logo: { kind: "logo", label: "Client logo", size: { w: 3, h: 3 }, min: { w: 2, h: 2 }, max: { w: 6, h: 6 } },
};

/** Widgets on one board. Here rather than in schema.ts so the editor can read it without zod. */
export const MAX_WIDGETS = 60;

export const TOP_N = { min: 3, max: 25, circleMax: 6 } as const;
export const TABLE_ROWS = { min: 5, max: 50 } as const;
export const TABLE_COLUMNS = { min: 1, max: 8 } as const;
export const TEXT_MAX = 2000;
export const TITLE_MAX = 80;

/** One option of the picker's "Visual" step. */
export interface VisualDef {
  id: string;
  label: string;
  kind: WidgetKind;
  form?: SeriesForm | CategoryForm;
}

export const VISUALS: readonly VisualDef[] = [
  { id: "kpi", label: "Single value", kind: "kpi" },
  { id: "line", label: "Line", kind: "series", form: "line" },
  { id: "area", label: "Area", kind: "series", form: "area" },
  { id: "column", label: "Columns over time", kind: "series", form: "column" },
  { id: "bar", label: "Vertical bar", kind: "category", form: "bar" },
  { id: "hbar", label: "Horizontal bar", kind: "category", form: "hbar" },
  { id: "pie", label: "Pie chart", kind: "category", form: "pie" },
  { id: "donut", label: "Donut chart", kind: "category", form: "donut" },
  { id: "table", label: "Table", kind: "table" },
  { id: "funnel", label: "Funnel", kind: "funnel" },
  { id: "text", label: "Text", kind: "text" },
  { id: "logo", label: "Client logo", kind: "logo" },
];

/* ------------------------------------------------------------------ *
 * Compatibility
 * ------------------------------------------------------------------ */

export type Check = { ok: true } | { ok: false; reason: string };

const OK: Check = { ok: true };
const no = (reason: string): Check => ({ ok: false, reason });

/**
 * Whether a widget asks for something the data can honestly answer.
 *
 * Used three ways: the picker greys out impossible choices (with this reason),
 * the save path refuses them, and the aggregator never has to guess.
 */
export function checkWidget(q: WidgetQuery): Check {
  if ("resultType" in q && q.resultType !== undefined) {
    const reads = widgetMetrics(q).some((m) => METRICS[m].needs.includes("results"));
    if (!reads) return no("Only a results widget can be set to one result type.");
  }
  switch (q.kind) {
    case "kpi": {
      if (!metricSupports(q.metric, q.platform)) {
        return no(`${METRICS[q.metric].label} is not available for ${platformName(q.platform)}.`);
      }
      return OK;
    }
    case "series": {
      if (!metricSupports(q.metric, q.platform)) {
        return no(`${METRICS[q.metric].label} is not available for ${platformName(q.platform)}.`);
      }
      if (!metricSeries(q.metric, q.platform)) {
        return no(
          q.metric === "reach" || q.metric === "frequency"
            ? "Reach counts distinct people across the whole range, so it cannot be drawn day by day."
            : `${METRICS[q.metric].label} is only available as a single value.`,
        );
      }
      return OK;
    }
    case "category": {
      if (!metricSupports(q.metric, q.platform)) {
        return no(`${METRICS[q.metric].label} is not available for ${platformName(q.platform)}.`);
      }
      if (!metricDims(q.metric, q.platform).includes(q.dimension)) {
        return no(
          `${METRICS[q.metric].label} cannot be split by ${DIMENSIONS[q.dimension].label.toLowerCase()} for ${platformName(q.platform)}.`,
        );
      }
      if ((q.form === "pie" || q.form === "donut") && !canBeCircle(q.metric)) {
        return no(
          `${METRICS[q.metric].label} is a rate or a cost, so its parts do not add up to a whole. Use a bar chart.`,
        );
      }
      if ((q.form === "pie" || q.form === "donut") && q.dimension === "result_type") {
        return no("Different kinds of result do not add up to a whole. Use a bar chart.");
      }
      if (q.topN < TOP_N.min || q.topN > TOP_N.max) {
        return no(`Show between ${TOP_N.min} and ${TOP_N.max} items.`);
      }
      return OK;
    }
    case "table": {
      if (q.metrics.length < TABLE_COLUMNS.min || q.metrics.length > TABLE_COLUMNS.max) {
        return no(`A table needs between ${TABLE_COLUMNS.min} and ${TABLE_COLUMNS.max} columns.`);
      }
      if (new Set(q.metrics).size !== q.metrics.length) return no("Each column can appear once.");
      if (!q.metrics.includes(q.sort)) return no("Sort by one of the table's columns.");
      for (const m of q.metrics) {
        if (!metricSupports(m, q.platform)) {
          return no(`${METRICS[m].label} is not available for ${platformName(q.platform)}.`);
        }
        if (q.dimension === "date") {
          if (!metricSeries(m, q.platform)) {
            return no(`${METRICS[m].label} has no day-by-day figure.`);
          }
        } else if (!metricDims(m, q.platform).includes(q.dimension)) {
          return no(
            `${METRICS[m].label} cannot be split by ${DIMENSIONS[q.dimension].label.toLowerCase()}.`,
          );
        }
      }
      if (q.topN < TABLE_ROWS.min || q.topN > TABLE_ROWS.max) {
        return no(`Show between ${TABLE_ROWS.min} and ${TABLE_ROWS.max} rows.`);
      }
      return OK;
    }
    case "funnel":
    case "text":
    case "logo":
      return OK;
  }
}

function platformName(p: AdPlatform): string {
  return p === "meta" ? "Meta" : p === "google" ? "Google" : "TikTok";
}

/** The title a widget shows when nobody typed one. */
export function defaultTitle(q: WidgetQuery): string {
  switch (q.kind) {
    case "kpi":
      return metricLabel(q.metric, q.platform);
    case "series":
      return `${metricLabel(q.metric, q.platform)} over time`;
    case "category":
      return q.dimension === "result_type"
        ? `${metricLabel(q.metric, q.platform)} by type`
        : `${metricLabel(q.metric, q.platform)} by ${DIMENSIONS[q.dimension].label.toLowerCase()}`;
    case "table":
      return q.dimension === "date"
        ? "Day by day"
        : q.metrics.includes("results")
          ? `${metricLabel("results", q.platform)} by ${DIMENSIONS[q.dimension].rowNoun}`
          : `Performance by ${DIMENSIONS[q.dimension].rowNoun}`;
    case "funnel":
      return "Pipeline funnel";
    case "text":
      return q.size === "heading" ? "Heading" : "Note";
    case "logo":
      return "Client logo";
  }
}

/** Metrics a widget reads, in display order. */
export function widgetMetrics(q: WidgetQuery): MetricId[] {
  switch (q.kind) {
    case "kpi":
    case "series":
    case "category":
      return [q.metric];
    case "table":
      return [...q.metrics];
    case "funnel":
      return ["leads"];
    default:
      return [];
  }
}

/* ------------------------------------------------------------------ *
 * Presets and the starter board
 * ------------------------------------------------------------------ */

export interface Preset {
  id: string;
  label: string;
  description: string;
  query: WidgetQuery;
  size?: Size;
}

const kpi = (platform: AdPlatform, metric: MetricId): WidgetQuery => ({
  kind: "kpi",
  platform,
  metric,
});

/**
 * Ready-made widgets — the picker's first tab. Built from the same queries a
 * user could assemble by hand, so nothing here is special-cased downstream.
 */
export const PRESETS: readonly Preset[] = [
  { id: "spend", label: "Ad spend", description: "Total spend, with change and trend", query: kpi("meta", "spend") },
  { id: "clicks", label: "Link clicks", description: "Clicks that opened the destination", query: kpi("meta", "clicks") },
  { id: "cpc", label: "Cost per link click", description: "Spend divided by link clicks", query: kpi("meta", "cpc") },
  { id: "impressions", label: "Impressions", description: "Times an ad was shown", query: kpi("meta", "impressions") },
  { id: "reach", label: "Reach", description: "Distinct people reached in the range", query: kpi("meta", "reach") },
  { id: "frequency", label: "Frequency", description: "Average times each person saw an ad", query: kpi("meta", "frequency") },
  { id: "ctr", label: "CTR", description: "Link clicks per impression", query: kpi("meta", "ctr") },
  { id: "cpm", label: "CPM", description: "Cost per thousand impressions", query: kpi("meta", "cpm") },
  { id: "reactions", label: "Post reactions", description: "Likes and other reactions on the ads", query: kpi("meta", "post_reactions") },
  { id: "comments", label: "Post comments", description: "Comments on the ads", query: kpi("meta", "comments") },
  { id: "lpv", label: "Landing page views", description: "Clicks that loaded the page", query: kpi("meta", "landing_page_views") },
  { id: "purchases", label: "Website purchases", description: "Purchases tracked by the pixel", query: kpi("meta", "purchases") },
  { id: "results", label: "Results", description: "What Ads Manager counts as results, with their type", query: kpi("meta", "results") },
  { id: "cost_per_result", label: "Cost per result", description: "Spend divided by results of that type", query: kpi("meta", "cost_per_result") },
  { id: "leads", label: "Leads", description: "New paid leads in the CRM", query: kpi("meta", "leads") },
  { id: "cp_lead", label: "Cost per lead", description: "Spend divided by CRM leads", query: kpi("meta", "cp_lead") },
  { id: "appointments", label: "Appointments", description: "Leads that booked", query: kpi("meta", "appointments") },
  { id: "won", label: "Closed / won", description: "Deals won", query: kpi("meta", "won") },
  { id: "revenue", label: "Revenue", description: "Value of deals won", query: kpi("meta", "revenue") },
  { id: "roas", label: "ROAS", description: "Revenue per unit of spend", query: kpi("meta", "roas") },
  {
    id: "spend_trend",
    label: "Spend over time",
    description: "Daily spend with the previous period",
    query: { kind: "series", platform: "meta", metric: "spend", form: "area", compare: true },
  },
  {
    id: "leads_trend",
    label: "Leads over time",
    description: "Daily CRM leads",
    query: { kind: "series", platform: "meta", metric: "leads", form: "column", compare: false },
  },
  {
    id: "results_trend",
    label: "Results over time",
    description: "Daily results of the main type",
    query: { kind: "series", platform: "meta", metric: "results", form: "column", compare: false },
  },
  {
    id: "results_by_type",
    label: "Results by type",
    description: "Every kind of result in the range, side by side",
    query: { kind: "category", platform: "meta", metric: "results", dimension: "result_type", form: "hbar", topN: 8 },
    size: { w: 6, h: 7 },
  },
  {
    id: "impressions_trend",
    label: "Impressions vs previous period",
    description: "Daily impressions against the period before",
    query: { kind: "series", platform: "meta", metric: "impressions", form: "line", compare: true },
  },
  {
    id: "gender",
    label: "Gender split",
    description: "Link clicks by gender",
    query: { kind: "category", platform: "meta", metric: "clicks", dimension: "gender", form: "donut", topN: 6 },
    size: { w: 6, h: 7 },
  },
  {
    id: "age",
    label: "Age split",
    description: "Link clicks by age band",
    query: { kind: "category", platform: "meta", metric: "clicks", dimension: "age", form: "donut", topN: 6 },
    size: { w: 6, h: 7 },
  },
  {
    id: "placement",
    label: "Spend by placement",
    description: "Where the money was spent",
    query: { kind: "category", platform: "meta", metric: "spend", dimension: "placement", form: "hbar", topN: 8 },
    size: { w: 6, h: 7 },
  },
  {
    id: "region",
    label: "Spend by region",
    description: "Spend per region",
    query: { kind: "category", platform: "meta", metric: "spend", dimension: "region", form: "hbar", topN: 10 },
    size: { w: 6, h: 8 },
  },
  {
    id: "device",
    label: "Spend by device",
    description: "Spend per device",
    query: { kind: "category", platform: "meta", metric: "spend", dimension: "device", form: "donut", topN: 6 },
  },
  {
    id: "campaign_spend",
    label: "Spend by campaign",
    description: "Top campaigns by spend",
    query: { kind: "category", platform: "meta", metric: "spend", dimension: "campaign", form: "hbar", topN: 8 },
    size: { w: 6, h: 7 },
  },
  {
    id: "ad_table",
    label: "Ad performance",
    description: "Impressions, clicks, CTR, CPC and spend per ad",
    query: {
      kind: "table",
      platform: "meta",
      dimension: "ad",
      metrics: ["impressions", "clicks", "ctr", "cpc", "spend"],
      sort: "spend",
      topN: 10,
    },
  },
  {
    id: "campaign_table",
    label: "Campaign performance",
    description: "Spend, clicks and CRM results per campaign",
    query: {
      kind: "table",
      platform: "meta",
      dimension: "campaign",
      metrics: ["spend", "impressions", "clicks", "ctr", "leads", "cp_lead"],
      sort: "spend",
      topN: 10,
    },
  },
  {
    id: "results_table",
    label: "Results by campaign",
    description: "Spend, results and cost per result per campaign",
    query: {
      kind: "table",
      platform: "meta",
      dimension: "campaign",
      metrics: ["spend", "results", "cost_per_result", "clicks", "ctr"],
      sort: "spend",
      topN: 10,
    },
  },
  {
    id: "daily_table",
    label: "Day by day",
    description: "One row per day",
    query: {
      kind: "table",
      platform: "meta",
      dimension: "date",
      metrics: ["spend", "impressions", "clicks", "leads", "cp_lead"],
      sort: "spend",
      topN: 31,
    },
  },
  { id: "funnel", label: "Pipeline funnel", description: "Where leads are lost between stages", query: { kind: "funnel", platform: "meta" } },
  { id: "heading", label: "Heading", description: "A section title", query: { kind: "text", text: "Section title", size: "heading" }, size: { w: 12, h: 1 } },
  { id: "note", label: "Note", description: "A paragraph of commentary", query: { kind: "text", text: "Add a note for your client here.", size: "body" } },
  { id: "logo", label: "Client logo", description: "The client's logo from Branding", query: { kind: "logo" } },
];

/**
 * A widget before its row is decided. Distributive, so each kind keeps its own
 * fields — a plain `Omit` over the union would keep only the shared ones.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type Unplaced = DistributiveOmit<BoardWidget, "y" | "h">;

export interface StarterContext {
  hasMeta: boolean;
  hasGoogle: boolean;
  hasTiktok: boolean;
  hasCrm: boolean;
  hasLogo: boolean;
  clientName: string;
}

/**
 * The board every client starts with, until someone saves their own.
 *
 * Computed, never stored: a stored copy of the defaults stops tracking them (the
 * same rule as the section layout's reset). Ids are fixed so the same starter
 * widget keeps its identity across renders and the editor's data cache hits.
 *
 * Meta-first, mirroring the Whatagraph report the agency used before: logo and
 * delivery tiles, engagement, the audience splits, the ad table, then the CRM
 * results that Whatagraph could not show at all.
 */
export function starterBoard(ctx: StarterContext): BoardWidget[] {
  const out: BoardWidget[] = [];
  let y = 0;
  const lead: AdPlatform = ctx.hasMeta ? "meta" : ctx.hasGoogle ? "google" : ctx.hasTiktok ? "tiktok" : "meta";

  const row = (h: number, items: Array<Unplaced>) => {
    for (const it of items) out.push({ ...it, y, h } as BoardWidget);
    y += h;
  };

  /*
   * Spend and the platform's own results first: results are what the agency
   * is judged on in Ads Manager, and for a client without a CRM they are the
   * only outcome there is. Two strips, not three — a third pushes the audience
   * charts off the first printed page.
   */
  row(3, [
    // The logo widget falls back to the client's name in a card until a logo
    // is uploaded, so the corner is never an empty slot.
    { id: "s-logo", kind: "logo", x: 0, w: 3 },
    { id: "s-spend", kind: "kpi", platform: lead, metric: "spend", x: 3, w: 3 },
    { id: "s-results", kind: "kpi", platform: lead, metric: "results", x: 6, w: 3 },
    { id: "s-cpresult", kind: "kpi", platform: lead, metric: "cost_per_result", x: 9, w: 3 },
  ]);

  if (lead === "meta") {
    row(3, [
      { id: "s-impressions", kind: "kpi", platform: "meta", metric: "impressions", x: 0, w: 3 },
      { id: "s-reach", kind: "kpi", platform: "meta", metric: "reach", x: 3, w: 3 },
      { id: "s-clicks", kind: "kpi", platform: "meta", metric: "clicks", x: 6, w: 3 },
      { id: "s-cpc", kind: "kpi", platform: "meta", metric: "cpc", x: 9, w: 3 },
    ]);
    row(7, [
      { id: "s-gender", kind: "category", platform: "meta", metric: "clicks", dimension: "gender", form: "donut", topN: 6, x: 0, w: 6 },
      { id: "s-age", kind: "category", platform: "meta", metric: "clicks", dimension: "age", form: "donut", topN: 6, x: 6, w: 6 },
    ]);
    row(8, [
      {
        id: "s-ads",
        kind: "table",
        platform: "meta",
        dimension: "ad",
        metrics: ["impressions", "clicks", "ctr", "cpc", "spend"],
        sort: "spend",
        topN: 10,
        x: 0,
        w: 12,
      },
    ]);
  } else {
    row(3, [
      { id: "s-impressions", kind: "kpi", platform: lead, metric: "impressions", x: 0, w: 3 },
      { id: "s-clicks", kind: "kpi", platform: lead, metric: "clicks", x: 3, w: 3 },
      { id: "s-ctr", kind: "kpi", platform: lead, metric: "ctr", x: 6, w: 3 },
      { id: "s-cpc", kind: "kpi", platform: lead, metric: "cpc", x: 9, w: 3 },
    ]);
    row(8, [
      {
        id: "s-campaigns",
        kind: "table",
        platform: lead,
        dimension: "campaign",
        metrics: ["spend", "impressions", "clicks", "ctr", "cpc"],
        sort: "spend",
        topN: 10,
        x: 0,
        w: 12,
      },
    ]);
  }

  if (ctx.hasCrm) {
    row(3, [
      { id: "s-leads", kind: "kpi", platform: lead, metric: "leads", x: 0, w: 3 },
      { id: "s-cplead", kind: "kpi", platform: lead, metric: "cp_lead", x: 3, w: 3 },
      { id: "s-appts", kind: "kpi", platform: lead, metric: "appointments", x: 6, w: 3 },
      { id: "s-won", kind: "kpi", platform: lead, metric: "won", x: 9, w: 3 },
    ]);
    row(9, [{ id: "s-funnel", kind: "funnel", platform: lead, x: 0, w: 12 }]);
  }

  if (lead === "meta" && ctx.hasGoogle) {
    row(1, [{ id: "s-google-heading", kind: "text", text: "Google Ads", size: "heading", x: 0, w: 12 }]);
    row(3, [
      { id: "s-g-spend", kind: "kpi", platform: "google", metric: "spend", x: 0, w: 3 },
      { id: "s-g-clicks", kind: "kpi", platform: "google", metric: "clicks", x: 3, w: 3 },
      { id: "s-g-results", kind: "kpi", platform: "google", metric: "results", x: 6, w: 3 },
      { id: "s-g-cpresult", kind: "kpi", platform: "google", metric: "cost_per_result", x: 9, w: 3 },
    ]);
  }

  if (lead !== "tiktok" && ctx.hasTiktok) {
    row(1, [{ id: "s-tiktok-heading", kind: "text", text: "TikTok Ads", size: "heading", x: 0, w: 12 }]);
    row(3, [
      { id: "s-t-spend", kind: "kpi", platform: "tiktok", metric: "spend", x: 0, w: 3 },
      { id: "s-t-clicks", kind: "kpi", platform: "tiktok", metric: "clicks", x: 3, w: 3 },
      { id: "s-t-results", kind: "kpi", platform: "tiktok", metric: "results", x: 6, w: 3 },
      { id: "s-t-cpresult", kind: "kpi", platform: "tiktok", metric: "cost_per_result", x: 9, w: 3 },
    ]);
  }

  return out;
}
