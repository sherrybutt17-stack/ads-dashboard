import type { CanonicalStage } from "@/db/schema";

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
}

export const EMPTY_FUNNEL: FunnelCounts = {
  new_lead: 0,
  contacted: 0,
  appointment_booked: 0,
  showed: 0,
  no_show: 0,
  closed_won: 0,
  lost: 0,
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

export interface DerivedMetrics {
  cpLead: number | null;
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

export function derive(funnel: FunnelCounts, ads: AdTotals): DerivedMetrics {
  const { spend, impressions, linkClicks } = ads;
  return {
    // Cost per stage — denominators come from the CRM ledger, which is the
    // source of truth for what actually happened downstream of the click.
    cpLead: costPer(spend, funnel.new_lead),
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
  };
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
};

/** `good` | `bad` | `neutral` for a change, honouring polarity. */
export function changeSentiment(
  metric: string,
  change: number | null,
): "good" | "bad" | "neutral" {
  if (change === null || change === 0) return "neutral";
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
export function formatChange(v: number | null, digits = 1): string {
  if (v === null || !Number.isFinite(v)) return DASH;
  const pct = v * 100;
  const sign = pct > 0 ? "+" : pct < 0 ? "−" : "";
  return `${sign}${Math.abs(pct).toFixed(digits)}%`;
}
