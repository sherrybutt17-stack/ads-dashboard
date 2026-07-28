import type { Client } from "@/db/schema";
import { FUNNEL_PATH } from "@/db/schema";
import {
  eachDateKey,
  previousWindow,
  trailingMonths,
  trailingWindow,
  trailingWindowInclusive,
  windowFromKeys,
  dayLabel,
  type DateWindow,
} from "@/lib/dates";
import {
  buildFunnelSteps,
  derive,
  pctChange,
  type FunnelStep,
} from "./compute";
import {
  getDailySeries,
  getPeriodMetrics,
  getPeriodReach,
  getGoogleAccountSummary,
  getCampaignBreakdown,
  getLeadsByCampaign,
  getLeadAttributionBreakdown,
  getPipelineDistribution,
  getLeads,
  getSpeedToLead,
  getLeadArrivalHeatmap,
  type AdPlatform,
  type DailyPoint,
  type PeriodMetrics,
  type PaidLeadFilter,
  type PipelineStageCount,
  type LeadRow,
  type SpeedToLead,
  type LeadHeatmap,
} from "./queries";

/** The moving-average windows the source sheet reported. */
export const MOVING_AVERAGE_DAYS = [3, 7, 14, 30, 60, 90] as const;

export interface DashboardData {
  /** Which ad platform this view is scoped to. */
  platform: AdPlatform;
  client: {
    id: string;
    name: string;
    slug: string;
    timezone: string;
    currency: string;
    lastSyncedAt: string | null;
    firstWebhookAt: string | null;
  };
  range: { startKey: string; endKey: string; label: string };
  /** Headline period + its immediately preceding period, for deltas. */
  current: PeriodMetrics;
  previous: PeriodMetrics;
  deltas: Record<string, number | null>;
  funnel: FunnelStep[];
  daily: DailyPoint[];
  movingAverages: PeriodMetrics[];
  sevenDayChange: { current: PeriodMetrics; previous: PeriodMetrics };
  fourteenDayDaily: Array<DailyPoint & { label: string }>;
  monthOnMonth: PeriodMetrics[];
  campaigns: Array<{
    campaignId: string;
    campaignName: string;
    platform: "meta" | "google";
    spend: number;
    impressions: number;
    linkClicks: number;
    leads: number;
    cpLead: number | null;
  }>;
  /** Current-state pipeline snapshot: where every paid lead sits right now. */
  pipelineDistribution: { stages: PipelineStageCount[]; total: number };
  /** Every paid lead as a row — who, which stage, which campaign. */
  leads: LeadRow[];
  /** Speed to lead: time from lead-in to first outbound call, for this range. */
  speedToLead: SpeedToLead;
  /** When paid leads arrive — weekday × hour grid for the selected range. */
  heatmap: LeadHeatmap;
  /** Prior period's daily series, index-aligned to `daily`, for the ghost line. */
  prevDaily: DailyPoint[];
  /** True when we have spend data but zero CRM leads attributed to campaigns. */
  attributionGap: boolean;
  /** How the paid-lead filter is configured, and what it is excluding. */
  leadFilter: PaidLeadFilter & {
    total: number;
    attributed: number;
    tagged: number;
    paid: number;
  };
}

/**
 * Assemble everything the dashboard renders, for a chosen range.
 *
 * All windows are computed in the client's timezone. Queries are issued
 * concurrently where they are independent — the four report tables alone are
 * ~20 window queries, and running them serially would be visibly slow.
 */
export async function loadDashboard(
  client: Client,
  opts: { startKey?: string; endKey?: string } = {},
  platform: AdPlatform = "meta",
): Promise<DashboardData> {
  const tz = client.timezone;

  const range: DateWindow =
    opts.startKey && opts.endKey
      ? windowFromKeys(opts.startKey, opts.endKey, tz)
      : trailingWindowInclusive(30, tz);

  const prevRange = previousWindow(range, tz);

  /*
   * Which leads divide into ad spend. Applied to EVERY window and every stage,
   * so cost-per-appointment compares Facebook spend against Facebook
   * appointments rather than against the whole pipeline.
   */
  const filter: PaidLeadFilter = {
    mode: client.paidLeadFilter,
    tag: client.paidLeadTag,
  };

  const [
    current,
    previous,
    reach,
    dailyRaw,
    movingAverages,
    sevenCurrent,
    sevenPrevious,
    fourteenRaw,
    monthOnMonth,
    campaignRows,
    leadsByCampaign,
    leadBreakdown,
    pipelineDistribution,
    leads,
    speedToLead,
    heatmap,
    prevDailyRaw,
  ] = await Promise.all([
    getPeriodMetrics(client.id, range, "Selected range", undefined, filter, platform),
    getPeriodMetrics(client.id, prevRange, "Previous period", undefined, filter, platform),
    // Reach is a Meta concept (deduplicated people, in `fb_period_reach`); Google
    // has no equivalent in our schema, so the Google view leaves it null.
    platform === "meta" ? getPeriodReach(client.id, range) : Promise.resolve(null),
    getDailySeries(client.id, range, tz, eachDateKey(range, tz), undefined, filter, platform),

    // Moving averages: 3/7/14/30/60/90-day trailing windows.
    Promise.all(
      MOVING_AVERAGE_DAYS.map((d) =>
        getPeriodMetrics(
          client.id,
          trailingWindow(d, tz),
          `${d} Days`,
          undefined,
          filter,
          platform,
        ),
      ),
    ),

    getPeriodMetrics(
      client.id,
      trailingWindowInclusive(7, tz),
      "Last 7 Days",
      undefined,
      filter,
      platform,
    ),
    getPeriodMetrics(
      client.id,
      previousWindow(trailingWindowInclusive(7, tz), tz),
      "Previous Period",
      undefined,
      filter,
      platform,
    ),

    (async () => {
      const w = trailingWindowInclusive(14, tz);
      return getDailySeries(client.id, w, tz, eachDateKey(w, tz), undefined, filter, platform);
    })(),

    Promise.all(
      trailingMonths(12, tz).map((m) =>
        getPeriodMetrics(client.id, m, m.label, undefined, filter, platform),
      ),
    ),

    getCampaignBreakdown(client.id, range, platform),
    getLeadsByCampaign(client.id, range, filter, platform),
    getLeadAttributionBreakdown(client.id, range, filter, platform),
    getPipelineDistribution(client.id, filter, platform),
    getLeads(client.id, filter, 2000, platform),
    getSpeedToLead(client.id, range, filter, platform),
    getLeadArrivalHeatmap(client.id, range, tz, filter, platform),
    // Prior period, index-aligned to `daily` — the faint ghost behind the trend.
    getDailySeries(
      client.id,
      prevRange,
      tz,
      eachDateKey(prevRange, tz),
      undefined,
      filter,
      platform,
    ),
  ]);

  // Reach is only valid when queried for this exact window — never summed.
  current.ads.reach = reach;
  current.derived = derive(current.funnel, current.ads);

  const deltas: Record<string, number | null> = {
    spend: pctChange(current.ads.spend, previous.ads.spend),
    linkClicks: pctChange(current.ads.linkClicks, previous.ads.linkClicks),
    new_lead: pctChange(current.funnel.new_lead, previous.funnel.new_lead),
    contacted: pctChange(current.funnel.contacted, previous.funnel.contacted),
    appointment_booked: pctChange(
      current.funnel.appointment_booked,
      previous.funnel.appointment_booked,
    ),
    showed: pctChange(current.funnel.showed, previous.funnel.showed),
    closed_won: pctChange(current.funnel.closed_won, previous.funnel.closed_won),
    cpLead: pctChange(current.derived.cpLead, previous.derived.cpLead),
    cpAppt: pctChange(current.derived.cpAppt, previous.derived.cpAppt),
    cpWon: pctChange(current.derived.cpWon, previous.derived.cpWon),
    bookPct: pctChange(current.derived.bookPct, previous.derived.bookPct),
    showPct: pctChange(current.derived.showPct, previous.derived.showPct),
    closePct: pctChange(current.derived.closePct, previous.derived.closePct),
    optinPct: pctChange(current.derived.optinPct, previous.derived.optinPct),
    ctr: pctChange(current.derived.ctr, previous.derived.ctr),
    cpc: pctChange(current.derived.cpc, previous.derived.cpc),
    cpm: pctChange(current.derived.cpm, previous.derived.cpm),
  };

  const campaigns = campaignRows
    .map((c) => {
      const leads = leadsByCampaign.get(c.campaignId) ?? 0;
      return {
        campaignId: c.campaignId,
        // Leads with no campaign id predate the UTM setup. Named explicitly so
        // totals reconcile rather than quietly dropping rows.
        campaignName:
          c.campaignName ?? (c.campaignId === "" ? "Unattributed" : c.campaignId),
        platform: c.platform,
        spend: c.ads.spend,
        impressions: c.ads.impressions,
        linkClicks: c.ads.linkClicks,
        leads,
        cpLead: leads > 0 && c.ads.spend > 0 ? c.ads.spend / leads : null,
      };
    })
    .sort((a, b) => b.spend - a.spend);

  /*
   * Paid leads with no campaign id (tag-only Instant Form leads) have no spend
   * row to join to, so they never appear as a campaign row. Surface them as an
   * explicit "Unattributed" row so the campaign table reconciles with the funnel
   * instead of silently dropping them — otherwise a client running Instant Forms
   * sees real leads in the KPI row but "0 attributed leads" in the table.
   */
  const unattributedLeads = leadsByCampaign.get("") ?? 0;
  if (unattributedLeads > 0) {
    campaigns.push({
      campaignId: "",
      campaignName: "Unattributed",
      platform,
      spend: 0,
      impressions: 0,
      linkClicks: 0,
      leads: unattributedLeads,
      cpLead: null,
    });
  }

  // Each platform tracks its own currency and freshness — Meta on `clients`,
  // Google on the Google accounts — so money is labelled and the footer dated
  // with the right platform's values rather than always Meta's.
  let currency = client.metaCurrency ?? "USD";
  let adSyncedAt = client.lastSyncedAt;
  if (platform === "google") {
    const g = await getGoogleAccountSummary(client.id);
    currency = g.currency ?? client.metaCurrency ?? "USD";
    adSyncedAt = g.lastSynced;
  }

  return {
    platform,
    client: {
      id: client.id,
      name: client.name,
      slug: client.slug,
      timezone: tz,
      currency,
      lastSyncedAt: adSyncedAt?.toISOString() ?? null,
      firstWebhookAt: client.firstWebhookAt?.toISOString() ?? null,
    },
    range: {
      startKey: range.startKey,
      endKey: range.endKey,
      label: `${dayLabel(range.startKey)} – ${dayLabel(range.endKey)}`,
    },
    current,
    previous,
    deltas,
    funnel: buildFunnelSteps(current.funnel, FUNNEL_PATH),
    daily: dailyRaw,
    movingAverages,
    sevenDayChange: { current: sevenCurrent, previous: sevenPrevious },
    fourteenDayDaily: fourteenRaw
      .map((d) => ({ ...d, label: dayLabel(d.dateKey) }))
      .reverse(), // Most recent first, matching the sheet.
    monthOnMonth,
    campaigns,
    pipelineDistribution,
    leads,
    speedToLead,
    heatmap,
    prevDaily: prevDailyRaw,
    /*
     * Spend exists but NOT A SINGLE paid lead reached the CRM — the failure
     * worth shouting about, because cost-per-lead genuinely reads as a dash.
     * Keyed on the actual paid-lead count (funnel entries), NOT on
     * campaign-attributed leads: tag-only Instant Form leads are paid and make
     * cost metrics real, so they must not trip a "no leads qualified" banner.
     */
    attributionGap: current.ads.spend > 0 && current.funnel.new_lead === 0,
    leadFilter: { ...filter, ...leadBreakdown },
  };
}
