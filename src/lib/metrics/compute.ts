import type { CanonicalStage } from "@/lib/stages";

/**
 * Pure metric computation. No I/O, no database, no dates — everything here is
 * a total function of its inputs so it can be unit-tested exhaustively.
 *
 * The governing rule: EVERY ratio returns `null` when its denominator is zero
 * or missing, and the UI renders `null` as "-". Never 0, never NaN, never
 * Infinity. A zero cost-per-lead reads as "free leads"; a dash reads as "no
 * data", which is the truth. The old spreadsheet showed 0.00% show rates
 * alongside three closed deals — exactly this failure.
 */

export interface FunnelCounts {
  new_lead: number;
  contacted: number;
  appointment_booked: number;
  showed: number;
  no_show: number;
  closed_won: number;
  lost: number;
  /** Never a real prospect — wrong number, spam, out of area. Not `lost`. */
  disqualified: number;
  /**
   * Leads that entered in this window and have NEVER been disqualified.
   *
   * NOT `new_lead - disqualified`. The two counts describe different
   * populations: a June lead marked junk in August would subtract from August's
   * leads without ever having been in them, and on a quiet month can drive the
   * figure negative. This is its own query — "entered new_lead in the window,
   * with no disqualification transition ever" — so it is always a subset of
   * `new_lead` by construction.
   */
  new_lead_qualified: number;
}

export const EMPTY_FUNNEL: FunnelCounts = {
  new_lead: 0,
  contacted: 0,
  appointment_booked: 0,
  showed: 0,
  no_show: 0,
  closed_won: 0,
  lost: 0,
  disqualified: 0,
  new_lead_qualified: 0,
};

export interface AdTotals {
  spend: number;
  impressions: number;
  clicksAll: number;
  linkClicks: number;
  /** Meta-reported leads, for reconciliation against the CRM funnel. */
  fbLeads: number;
  /**
   * Deduplicated people. `null` unless separately queried for this exact
   * period — it can never be summed from daily rows.
   */
  reach: number | null;
}

export const EMPTY_ADS: AdTotals = {
  spend: 0,
  impressions: 0,
  clicksAll: 0,
  linkClicks: 0,
  fbLeads: 0,
  reach: null,
};

/**
 * Closed-won value for a period.
 *
 * `wonWithValue` is carried alongside the sum rather than derived from it,
 * because "we closed 6 deals and none of them has a value recorded" and "we
 * closed 6 deals worth $0" are different facts and must not collapse into the
 * same $0. Verified live: 43 of 64 closed-won opportunities carry a value, and
 * none created since March does — so this distinction is load-bearing today,
 * not hypothetical.
 */
export interface RevenueTotals {
  /** Distinct opportunities that ENTERED closed_won during the window. */
  wonOpps: number;
  /** Of those, how many carry a deal value above zero. */
  wonWithValue: number;
  /** Sum of monetary_value across those opportunities. */
  revenue: number;
}

export const EMPTY_REVENUE: RevenueTotals = {
  wonOpps: 0,
  wonWithValue: 0,
  revenue: 0,
};

export interface DerivedMetrics {
  cpLead: number | null;
  /** Spend ÷ leads that were real prospects. Null when nothing was disqualified. */
  cpLeadQualified: number | null;
  cpAppt: number | null;
  cpShow: number | null;
  cpWon: number | null;
  bookPct: number | null;
  showPct: number | null;
  closePct: number | null;
  optinPct: number | null;
  ctr: number | null;
  cpm: number | null;
  cpc: number | null;
  /** Revenue ÷ spend. Null when unknowable — see `roasFrom`. */
  roas: number | null;
  /** Average recorded deal size, over deals that actually carry a value. */
  avgDeal: number | null;
}

/** Guarded division. The single most important function in this file. */
export function div(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return null;
  if (denominator === 0) return null;
  const r = numerator / denominator;
  return Number.isFinite(r) ? r : null;
}

/**
 * Cost per acquisition, with one deliberate departure from raw arithmetic.
 *
 * When spend is 0 but conversions occurred, `div` would return exactly 0 and
 * the UI would print "$0.00 per lead" — which reads as "we acquired these for
 * free". That is the precise failure in the source spreadsheet's May–Jun 2026
 * rows: 25 leads recorded against $0.00 spend, displayed as $0.00 CP-LEAD, and
 * nobody questioned it for two months.
 *
 * You cannot acquire conversions from paid ads with zero spend. That
 * combination means one of two things — the spend feed is broken, or these
 * conversions were not paid-acquired — and both are "unknown", not "free". So
 * we return null and let the health check surface the anomaly.
 *
 * Note the genuinely empty case (0 spend, 0 conversions) already returns null
 * via the zero denominator, and a real zero-conversion period with spend
 * returns null too. Only the anomaly is special-cased.
 */
export function costPer(spend: number, conversions: number): number | null {
  if (conversions > 0 && spend === 0) return null;
  return div(spend, conversions);
}

/**
 * Return on ad spend, with the same refusal-to-guess as `costPer`.
 *
 * Deals closed but no value recorded against any of them → `null`, not `0`.
 * A "0.0x ROAS" reads as "these ads made no money", when the truth is that
 * nobody filled the value field. Reporting the first as though it were the
 * second is precisely the class of silent wrongness this dashboard replaced —
 * and it would blame the ads for an operations gap.
 *
 * A period where NOTHING closed is different, and deliberately returns a real
 * `0` rather than a dash: we know the return was zero. Dashes are reserved for
 * absent knowledge — if a real zero also rendered as a dash, the dash would stop
 * carrying information. Zero spend still returns null via `div`, since revenue
 * against no spend is unattributable rather than an infinite return.
 */
export function roasFrom(
  rev: RevenueTotals | null,
  spend: number,
): number | null {
  // null = never queried for this period. Distinct from "queried, found none",
  // and it must not fall through to div(0, spend) === 0 — that would print a
  // confident 0.0× for a period whose revenue nobody ever looked up.
  if (rev === null) return null;
  if (rev.wonOpps > 0 && rev.wonWithValue === 0) return null;
  return div(rev.revenue, spend);
}

export function derive(
  funnel: FunnelCounts,
  ads: AdTotals,
  revenue: RevenueTotals | null = null,
): DerivedMetrics {
  const { spend, impressions, linkClicks } = ads;
  return {
    // Cost per stage — denominators come from the CRM ledger, which is the
    // source of truth for what actually happened downstream of the click.
    cpLead: costPer(spend, funnel.new_lead),
    /**
     * Cost per lead that was actually a prospect.
     *
     * Always rendered NEXT TO `cpLead`, never instead of it. Quietly dropping
     * junk from the denominator is precisely the massaging this product exists
     * to replace — and showing both also neutralises the incentive split, since
     * the client has reason to over-mark junk to argue the ads are bad and the
     * agency has reason to under-mark it. With both on screen neither works.
     *
     * Null when nothing has been disqualified, so the second number appears only
     * where it says something the first does not.
     */
    cpLeadQualified:
      funnel.disqualified > 0 ? costPer(spend, funnel.new_lead_qualified) : null,
    cpAppt: costPer(spend, funnel.appointment_booked),
    cpShow: costPer(spend, funnel.showed),
    cpWon: costPer(spend, funnel.closed_won),

    // Stage-to-stage conversion.
    bookPct: div(funnel.appointment_booked, funnel.new_lead),
    showPct: div(funnel.showed, funnel.appointment_booked),
    closePct: div(funnel.closed_won, funnel.showed),

    // Landing-page conversion: of the people who clicked through, how many
    // became a lead. This is the metric that exposed the real problem in the
    // source spreadsheet — click-to-lead fell from ~16% to ~3%.
    optinPct: div(funnel.new_lead, linkClicks),

    // Traffic economics. Derived from summed components, never averaged from
    // per-day ratios, which would weight a $1 day equally with a $1,000 day.
    ctr: div(linkClicks, impressions),
    cpm: impressions === 0 ? null : div(spend * 1000, impressions),
    cpc: div(spend, linkClicks),

    // Value, not just cost. Until this existed the dashboard could say a lead
    // cost $34 but never whether it was worth having.
    roas: roasFrom(revenue, spend),
    avgDeal: revenue ? div(revenue.revenue, revenue.wonWithValue) : null,
  };
}

/** Sum closed-won value across periods. All three fields are additive. */
export function sumRevenue(rows: RevenueTotals[]): RevenueTotals {
  return rows.reduce<RevenueTotals>(
    (acc, r) => ({
      wonOpps: acc.wonOpps + r.wonOpps,
      wonWithValue: acc.wonWithValue + r.wonWithValue,
      revenue: acc.revenue + r.revenue,
    }),
    { ...EMPTY_REVENUE },
  );
}

/** Sum ad totals across days. Reach is deliberately excluded — see AdTotals. */
export function sumAds(rows: AdTotals[]): AdTotals {
  return rows.reduce<AdTotals>(
    (acc, r) => ({
      spend: acc.spend + r.spend,
      impressions: acc.impressions + r.impressions,
      clicksAll: acc.clicksAll + r.clicksAll,
      linkClicks: acc.linkClicks + r.linkClicks,
      fbLeads: acc.fbLeads + r.fbLeads,
      reach: null,
    }),
    { ...EMPTY_ADS },
  );
}

export function sumFunnels(rows: FunnelCounts[]): FunnelCounts {
  return rows.reduce<FunnelCounts>(
    (acc, r) => ({
      new_lead: acc.new_lead + r.new_lead,
      contacted: acc.contacted + r.contacted,
      appointment_booked: acc.appointment_booked + r.appointment_booked,
      showed: acc.showed + r.showed,
      no_show: acc.no_show + r.no_show,
      closed_won: acc.closed_won + r.closed_won,
      lost: acc.lost + r.lost,
      disqualified: acc.disqualified + r.disqualified,
      new_lead_qualified: acc.new_lead_qualified + r.new_lead_qualified,
    }),
    { ...EMPTY_FUNNEL },
  );
}

/**
 * Period-over-period change, as a signed ratio.
 *
 * `null` when the previous period is 0 — "up from nothing" is not a percentage,
 * and rendering it as +100% or ∞ would be a lie. The sheet printed "-" here and
 * that was correct.
 */
export function pctChange(
  current: number | null,
  previous: number | null,
): number | null {
  if (current === null || previous === null) return null;
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  if (previous === 0) return null;
  return (current - previous) / Math.abs(previous);
}

/**
 * Which direction is good for this metric?
 *
 * Cost metrics improve when they fall. Rendering a 20% drop in cost-per-lead in
 * red because "down = bad" would invert the meaning of the whole dashboard.
 */
export type Polarity = "higher-better" | "lower-better" | "neutral";

export const METRIC_POLARITY: Record<string, Polarity> = {
  spend: "neutral",
  impressions: "neutral",
  reach: "neutral",
  linkClicks: "higher-better",
  new_lead: "higher-better",
  contacted: "higher-better",
  appointment_booked: "higher-better",
  showed: "higher-better",
  closed_won: "higher-better",
  no_show: "lower-better",
  lost: "lower-better",
  cpLead: "lower-better",
  cpAppt: "lower-better",
  cpShow: "lower-better",
  cpWon: "lower-better",
  cpc: "lower-better",
  cpm: "lower-better",
  bookPct: "higher-better",
  showPct: "higher-better",
  closePct: "higher-better",
  optinPct: "higher-better",
  ctr: "higher-better",
  revenue: "higher-better",
  roas: "higher-better",
  avgDeal: "higher-better",
};

/**
 * How large a move must be before it is called good or bad.
 *
 * Colouring every non-zero delta means a 0.8% drift in cost-per-lead arrives
 * with the same red as a 40% blowout. At this product's volumes most small
 * moves are one extra lead or one day's budget landing on the other side of a
 * date boundary — noise wearing a verdict. Painting it green or red teaches the
 * reader that the colours carry no information, and then the 40% move gets
 * skimmed past too.
 *
 * The delta itself is still SHOWN inside the band — we are withholding the
 * judgement, not the number. Anyone who wants to read 1.2% can read it.
 *
 * 5% deliberately matches `insights.ts`'s NOTABLE threshold, so the prose strip
 * at the top of the page and the tiles below it cannot disagree about whether
 * something moved.
 */
export const SENTIMENT_DEAD_BAND = 0.05;

/** `good` | `bad` | `neutral` for a change, honouring polarity. */
export function changeSentiment(
  metric: string,
  change: number | null,
): "good" | "bad" | "neutral" {
  if (change === null || !Number.isFinite(change)) return "neutral";
  if (Math.abs(change) < SENTIMENT_DEAD_BAND) return "neutral";
  const polarity = METRIC_POLARITY[metric] ?? "neutral";
  if (polarity === "neutral") return "neutral";
  const improving = polarity === "higher-better" ? change > 0 : change < 0;
  return improving ? "good" : "bad";
}

/**
 * Drop-off between consecutive funnel stages.
 *
 * This is the view the source spreadsheet could not produce at all: it reported
 * stage totals but never where people were being lost.
 */
export interface FunnelStep {
  stage: CanonicalStage;
  count: number;
  /** Conversion from the previous stage. `null` for the first step. */
  conversionFromPrevious: number | null;
  /** People lost between the previous stage and this one. */
  droppedFromPrevious: number | null;
}

export function buildFunnelSteps(
  funnel: FunnelCounts,
  path: CanonicalStage[],
): FunnelStep[] {
  return path.map((stage, i) => {
    const count = funnel[stage as keyof FunnelCounts] ?? 0;
    if (i === 0) {
      return {
        stage,
        count,
        conversionFromPrevious: null,
        droppedFromPrevious: null,
      };
    }
    const prevCount = funnel[path[i - 1] as keyof FunnelCounts] ?? 0;
    return {
      stage,
      count,
      conversionFromPrevious: div(count, prevCount),
      droppedFromPrevious: prevCount - count,
    };
  });
}

/* ------------------------------------------------------------------ *
 * Formatting — shared by every table so the dashboard reads uniformly
 * ------------------------------------------------------------------ */

/** The sheet's convention: undefined values render as a dash, not zero. */
export const DASH = "–";

export function formatCurrency(
  v: number | null,
  currency = "USD",
  opts: { compact?: boolean } = {},
): string {
  if (v === null || !Number.isFinite(v)) return DASH;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    notation: opts.compact && Math.abs(v) >= 10_000 ? "compact" : "standard",
    minimumFractionDigits: opts.compact && Math.abs(v) >= 10_000 ? 1 : 2,
    maximumFractionDigits: 2,
  }).format(v);
}

export function formatPercent(v: number | null, digits = 2): string {
  if (v === null || !Number.isFinite(v)) return DASH;
  return `${(v * 100).toFixed(digits)}%`;
}

export function formatNumber(v: number | null, opts: { compact?: boolean } = {}): string {
  if (v === null || !Number.isFinite(v)) return DASH;
  return new Intl.NumberFormat("en-US", {
    notation: opts.compact && Math.abs(v) >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 0,
  }).format(v);
}

/** Signed percentage for change columns, e.g. "+12.4%" / "−8.1%". */
/**
 * `3.4×`. Its own format because ROAS is a ratio of money to money, not money.
 *
 * Lives here, in the pure metrics layer, and NOT in `StatTile` where it started.
 * `StatTile` is a `"use client"` module, so a server component that imported
 * this function and called it hit React's client/server boundary — "Attempted
 * to call formatMultiple() from the server" — which threw during render and
 * dropped the ENTIRE dashboard into its error boundary. A formatter is not a
 * component; it belongs with the other formatters.
 */
export function formatMultiple(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return DASH;
  return `${v.toFixed(v >= 10 ? 0 : 1)}×`;
}

export function formatChange(v: number | null, digits = 1): string {
  if (v === null || !Number.isFinite(v)) return DASH;
  const pct = v * 100;
  const sign = pct > 0 ? "+" : pct < 0 ? "−" : "";
  return `${sign}${Math.abs(pct).toFixed(digits)}%`;
}
