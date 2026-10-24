import {
  costPer,
  derive,
  div,
  sumFunnels,
  sumRevenue,
  type AdTotals,
  type FunnelCounts,
  type RevenueTotals,
} from "@/lib/metrics/compute";
import { METRICS, type BagRef, type MetricCalc, type MetricId } from "./catalog";

/**
 * The raw components every stat is computed from, for one row of anything — a
 * day, a campaign, an ad, an age band, or the whole range.
 *
 * ── Why a bag of components ───────────────────────────────────────────
 *
 * A board can put any stat at any grouping, and a ratio is only correct when
 * computed from the summed components of exactly that grouping. CTR for a
 * campaign is its clicks over its impressions; the table's total CTR is all
 * clicks over all impressions, never the average of the rows' CTRs. Carrying
 * the components and computing every stat from them in ONE function makes that
 * the only way a number can be produced here.
 *
 * Pure, and the formulas are the dashboard's own (`derive`, `costPer`), so a
 * board tile and the matching Overview tile cannot disagree.
 */
export interface Bag {
  spend: number;
  impressions: number;
  linkClicks: number;
  clicksAll: number;
  fbLeads: number;
  /** Meta's Instant Form leads (`onsite_conversion.lead_grouped`) — part of `fbLeads`. */
  leadsOnsite: number;
  /** Meta's website pixel leads (`offsite_conversion.fb_pixel_lead`) — part of `fbLeads`. */
  leadsPixel: number;
  landingPageViews: number;
  video3sViews: number;
  videoPlays: number;
  thruPlays: number;
  postReactions: number;
  comments: number;
  shares: number;
  saves: number;
  pageLikes: number;
  postEngagement: number;
  purchases: number;
  /**
   * The platform's results of ONE type — the widget's main or pinned type —
   * and the single-type spend and results that price them. Never a sum across
   * types; see `metrics/results.ts`.
   */
  resultCount: number;
  resultSpend: number;
  resultPricedCount: number;
  /**
   * Every other figure the platform reports, by key (`metrics/platform-extras.ts`)
   * — Google's all conversions, TikTok's likes, Meta's registrations. Additive,
   * summed key by key; a key a row lacks counts as zero.
   */
  x: Readonly<Record<string, number>>;
  /**
   * Per extra figure: delivery days in this row stored before it was
   * collected (Google's and TikTok's, until history is re-pulled). Its sum
   * then covers fewer days than spend does, so a cost or rate built on it
   * would mix two different ranges — `calculate` refuses one.
   */
  xMissing: Readonly<Record<string, number>>;
  /** CRM counts, when loaded for this row. */
  funnel: FunnelCounts | null;
  /** Closed-won values, when loaded for this row. */
  revenue: RevenueTotals | null;
  /** Only ever for a whole range: reach is not additive. */
  reach: number | null;
  frequency: number | null;
}

export const EMPTY_BAG: Bag = Object.freeze({
  spend: 0,
  impressions: 0,
  linkClicks: 0,
  clicksAll: 0,
  fbLeads: 0,
  leadsOnsite: 0,
  leadsPixel: 0,
  landingPageViews: 0,
  video3sViews: 0,
  videoPlays: 0,
  thruPlays: 0,
  postReactions: 0,
  comments: 0,
  shares: 0,
  saves: 0,
  pageLikes: 0,
  postEngagement: 0,
  purchases: 0,
  resultCount: 0,
  resultSpend: 0,
  resultPricedCount: 0,
  x: Object.freeze({}),
  xMissing: Object.freeze({}),
  funnel: null,
  revenue: null,
  reach: null,
  frequency: null,
}) as Bag;

const ADDITIVE_KEYS = [
  "spend",
  "impressions",
  "linkClicks",
  "clicksAll",
  "fbLeads",
  "leadsOnsite",
  "leadsPixel",
  "landingPageViews",
  "video3sViews",
  "videoPlays",
  "thruPlays",
  "postReactions",
  "comments",
  "shares",
  "saves",
  "pageLikes",
  "postEngagement",
  "purchases",
  "resultCount",
  "resultSpend",
  "resultPricedCount",
] as const;

export type AdditiveKey = (typeof ADDITIVE_KEYS)[number];

export function bag(parts: Partial<Bag>): Bag {
  // Copies of the extras, never the frozen empty maps shared by every bag.
  return { ...EMPTY_BAG, ...parts, x: { ...(parts.x ?? {}) }, xMissing: { ...(parts.xMissing ?? {}) } };
}

function addX(a: Bag["x"], b: Bag["x"]): Record<string, number> {
  const out: Record<string, number> = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = (out[k] ?? 0) + v;
  return out;
}

/** Sum two rows. Reach never survives a sum. */
export function addBags(a: Bag, b: Bag): Bag {
  const out: Bag = { ...EMPTY_BAG };
  for (const k of ADDITIVE_KEYS) out[k] = a[k] + b[k];
  out.x = addX(a.x, b.x);
  out.xMissing = addX(a.xMissing, b.xMissing);
  out.funnel =
    a.funnel && b.funnel ? sumFunnels([a.funnel, b.funnel]) : (a.funnel ?? b.funnel);
  out.revenue =
    a.revenue && b.revenue ? sumRevenue([a.revenue, b.revenue]) : (a.revenue ?? b.revenue);
  return out;
}

export function sumBags(rows: readonly Bag[]): Bag {
  return rows.reduce(addBags, { ...EMPTY_BAG });
}

/**
 * What a whole has that its parts do not — Meta's privacy-withheld remainder
 * of an audience split. Clamped at zero: a negative remainder is a sync timing
 * mismatch, not a quantity.
 */
export function remainder(whole: Bag, parts: Bag): Bag {
  const out: Bag = { ...EMPTY_BAG };
  for (const k of ADDITIVE_KEYS) out[k] = Math.max(0, whole[k] - parts[k]);
  out.x = Object.fromEntries(
    Object.entries(whole.x).map(([k, v]) => [k, Math.max(0, v - (parts.x[k] ?? 0))]),
  );
  return out;
}

/** One quantity of a row: a base count, or an extra figure by key (absent = zero). */
function quantity(b: Bag, ref: BagRef): number {
  if (ref.startsWith("x.")) return b.x[ref.slice(2)] ?? 0;
  return b[ref as Exclude<BagRef, `x.${string}`>];
}

/** An extra figure some of this row's delivery days were stored without. */
function partial(b: Bag, ref: BagRef): boolean {
  return ref.startsWith("x.") && (b.xMissing[ref.slice(2)] ?? 0) > 0;
}

/**
 * A `MetricDef.calc`, from one row's summed components.
 *
 * A sum over partly collected days is still a true count of what was
 * collected, and the widget's note says days are missing. A cost or a rate is
 * not: dividing 28 days of interactions by 90 days of impressions prints a
 * confident number that is a third of the truth. So those have no value until
 * history is re-pulled.
 */
function calculate(c: MetricCalc, b: Bag): number | null {
  if ("sum" in c) return quantity(b, c.sum);
  if ("per" in c) return partial(b, c.per) ? null : costPer(b.spend, quantity(b, c.per));
  if (c.ratio.some((r) => partial(b, r))) return null;
  return div(quantity(b, c.ratio[0]), quantity(b, c.ratio[1]));
}

export function adTotalsOf(b: Bag): AdTotals {
  return {
    spend: b.spend,
    impressions: b.impressions,
    clicksAll: b.clicksAll,
    linkClicks: b.linkClicks,
    fbLeads: b.fbLeads,
    reach: b.reach,
  };
}

/** Revenue with the dashboard's honesty rule: deals won with no values is a dash, not $0. */
function revenueValue(rev: RevenueTotals | null): number | null {
  if (!rev) return null;
  if (rev.wonOpps > 0 && rev.wonWithValue === 0) return null;
  return rev.revenue;
}

export interface MetricOptions {
  /**
   * For per-campaign cost per lead: the dashboard trusts a campaign's CPL only
   * when the WHOLE funnel's top is being recorded (`dashboard.ts` campaign rows).
   */
  campaignRow?: { cplTrusted: boolean };
}

/** Any stat, from one row's components. Null means "no honest value". */
export function metricValue(id: MetricId, b: Bag, opts: MetricOptions = {}): number | null {
  const calc = METRICS[id].calc;
  if (calc) return calculate(calc, b);
  switch (id) {
    case "spend":
      return b.spend;
    case "impressions":
      return b.impressions;
    case "clicks":
      return b.linkClicks;
    case "clicks_all":
      return b.clicksAll;
    case "fb_leads":
      return b.fbLeads;
    case "fb_onsite_leads":
      return b.leadsOnsite;
    case "fb_pixel_leads":
      return b.leadsPixel;
    case "landing_page_views":
      return b.landingPageViews;
    case "video_3s_views":
      return b.video3sViews;
    case "thruplays":
      return b.thruPlays;
    case "post_reactions":
      return b.postReactions;
    case "comments":
      return b.comments;
    case "shares":
      return b.shares;
    case "saves":
      return b.saves;
    case "page_likes":
      return b.pageLikes;
    case "post_engagement":
      return b.postEngagement;
    case "purchases":
      return b.purchases;
    case "ctr":
      return div(b.linkClicks, b.impressions);
    case "cpc":
      return div(b.spend, b.linkClicks);
    case "cpm":
      return b.impressions === 0 ? null : div(b.spend * 1000, b.impressions);
    case "ctr_all":
      return div(b.clicksAll, b.impressions);
    case "cpc_all":
      return div(b.spend, b.clicksAll);
    case "land_rate":
      return div(b.landingPageViews, b.linkClicks);
    case "cp_fb_lead":
      return costPer(b.spend, b.fbLeads);
    case "cp_onsite_lead":
      return costPer(b.spend, b.leadsOnsite);
    case "cp_pixel_lead":
      return costPer(b.spend, b.leadsPixel);
    case "cp_purchase":
      return costPer(b.spend, b.purchases);
    case "results":
      return b.resultCount;
    case "cost_per_result":
      // Single-type spend over the results on those same days, as Ads Manager does.
      return b.resultPricedCount > 0 && b.resultSpend > 0 ? b.resultSpend / b.resultPricedCount : null;
    case "hook_rate":
      // Same rule as `creative.ts` hookRate: no plays of any kind = not a video.
      if (b.video3sViews === 0 && b.videoPlays === 0) return null;
      return div(b.video3sViews, b.impressions);
    case "hold_rate":
      // `creative.ts` holdRate: no ThruPlays and no 3-second plays = not a video.
      if (b.thruPlays === 0 && b.video3sViews === 0) return null;
      return div(b.thruPlays, b.video3sViews);
    case "reach":
      return b.reach;
    case "frequency":
      return b.frequency;
    case "revenue":
      return revenueValue(b.revenue);
    default:
      break;
  }

  // CRM stats need the funnel; without it there is no honest number.
  const f = b.funnel;
  if (!f) return null;
  switch (id) {
    case "leads":
      return f.new_lead;
    case "contacted":
      return f.contacted;
    case "appointments":
      return f.appointment_booked;
    case "showed":
      return f.showed;
    case "no_show":
      return f.no_show;
    case "won":
      return f.closed_won;
    case "lost":
      return f.lost;
    case "qualified_leads":
      return f.new_lead_qualified;
    default:
      break;
  }

  if (id === "cp_lead" && opts.campaignRow) {
    // dashboard.ts campaign rows: overall funnel coherence, then this row's numbers.
    return opts.campaignRow.cplTrusted && f.new_lead > 0 && b.spend > 0
      ? b.spend / f.new_lead
      : null;
  }

  const d = derive(f, adTotalsOf(b), b.revenue);
  switch (id) {
    case "cp_lead":
      return d.cpLead;
    case "cp_appt":
      return d.cpAppt;
    case "cp_show":
      return d.cpShow;
    case "cp_won":
      return d.cpWon;
    case "book_pct":
      return d.bookPct;
    case "show_pct":
      return d.showPct;
    case "close_pct":
      return d.closePct;
    case "optin_pct":
      return d.optinPct;
    case "roas":
      return d.roas;
    case "avg_deal":
      return d.avgDeal;
    default:
      return null;
  }
}
