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
  "ctr_all",
  "cpc_all",
  "fb_leads",
  "cp_fb_lead",
  "fb_onsite_leads",
  "cp_onsite_lead",
  "fb_pixel_leads",
  "cp_pixel_lead",
  "reach",
  "frequency",
  "landing_page_views",
  "land_rate",
  "video_3s_views",
  "hook_rate",
  "hold_rate",
  "thruplays",
  // Meta, parsed from the stored `actions` array — and TikTok's own likes,
  // comments and shares beside them, so its engagement reads in that order.
  "post_reactions",
  "likes",
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
  /*
   * Every other figure each platform reports, computed by `MetricDef.calc`
   * rather than a case of its own in `metricValue`.
   */
  // Meta landing page cost, and clicks that left Facebook.
  "cp_lpv",
  "outbound_clicks",
  "outbound_ctr",
  "cp_outbound_click",
  // Meta engagement.
  "page_engagement",
  "photo_views",
  "post_engagement_rate",
  "cp_engagement",
  "cp_page_like",
  // Video views — Google's TrueView views and TikTok's — then TikTok's 2- and 6-second views.
  "video_views",
  "view_rate",
  "cpv",
  "video_2s",
  "video_6s",
  // Meta video, from ad rows; TikTok reports the same quartiles.
  "video_plays",
  "video_p25",
  "video_p50",
  "video_p75",
  "video_p95",
  "video_p100",
  "cp_thruplay",
  "cp_3s_play",
  // Meta conversions, each with its cost.
  "registrations",
  "cp_registration",
  "contacts",
  "cp_contact",
  "schedules",
  "cp_schedule",
  "applications",
  "cp_application",
  "adds_to_cart",
  "cp_add_to_cart",
  "checkouts",
  "cp_checkout",
  "content_views",
  "cp_content_view",
  "calls_placed",
  "cp_call",
  "messaging_conversations",
  "cp_messaging_conversation",
  // Google.
  "all_conversions",
  "cp_all_conversion",
  "conversion_value",
  "conv_value_per_cost",
  "all_conversions_value",
  "view_through_conversions",
  "conversion_rate",
  "interactions",
  "interaction_rate",
  "engagements",
  "engagement_rate",
  "phone_calls",
  // TikTok.
  "conversions",
  "cp_conversion",
  "cvr",
  "follows",
  "cp_follow",
  "profile_visits",
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
 * - `extras`: figures outside `AdTotals` — on Meta, campaign-row columns and
 *   the `actions` array in `raw` (engagement, purchases, landing-page views,
 *   3s plays); on Google and TikTok, the extra figures their syncs store in
 *   `raw` and their own conversions column (`metrics/platform-extras.ts`).
 * - `adlevel`: Meta ad rows — the only rows carrying ThruPlays and plays.
 * - `crm`: funnel counts from the stage ledger.
 * - `revenue`: closed-won values.
 * - `reach`: one de-duplicated figure for the exact window.
 * - `results`: each platform's own "Results", per type (`metrics/results.ts`).
 */
export type MetricNeed = "ads" | "extras" | "adlevel" | "crm" | "revenue" | "reach" | "results";

/** The picker's headings — Whatagraph's field groups, plus the CRM's. */
export type MetricGroup =
  | "Performance"
  | "Platform results"
  | "Conversions"
  | "Engagement"
  | "Video"
  | "CRM pipeline"
  | "CRM costs"
  | "CRM rates"
  | "Revenue";

/**
 * A quantity a stat is computed from: one of the bag's base counts, or an
 * extra figure by its key in `Bag.x` (`x.video_p25`). Every `x.` key is one a
 * platform's sync stores — `catalog.test.ts` holds the two in step.
 */
export type BagRef =
  | "spend"
  | "impressions"
  | "linkClicks"
  | "clicksAll"
  | "landingPageViews"
  | "video3sViews"
  | "videoPlays"
  | "thruPlays"
  | "postEngagement"
  | "pageLikes"
  | `x.${string}`;

/**
 * How a stat is computed from one row's components. The first set of stats
 * keep their own cases in `metricValue`; every stat added since is one of:
 *
 * - `sum` — the quantity itself;
 * - `per` — spend ÷ the quantity, with `costPer`'s refusal to call results
 *   with no spend "free";
 * - `ratio` — one quantity ÷ another.
 *
 * All three read the row's SUMMED components, so a total is never an average.
 */
export type MetricCalc =
  | { sum: BagRef }
  | { per: BagRef }
  | { ratio: readonly [BagRef, BagRef] };

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
  /**
   * On Meta, only ad rows carry it (ThruPlays, plays, quartiles), so even its
   * totals and days are read from ad rows — never from campaign rows, which
   * have none. Meta's rule alone: another platform reporting the same figure
   * (TikTok's quartiles) reads its own daily rows.
   */
  adRows?: true;
  /** How the value is computed, for stats without a case of their own in `metricValue`. */
  calc?: MetricCalc;
  /** A shorter label where space is tight, such as a creative card. */
  short?: string;
}

const ALL: readonly AdPlatform[] = ["meta", "google", "tiktok"];
const META: readonly AdPlatform[] = ["meta"];
const GOOGLE: readonly AdPlatform[] = ["google"];
const TIKTOK: readonly AdPlatform[] = ["tiktok"];
const META_TIKTOK: readonly AdPlatform[] = ["meta", "tiktok"];
const GOOGLE_TIKTOK: readonly AdPlatform[] = ["google", "tiktok"];

const AUDIENCE: readonly DimensionId[] = ["age", "gender", "region", "placement", "device"];
const META_EVERY: readonly DimensionId[] = ["campaign", "adset", "ad", "creative", ...AUDIENCE];
const CAMPAIGN_ONLY: readonly DimensionId[] = ["campaign"];
/** Campaign rows and ad rows both carry it, so every Meta split but the audience ones. */
const AD_ROWS: readonly DimensionId[] = ["campaign", "adset", "ad", "creative"];
/** Only ad rows carry it (`MetricDef.adRows`), so no split by campaign rows either. */
const AD_ONLY: readonly DimensionId[] = ["adset", "ad", "creative"];
const DELIVERY_DIMS = { meta: META_EVERY, google: CAMPAIGN_ONLY, tiktok: CAMPAIGN_ONLY } as const;
const CRM_DIMS = { meta: CAMPAIGN_ONLY, google: CAMPAIGN_ONLY, tiktok: CAMPAIGN_ONLY } as const;
/**
 * Meta reports results per campaign and per ad (and so per creative, from the
 * ad rows); Google's are one type, so a split by type would be a single bar. No
 * audience split: results are not stored that way.
 */
const RESULT_DIMS = {
  meta: ["campaign", "adset", "ad", "creative", "result_type"],
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
    group: id === "purchases" ? "Conversions" : "Engagement",
    statKey,
    platforms: META,
    additive: true,
    series: META,
    dims: { meta: AD_ROWS },
    needs: ["extras", "adlevel"],
  };
}

/**
 * A count from Meta's `actions` array (`META_ACTION_FAMILIES`): campaign rows
 * and ad rows both carry it, so it splits every way but by audience.
 */
function metaFamily(
  id: MetricId,
  label: string,
  statKey: string,
  group: MetricGroup,
  short?: string,
): MetricDef {
  return {
    id,
    label,
    format: "count",
    group,
    statKey,
    platforms: META,
    additive: true,
    series: META,
    dims: { meta: AD_ROWS },
    needs: ["extras", "adlevel"],
    calc: { sum: `x.${id}` },
    ...(short ? { short } : {}),
  };
}

/** Meta spend ÷ a count that campaign rows and ad rows both carry. */
function metaCost(
  id: MetricId,
  label: string,
  statKey: string,
  group: MetricGroup,
  of: BagRef,
  short?: string,
): MetricDef {
  return {
    id,
    label,
    format: "currency",
    group,
    statKey,
    platforms: META,
    additive: false,
    series: META,
    dims: { meta: AD_ROWS },
    rankBy: "spend",
    needs: ["ads", "extras", "adlevel"],
    calc: { per: of },
    ...(short ? { short } : {}),
  };
}

/** A figure only Meta's ad rows carry (`adRows`): every number of it is read from them. */
function metaAdRow(
  id: MetricId,
  label: string,
  statKey: string,
  group: MetricGroup,
  calc: MetricCalc,
  more: Partial<MetricDef> = {},
): MetricDef {
  const additive = "sum" in calc;
  return {
    id,
    label,
    format: "per" in calc ? "currency" : additive ? "count" : "percent",
    group,
    statKey,
    platforms: META,
    additive,
    series: META,
    dims: { meta: AD_ONLY },
    needs: ["adlevel"],
    adRows: true,
    calc,
    ...(additive ? {} : { rankBy: "per" in calc ? "spend" : "impressions" }),
    ...more,
  };
}

/** A Google or TikTok figure from its daily rows: split by campaign, drawn day by day. */
function simple(
  platforms: readonly AdPlatform[],
  id: MetricId,
  label: string,
  statKey: string,
  group: MetricGroup,
  calc: MetricCalc,
  format: MetricFormat,
  more: Partial<MetricDef> = {},
): MetricDef {
  const additive = "sum" in calc;
  // Spend or delivery in the formula means the delivery totals are loaded too.
  const reads = "sum" in calc ? [calc.sum] : "per" in calc ? ["spend", calc.per] : [...calc.ratio];
  const delivery = reads.some((r) => !r.startsWith("x."));
  return {
    id,
    label,
    format,
    group,
    statKey,
    platforms,
    additive,
    series: platforms,
    dims: Object.fromEntries(platforms.map((p) => [p, CAMPAIGN_ONLY])),
    needs: delivery ? ["ads", "extras"] : ["extras"],
    calc,
    ...(additive ? {} : { rankBy: "per" in calc ? "spend" : "impressions" }),
    ...more,
  };
}

/** A video quartile: Meta from its ad rows, TikTok from its daily rows. */
function quartile(id: MetricId, pct: number, statKey: string, tiktokKey: string): MetricDef {
  return {
    id,
    label: `Video plays at ${pct}%`,
    labels: { tiktok: `Video views at ${pct}%` },
    short: `Plays at ${pct}%`,
    format: "count",
    group: "Video",
    statKey,
    statKeys: { tiktok: tiktokKey },
    platforms: META_TIKTOK,
    additive: true,
    series: META_TIKTOK,
    dims: { meta: AD_ONLY, tiktok: CAMPAIGN_ONLY },
    needs: ["adlevel", "extras"],
    adRows: true,
    calc: { sum: `x.${id}` },
  };
}

export const METRICS: Record<MetricId, MetricDef> = {
  spend: {
    id: "spend",
    label: "Ad spend",
    format: "currency",
    group: "Performance",
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
    group: "Performance",
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
    group: "Performance",
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
    group: "Performance",
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
    group: "Performance",
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
    group: "Performance",
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
    group: "Performance",
    statKey: "clicksAll",
    platforms: META,
    additive: true,
    series: META,
    dims: { meta: AD_ROWS },
    needs: ["ads", "adlevel"],
  },
  ctr_all: {
    id: "ctr_all",
    label: "CTR (all)",
    format: "percent",
    group: "Performance",
    statKey: "ctrAll",
    platforms: META,
    additive: false,
    series: META,
    dims: { meta: AD_ROWS },
    rankBy: "impressions",
    needs: ["ads", "adlevel"],
  },
  cpc_all: {
    id: "cpc_all",
    label: "Cost per click (all)",
    short: "CPC (all)",
    format: "currency",
    group: "Performance",
    statKey: "cpcAll",
    platforms: META,
    additive: false,
    series: META,
    dims: { meta: AD_ROWS },
    rankBy: "spend",
    needs: ["ads", "adlevel"],
  },
  fb_leads: {
    id: "fb_leads",
    label: "Leads (Meta-reported)",
    format: "count",
    group: "Conversions",
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
    group: "Conversions",
    statKey: "cpFbLead",
    platforms: META,
    additive: false,
    series: META,
    dims: { meta: META_EVERY },
    rankBy: "spend",
    needs: ["ads"],
  },
  /*
   * Meta's two lead counts, kept apart: Instant Form leads submitted on
   * Facebook or Instagram, and pixel leads on the website. Both are part of
   * "Leads (Meta-reported)", never added to it.
   */
  fb_onsite_leads: {
    id: "fb_onsite_leads",
    label: "On-Facebook leads",
    format: "count",
    group: "Conversions",
    statKey: "fbLeadsOnsite",
    platforms: META,
    additive: true,
    series: META,
    dims: { meta: AD_ROWS },
    needs: ["extras", "adlevel"],
  },
  cp_onsite_lead: {
    id: "cp_onsite_lead",
    label: "Cost per On-Facebook lead",
    short: "Cost per On-FB lead",
    format: "currency",
    group: "Conversions",
    statKey: "cpFbLeadOnsite",
    platforms: META,
    additive: false,
    series: META,
    dims: { meta: AD_ROWS },
    rankBy: "spend",
    needs: ["ads", "extras", "adlevel"],
  },
  fb_pixel_leads: {
    id: "fb_pixel_leads",
    label: "Website leads",
    format: "count",
    group: "Conversions",
    statKey: "fbLeadsPixel",
    platforms: META,
    additive: true,
    series: META,
    dims: { meta: AD_ROWS },
    needs: ["extras", "adlevel"],
  },
  cp_pixel_lead: {
    id: "cp_pixel_lead",
    label: "Cost per website lead",
    format: "currency",
    group: "Conversions",
    statKey: "cpFbLeadPixel",
    platforms: META,
    additive: false,
    series: META,
    dims: { meta: AD_ROWS },
    rankBy: "spend",
    needs: ["ads", "extras", "adlevel"],
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
    group: "Performance",
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
    group: "Performance",
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
    group: "Performance",
    statKey: "landingPageViews",
    platforms: META,
    additive: true,
    series: META,
    dims: { meta: ["campaign", "adset", "ad", "creative"] },
    needs: ["extras", "adlevel"],
  },
  land_rate: {
    id: "land_rate",
    label: "Land rate",
    short: "Land",
    format: "percent",
    group: "Performance",
    statKey: "landRate",
    platforms: META,
    additive: false,
    series: META,
    dims: { meta: AD_ROWS },
    rankBy: "clicks",
    needs: ["ads", "extras", "adlevel"],
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
    short: "Hook",
    format: "percent",
    group: "Video",
    statKey: "hookRate",
    platforms: META,
    additive: false,
    series: META,
    dims: { meta: ["adset", "ad", "creative"] },
    rankBy: "impressions",
    needs: ["adlevel"],
    adRows: true,
  },
  hold_rate: {
    id: "hold_rate",
    label: "Hold rate",
    short: "Hold",
    format: "percent",
    group: "Video",
    statKey: "holdRate",
    platforms: META,
    additive: false,
    series: META,
    dims: { meta: ["adset", "ad", "creative"] },
    rankBy: "video_3s_views",
    needs: ["adlevel"],
    adRows: true,
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
    adRows: true,
  },
  post_reactions: metaAction("post_reactions", "Post reactions", "postReactions"),
  /*
   * TikTok reports comments and shares on its ads too: the same stat, its own
   * word for it, read from its daily rows (`Bag.comments`, `Bag.shares`).
   */
  comments: {
    ...metaAction("comments", "Post comments", "postComments"),
    labels: { tiktok: "Comments" },
    statKeys: { tiktok: "tiktokComments" },
    platforms: META_TIKTOK,
    series: META_TIKTOK,
    dims: { meta: AD_ROWS, tiktok: CAMPAIGN_ONLY },
  },
  shares: {
    ...metaAction("shares", "Post shares", "postShares"),
    labels: { tiktok: "Shares" },
    statKeys: { tiktok: "tiktokShares" },
    platforms: META_TIKTOK,
    series: META_TIKTOK,
    dims: { meta: AD_ROWS, tiktok: CAMPAIGN_ONLY },
  },
  saves: metaAction("saves", "Post saves", "postSaves"),
  page_likes: metaAction("page_likes", "Page likes", "pageLikes"),
  post_engagement: metaAction("post_engagement", "Post engagement", "postEngagement"),
  purchases: metaAction("purchases", "Website purchases", "purchases"),
  cp_purchase: {
    id: "cp_purchase",
    label: "Cost per purchase",
    format: "currency",
    group: "Conversions",
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

  /* ---------------------------------------------------------------- *
   * Every other figure each platform reports
   * ---------------------------------------------------------------- */

  /*
   * Outbound clicks: clicks that left Facebook for the destination — fewer
   * than link clicks, which also count opening an Instant Form. Meta is asked
   * for them per ad only, so every number is read from ad rows.
   */
  outbound_clicks: metaAdRow("outbound_clicks", "Outbound clicks", "outboundClicks", "Performance", {
    sum: "x.outbound_clicks",
  }),
  outbound_ctr: metaAdRow("outbound_ctr", "Outbound CTR", "outboundCtr", "Performance", {
    ratio: ["x.outbound_clicks", "impressions"],
  }),
  cp_outbound_click: metaAdRow("cp_outbound_click", "Cost per outbound click", "cpOutboundClick", "Performance", {
    per: "x.outbound_clicks",
  }),
  cp_lpv: metaCost("cp_lpv", "Cost per landing page view", "cpLpv", "Performance", "landingPageViews", "Cost per LPV"),

  page_engagement: metaFamily("page_engagement", "Page engagement", "pageEngagement", "Engagement"),
  photo_views: metaFamily("photo_views", "Photo views", "photoViews", "Engagement"),
  post_engagement_rate: {
    id: "post_engagement_rate",
    label: "Post engagement rate",
    short: "Engagement rate",
    format: "percent",
    group: "Engagement",
    statKey: "postEngagementRate",
    platforms: META,
    additive: false,
    series: META,
    dims: { meta: AD_ROWS },
    rankBy: "impressions",
    needs: ["ads", "extras", "adlevel"],
    calc: { ratio: ["postEngagement", "impressions"] },
  },
  cp_engagement: metaCost(
    "cp_engagement",
    "Cost per post engagement",
    "cpEngagement",
    "Engagement",
    "postEngagement",
    "Cost per engagement",
  ),
  cp_page_like: metaCost("cp_page_like", "Cost per page like", "cpPageLike", "Engagement", "pageLikes"),

  video_plays: metaAdRow("video_plays", "Video plays", "videoPlays", "Video", { sum: "videoPlays" }),
  video_p25: quartile("video_p25", 25, "videoP25", "tiktokVideoP25"),
  video_p50: quartile("video_p50", 50, "videoP50", "tiktokVideoP50"),
  video_p75: quartile("video_p75", 75, "videoP75", "tiktokVideoP75"),
  // TikTok reports no 95% mark.
  video_p95: metaAdRow("video_p95", "Video plays at 95%", "videoP95", "Video", { sum: "x.video_p95" }, {
    short: "Plays at 95%",
  }),
  video_p100: quartile("video_p100", 100, "videoP100", "tiktokVideoP100"),
  cp_thruplay: metaAdRow("cp_thruplay", "Cost per ThruPlay", "cpThruPlay", "Video", { per: "thruPlays" }),
  cp_3s_play: metaCost(
    "cp_3s_play",
    "Cost per 3-second video play",
    "cp3sPlay",
    "Video",
    "video3sViews",
    "Cost per 3s play",
  ),

  registrations: metaFamily("registrations", "Registrations completed", "registrations", "Conversions", "Registrations"),
  cp_registration: metaCost("cp_registration", "Cost per registration", "cpRegistration", "Conversions", "x.registrations"),
  contacts: metaFamily("contacts", "Contacts", "contacts", "Conversions"),
  cp_contact: metaCost("cp_contact", "Cost per contact", "cpContact", "Conversions", "x.contacts"),
  schedules: metaFamily("schedules", "Schedules", "schedules", "Conversions"),
  cp_schedule: metaCost("cp_schedule", "Cost per schedule", "cpSchedule", "Conversions", "x.schedules"),
  applications: metaFamily("applications", "Applications submitted", "applications", "Conversions", "Applications"),
  cp_application: metaCost("cp_application", "Cost per application", "cpApplication", "Conversions", "x.applications"),
  adds_to_cart: metaFamily("adds_to_cart", "Adds to cart", "addsToCart", "Conversions"),
  cp_add_to_cart: metaCost("cp_add_to_cart", "Cost per add to cart", "cpAddToCart", "Conversions", "x.adds_to_cart"),
  checkouts: metaFamily("checkouts", "Checkouts initiated", "checkouts", "Conversions", "Checkouts"),
  cp_checkout: metaCost(
    "cp_checkout",
    "Cost per checkout initiated",
    "cpCheckout",
    "Conversions",
    "x.checkouts",
    "Cost per checkout",
  ),
  content_views: metaFamily("content_views", "Content views", "contentViews", "Conversions"),
  cp_content_view: metaCost("cp_content_view", "Cost per content view", "cpContentView", "Conversions", "x.content_views"),
  calls_placed: metaFamily("calls_placed", "Calls placed", "callsPlaced", "Conversions"),
  cp_call: metaCost("cp_call", "Cost per call placed", "cpCall", "Conversions", "x.calls_placed", "Cost per call"),
  messaging_conversations: metaFamily(
    "messaging_conversations",
    "Messaging conversations started",
    "messagingConversations",
    "Conversions",
    "Conversations",
  ),
  cp_messaging_conversation: metaCost(
    "cp_messaging_conversation",
    "Cost per messaging conversation",
    "cpMessagingConversation",
    "Conversions",
    "x.messaging_conversations",
    "Cost per conversation",
  ),

  /*
   * Google. Its Conversions are the platform's Results (`results`, above);
   * these are the columns beside them in Google Ads.
   */
  all_conversions: simple(GOOGLE, "all_conversions", "All conversions", "allConversions", "Conversions", { sum: "x.all_conversions" }, "count"),
  cp_all_conversion: simple(
    GOOGLE,
    "cp_all_conversion",
    "Cost per all conversion",
    "cpAllConversion",
    "Conversions",
    { per: "x.all_conversions" },
    "currency",
  ),
  conversion_value: simple(GOOGLE, "conversion_value", "Conversion value", "conversionValue", "Conversions", { sum: "x.conversions_value" }, "currency"),
  conv_value_per_cost: simple(
    GOOGLE,
    "conv_value_per_cost",
    "Conv. value / cost",
    "convValuePerCost",
    "Conversions",
    { ratio: ["x.conversions_value", "spend"] },
    "multiple",
    { rankBy: "spend" },
  ),
  all_conversions_value: simple(
    GOOGLE,
    "all_conversions_value",
    "All conversions value",
    "allConversionsValue",
    "Conversions",
    { sum: "x.all_conversions_value" },
    "currency",
  ),
  view_through_conversions: simple(
    GOOGLE,
    "view_through_conversions",
    "View-through conversions",
    "viewThroughConversions",
    "Conversions",
    { sum: "x.view_through_conversions" },
    "count",
  ),
  conversion_rate: simple(
    GOOGLE,
    "conversion_rate",
    "Conversion rate",
    "conversionRate",
    "Conversions",
    { ratio: ["x.conversions", "x.interactions"] },
    "percent",
    { rankBy: "interactions" },
  ),
  interactions: simple(GOOGLE, "interactions", "Interactions", "interactions", "Performance", { sum: "x.interactions" }, "count"),
  interaction_rate: simple(
    GOOGLE,
    "interaction_rate",
    "Interaction rate",
    "interactionRate",
    "Performance",
    { ratio: ["x.interactions", "impressions"] },
    "percent",
  ),
  engagements: simple(GOOGLE, "engagements", "Engagements", "engagements", "Engagement", { sum: "x.engagements" }, "count"),
  engagement_rate: simple(
    GOOGLE,
    "engagement_rate",
    "Engagement rate",
    "engagementRate",
    "Engagement",
    { ratio: ["x.engagements", "impressions"] },
    "percent",
  ),
  phone_calls: simple(GOOGLE, "phone_calls", "Phone calls", "phoneCalls", "Conversions", { sum: "x.phone_calls" }, "count"),

  // Google's TrueView views and TikTok's video views: each platform's own "Video views".
  video_views: simple(GOOGLE_TIKTOK, "video_views", "Video views", "videoViews", "Video", { sum: "x.video_views" }, "count", {
    statKeys: { tiktok: "tiktokVideoViews" },
  }),
  view_rate: simple(
    GOOGLE_TIKTOK,
    "view_rate",
    "View rate",
    "viewRate",
    "Video",
    { ratio: ["x.video_views", "impressions"] },
    "percent",
    { statKeys: { tiktok: "tiktokViewRate" } },
  ),
  cpv: simple(GOOGLE_TIKTOK, "cpv", "Cost per video view", "cpv", "Video", { per: "x.video_views" }, "currency", {
    labels: { google: "Avg. CPV" },
    statKeys: { tiktok: "tiktokCpv" },
  }),

  /*
   * TikTok. Its Results (`results`, above) count each ad group's optimisation
   * goal; Conversions are its separate conversion-event column.
   */
  conversions: simple(TIKTOK, "conversions", "Conversions", "tiktokConversions", "Conversions", { sum: "x.conversions" }, "count"),
  cp_conversion: simple(
    TIKTOK,
    "cp_conversion",
    "Cost per conversion",
    "cpTiktokConversion",
    "Conversions",
    { per: "x.conversions" },
    "currency",
  ),
  cvr: simple(
    TIKTOK,
    "cvr",
    "Conversion rate (CVR)",
    "tiktokCvr",
    "Conversions",
    { ratio: ["x.conversions", "linkClicks"] },
    "percent",
    { rankBy: "clicks", short: "CVR" },
  ),
  likes: simple(TIKTOK, "likes", "Likes", "tiktokLikes", "Engagement", { sum: "x.likes" }, "count"),
  follows: simple(TIKTOK, "follows", "Follows", "tiktokFollows", "Engagement", { sum: "x.follows" }, "count"),
  cp_follow: simple(TIKTOK, "cp_follow", "Cost per follow", "cpTiktokFollow", "Engagement", { per: "x.follows" }, "currency"),
  profile_visits: simple(TIKTOK, "profile_visits", "Profile visits", "tiktokProfileVisits", "Engagement", { sum: "x.profile_visits" }, "count"),
  video_2s: simple(TIKTOK, "video_2s", "2-second video views", "tiktokVideo2s", "Video", { sum: "x.video_2s" }, "count"),
  video_6s: simple(TIKTOK, "video_6s", "6-second video views", "tiktokVideo6s", "Video", { sum: "x.video_6s" }, "count"),
};

/** The picker's group order: delivery first, then what the platforms count, then the CRM's. */
export const METRIC_GROUPS: readonly MetricGroup[] = [
  "Performance",
  "Platform results",
  "Conversions",
  "Engagement",
  "Video",
  "CRM pipeline",
  "CRM costs",
  "CRM rates",
  "Revenue",
];

export function metricLabel(id: MetricId, platform: AdPlatform): string {
  const m = METRICS[id];
  return m.labels?.[platform] ?? m.label;
}

/** The label where space is tight — a stat on a creative card. */
export function metricShortLabel(id: MetricId, platform: AdPlatform): string {
  return METRICS[id].short ?? metricLabel(id, platform);
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

/**
 * Whether this stat's numbers come from Meta's ad rows alone (`MetricDef.adRows`).
 * Meta's rule only: TikTok's quartiles, the same stat, come from its daily rows.
 */
export function metricFromAdRows(id: MetricId, platform: AdPlatform): boolean {
  return platform === "meta" && METRICS[id].adRows === true;
}

/** The extra figures a stat reads — its `x.` keys, which a platform's sync must store. */
export function metricExtraKeys(id: MetricId): string[] {
  const c = METRICS[id].calc;
  if (!c) return [];
  const refs = "sum" in c ? [c.sum] : "per" in c ? [c.per] : [...c.ratio];
  return refs.filter((r) => r.startsWith("x.")).map((r) => r.slice(2));
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
  "creatives",
  "funnel",
  "text",
  "logo",
] as const;

export type WidgetKind = (typeof WIDGET_KIND_IDS)[number];

/** Creative cards: one per ad, or one per creative (ads sharing an image or video). */
export const CARD_GROUPINGS = ["ad", "creative"] as const;
export type CardGrouping = (typeof CARD_GROUPINGS)[number];

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
  creatives: {
    kind: "creatives",
    label: "Creative cards",
    size: { w: 12, h: 10 },
    min: { w: 4, h: 7 },
    max: { w: 12, h: 12 },
  },
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
/** Creative cards: how many, how many stats on each, how many campaigns to filter by. */
export const CARDS = { min: 1, max: 12, statsMax: 6, campaignsMax: 20 } as const;
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
  { id: "creatives", label: "Creative cards", kind: "creatives" },
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
    case "creatives": {
      if (q.platform !== "meta") {
        return no("Creative cards are Meta only. Google and TikTok don't report individual ads here.");
      }
      if (q.stats.length < 1 || q.stats.length > CARDS.statsMax) {
        return no(`Show between 1 and ${CARDS.statsMax} stats on each card.`);
      }
      if (new Set(q.stats).size !== q.stats.length) return no("Each stat can appear once.");
      for (const m of [...q.stats, q.sort]) {
        if (METRICS[m].needs.includes("crm") || METRICS[m].needs.includes("revenue")) {
          return no(`${METRICS[m].label} comes from the CRM, which can't reliably tell which ad a lead came from.`);
        }
        if (!metricSupports(m, "meta") || !metricDims(m, "meta").includes(q.by)) {
          return no(`${METRICS[m].label} is not reported per ${q.by}.`);
        }
      }
      if (q.topN < CARDS.min || q.topN > CARDS.max) {
        return no(`Show between ${CARDS.min} and ${CARDS.max} cards.`);
      }
      if (q.campaigns !== undefined) {
        if (q.campaigns.length < 1 || q.campaigns.length > CARDS.campaignsMax) {
          return no(`Pick up to ${CARDS.campaignsMax} campaigns, or show every campaign.`);
        }
        if (new Set(q.campaigns).size !== q.campaigns.length) return no("Each campaign can be picked once.");
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
    case "creatives":
      return `${q.by === "ad" ? "Top ads" : "Top creatives"} by ${metricLabel(q.sort, "meta")}`;
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
    case "creatives":
      return [...new Set([...q.stats, q.sort])];
    case "funnel":
      return ["leads"];
    case "text":
    case "logo":
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
    id: "creative_cards",
    label: "Creative performance",
    description: "Each creative's spend, leads, cost per lead, hook, hold and land",
    query: {
      kind: "creatives",
      platform: "meta",
      by: "creative",
      stats: ["spend", "fb_leads", "cp_fb_lead", "hook_rate", "hold_rate", "land_rate"],
      sort: "spend",
      topN: 6,
      rankings: true,
    },
    size: { w: 12, h: 12 },
  },
  {
    id: "ad_cards_leads",
    label: "Ads by On-Facebook leads",
    description: "Ad cards ranked by form leads, with their cost",
    query: {
      kind: "creatives",
      platform: "meta",
      by: "ad",
      stats: ["impressions", "fb_onsite_leads", "cp_onsite_lead"],
      sort: "fb_onsite_leads",
      topN: 6,
    },
    size: { w: 12, h: 12 },
  },
  {
    id: "ad_cards_clicks",
    label: "Ads by link clicks",
    description: "Ad cards ranked by link clicks, with CTR (all)",
    query: {
      kind: "creatives",
      platform: "meta",
      by: "ad",
      stats: ["impressions", "clicks", "ctr_all"],
      sort: "clicks",
      topN: 6,
    },
    size: { w: 12, h: 12 },
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
