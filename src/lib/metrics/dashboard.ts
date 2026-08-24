import type { Client } from "@/db/schema";
import { FUNNEL_PATH } from "@/db/schema";
import {
  eachDateKey,
  previousWindow,
  shiftDateKey,
  todayKey,
  trailingMonths,
  trailingWindow,
  trailingWindowInclusive,
  windowFromKeys,
  dayLabel,
  type DateWindow,
} from "@/lib/dates";
import { detectAnomalies, BASELINE_DAYS, type AnomalyReport } from "./anomaly";
import { assessCandidates, type Candidate, type KeepKillReport } from "./keepkill";
import { buildCampaignStages, type CampaignStages } from "./campaign-stages";
import { buildSpeedOutcome, type SpeedOutcome } from "./speed-outcome";
import { buildAging, type AgingReport } from "./aging";
import { buildUncalled, type UncalledReport } from "./uncalled";
import { buildCallTiming, type CallTimingReport } from "./calltime";
import type { ForecastReport } from "./forecast";
import { buildDuplicates, type DuplicateReport } from "./duplicates";
import { wants } from "@/lib/dashboard/loading";
import type { SectionId } from "@/lib/dashboard/registry";
import { loadForecast } from "./forecast-load";
import { loadPacing, loadBudgetHistory, type MonthPacing } from "@/lib/budgets";
import type { BudgetHistory } from "./budget-history";
import { buildQuality, type QualityReport } from "./quality";
import { buildMaturation, type MaturationReport } from "./maturation";
import { buildChannelMix, type ChannelMix } from "./channels";
import {
  assessFatigue,
  EMPTY_FATIGUE_REPORT,
  FATIGUE_DAYS,
  type FatigueReport,
} from "./fatigue";
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
  getSpeedToLeadOutcomes,
  getStageAging,
  getUncalledLeads,
  getCohortMaturation,
  getCallTiming,
  getQualityCohort,
  getDuplicateCandidates,
  getChannelMix,
  getLeadArrivalHeatmap,
  getProvisionalCoverage,
  getAdDataDays,
  getFunnelByCampaign,
  getLearningCampaigns,
  getStageLag,
  getMappedStages,
  getCreativePerformance,
  getCreativeLeadReconciliation,
  getCreativeRevenue,
  getBreakdowns,
  getCreativeFatigueInput,
  getTrendAnnotations,
  hasAdLevelData,
  type ProvisionalCoverage,
  type CreativeRow,
  type CreativeLeadReconciliation,
  type CreativeOutcome,
  type RevenueAttributionCoverage,
  type Breakdowns,
  type TrendAnnotation,
  type AdPlatform,
  type DailyPoint,
  type PeriodMetrics,
  type PaidLeadFilter,
  type PipelineStageCount,
  type LeadRow,
  type SpeedToLead,
  type LeadHeatmap,
} from "./queries";

/**
 * Shapes handed back when a hidden section's query is skipped.
 *
 * Typed literals rather than `as` casts, so a change to any of these
 * interfaces fails the build here instead of rendering a section against a
 * value that no longer matches it. They are never displayed — a skipped
 * section is by definition not on the page — but `DashboardData` stays
 * non-nullable, which keeps every consumer free of a null check that would
 * exist solely because of an optimisation.
 */
const EMPTY_HEATMAP: LeadHeatmap = {
  grid: Array.from({ length: 7 }, () => new Array<number>(24).fill(0)),
  byDow: new Array<number>(7).fill(0),
  byHour: new Array<number>(24).fill(0),
  max: 0,
  total: 0,
};

const EMPTY_SPEED_TO_LEAD: SpeedToLead = {
  trackingStartedAt: null,
  leads: 0,
  trackable: 0,
  preTracking: 0,
  called: 0,
  uncalled: 0,
  medianSeconds: null,
  within5m: 0,
  within1h: 0,
  within24h: 0,
  rows: [],
};

/** The moving-average windows the source sheet reported. */
export const MOVING_AVERAGE_DAYS = [3, 7, 14, 30, 60, 90] as const;

/**
 * A creative with what it produced downstream of the click attached.
 *
 * `outcome` is null when no closed-won deal traces to the asset. While
 * `contacts.meta_ad_id` is unpopulated that is true of EVERY asset, so nothing
 * may be concluded from a null without first reading `revenueCoverage`.
 */
export type CreativeWithOutcome = CreativeRow & { outcome: CreativeOutcome | null };

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
  campaigns: Array<{
    campaignId: string;
    campaignName: string;
    platform: AdPlatform;
    spend: number;
    impressions: number;
    linkClicks: number;
    leads: number;
    cpLead: number | null;
  }>;
  /**
   * The same campaigns carried down the funnel: appointments, shows and closes
   * per campaign, with the cost at each and how stale that cost is.
   */
  campaignStages: CampaignStages;
  /** Opportunities whose lead date is a backfill, so their lag is unmeasurable. */
  lagUnmeasurable: number;
  /** Current-state pipeline snapshot: where every paid lead sits right now. */
  pipelineDistribution: { stages: PipelineStageCount[]; total: number };
  /** Every paid lead as a row — who, which stage, which campaign. */
  leads: LeadRow[];
  /** Speed to lead: time from lead-in to first outbound call, for this range. */
  speedToLead: SpeedToLead;
  /**
   * The other half of the same question: whether answering faster actually
   * produced more appointments, shows and closes — the two halves have been
   * stored separately since speed-to-lead shipped and nothing joined them.
   */
  speedOutcome: SpeedOutcome;
  /**
   * Open leads that have sat in one stage longer than this pipeline normally
   * takes there. `last_stage_change_at` has been written since the webhook
   * receiver shipped and read by nothing until now.
   */
  aging: AgingReport;
  /**
   * Leads nobody has phoned — the one section of this dashboard whose output is
   * a task rather than a fact.
   *
   * Distinct from `aging`, which asks who is overdue for the stage they sit in.
   * A lead can be called five times and still be overdue; this one has never
   * been called at all, which is both more urgent and completely actionable.
   */
  uncalled: UncalledReport;
  /**
   * When outbound calls actually reach someone, by hour of the client's day.
   *
   * Deliberately NOT close-rate-by-call-hour, which is what was asked for and
   * which restates §6.7's speed-to-lead with the axis relabelled. See
   * `calltime.ts`.
   */
  callTiming: CallTimingReport;
  /**
   * Where this calendar month lands if nothing changes.
   *
   * 🔴 Ignores the date picker by construction — it is a claim about the month,
   * so it loads the month. Spend and leads only; see `forecast.ts` for why
   * pacing appointments or closes forward would report the calendar as a
   * decline.
   */
  forecast: ForecastReport;
  /**
   * Budget pacing for the calendar month in progress. Null when the section is
   * hidden or the budgets table is not there yet.
   */
  pacing: MonthPacing | null;
  /**
   * Twelve months of agreed-versus-placed. Null when the section is hidden or
   * the budgets table is not there yet.
   */
  budgetHistory: { history: BudgetHistory; currency: string } | null;
  /**
   * Leads that look like the same person twice.
   *
   * 🔴 Read `coverage` before any count: most contacts in this book carry
   * neither a phone number nor an email address, and both are the only things
   * a match can be built from. See `duplicates.ts`.
   */
  duplicates: DuplicateReport;
  /**
   * Which groups of leads convert, at the level of the GROUP.
   *
   * Deliberately not a per-lead score — see `quality.ts` for why a score
   * changes the outcome it predicts.
   */
  quality: QualityReport;
  /**
   * How long a month's leads take to become appointments and closes, and
   * whether the two most recent months are even comparable yet.
   *
   * Trailing 12 months of arrival cohorts, so it is unaffected by the date
   * picker — the question "is last month actually worse" is about the calendar,
   * not the selected range.
   */
  maturation: MaturationReport;
  /**
   * Paid against everything else in the pipeline, and whether that split can be
   * believed at all.
   *
   * 🔴 Deliberately NOT built on `contacts.source` — see `channels.ts` for the
   * live check that ruled that column out.
   */
  channels: ChannelMix;
  /** False when the client counts every lead as paid, so there is no split. */
  channelSplitDefinable: boolean;
  /** When paid leads arrive — weekday × hour grid for the selected range. */
  heatmap: LeadHeatmap;
  /** Prior period's daily series, index-aligned to `daily`, for the ghost line. */
  prevDaily: DailyPoint[];
  /**
   * Events to mark on the trend chart's time axis — campaign launches, spend
   * jumps, stage remaps, accounts attached or removed.
   *
   * Answers "what happened on the 14th?" where the eye already is. A stage remap
   * matters most: it relabels history retroactively, so without the mark a
   * funnel that steps overnight has no distinguishable cause.
   */
  annotations: TrendAnnotation[];
  /**
   * Days inside the range that sit far outside this client's own normal.
   *
   * Distinct from `deltas`, which compares two whole periods and so averages
   * away the single Tuesday spend tripled on, and from the health checklist,
   * which by design answers whether the pipe is working rather than whether the
   * numbers coming through it look right.
   */
  anomalies: AnomalyReport;
  /**
   * Keep / kill, per campaign — a deterministic verdict and a confidence.
   *
   * Computed entirely from `keepkill.ts`; no model is involved in producing a
   * verdict, and the written explanation (when there is one) is checked back
   * against these figures before it can be shown.
   */
  keepKill: KeepKillReport;
  /**
   * Creatives that used to work and have stopped.
   *
   * Computed over its own trailing span, not the selected range — see
   * `loadCreatives`.
   */
  fatigue: FatigueReport;
  /** How much of the selected range Meta may still restate. */
  provisional: ProvisionalCoverage;
  /**
   * Per-ASSET performance — Meta only. Empty on the Google view, which has no
   * equivalent creative model in our schema.
   */
  creatives: CreativeWithOutcome[];
  /**
   * The two lead counts side by side, so the creative grid can name which one it
   * divides by. They differ by construction — see `getCreativeLeadReconciliation`.
   */
  creativeLeads: CreativeLeadReconciliation;
  /**
   * Whether ANY ad-level row exists for this client, at any date.
   *
   * Separates "no ads ran in this range" from "ad-level reporting had not been
   * switched on yet", which are different facts and look identical in the data.
   */
  adLevelSynced: boolean;
  /**
   * Why creative data could not be read, if it could not.
   *
   * Creative reporting is the one part of the page that depends on columns a
   * migration adds. Deploy the code before running the migration and every
   * creative query throws `column ... does not exist` — which, inside a single
   * `Promise.all`, would take the ENTIRE dashboard down rather than one section.
   * Contained here so a schema that is behind degrades to one honest panel
   * instead of an error page, and so the reason is visible rather than guessed.
   */
  creativesError: string | null;
  /**
   * How much of the closed-won revenue can actually be traced to a creative.
   *
   * **Read this before drawing any conclusion from `outcome`.** The join key is
   * `contacts.meta_ad_id`, which GHL only receives if the ad's URL parameters
   * carry `ad_id={{ad.id}}`. Where they don't, every creative shows zero deals —
   * and "these ads produced no customers" is a false claim about the ads rather
   * than a true one about the data.
   */
  revenueCoverage: RevenueAttributionCoverage;
  /**
   * Spend split by audience segment — region, placement, device, age, gender.
   *
   * Carries its own reconciliation gap per group: Meta suppresses segments below
   * its privacy threshold, so these never sum to account spend.
   */
  breakdowns: Breakdowns;
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
 * The four report tables, loaded separately from the dashboard core.
 *
 * These are the most expensive thing on the page and the least urgent: twelve
 * calendar months plus six trailing windows plus a seven-day pair is ~20 window
 * queries, each of which decomposes into more than one round trip. Measured
 * against production, keeping them on the critical path put `loadDashboard` at a
 * ~2.1s median and ~4.5s p95 — so the headline numbers, the funnel and the trend
 * all waited on tables that sit below the fold and two of which ship collapsed.
 *
 * They are also the one part of the page that does NOT respond to the date
 * picker (fixed trailing windows by design), so deferring them cannot make the
 * selected range look stale.
 */
export interface DeferredTables {
  movingAverages: PeriodMetrics[];
  sevenDayChange: { current: PeriodMetrics; previous: PeriodMetrics };
  fourteenDayDaily: Array<DailyPoint & { label: string }>;
  monthOnMonth: PeriodMetrics[];
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
  opts: {
    startKey?: string;
    endKey?: string;
    /**
     * Sections this render will actually show.
     *
     * 🔴 Omit it and everything loads. Only `/c/[slug]` passes a set — the
     * report, the share link, the present deck and the PDF renderer build their
     * own section lists and must not inherit a client's dashboard preferences.
     * See `lib/dashboard/loading.ts` for what may be skipped and what may not.
     */
    sections?: ReadonlySet<SectionId>;
  } = {},
  platform: AdPlatform = "meta",
): Promise<DashboardData> {
  const tz = client.timezone;
  const show = (id: SectionId) => wants(opts.sections, id);

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

  /*
   * The daily series is fetched with `BASELINE_DAYS` of lead-in before the
   * selected range, and the chart slices its own range back off the end.
   *
   * This is one query, not two: anomaly detection needs history the selected
   * range does not contain — a "last 7 days" view has no 7 days to judge itself
   * against — and a second `getDailySeries` call would cost two more round
   * trips on a page that already issues around sixty. Widening the existing one
   * costs the rows and nothing else.
   */
  const anomalyRange: DateWindow = windowFromKeys(
    shiftDateKey(range.startKey, -BASELINE_DAYS),
    range.endKey,
    tz,
  );
  const anomalyKeys = eachDateKey(anomalyRange, tz);

  // Arrival cohorts for the maturation panel. Hoisted above the query batch
  // because both the query and the engine need the same month windows, built
  // once in the client's timezone.
  const months = trailingMonths(12, tz);

  const [
    current,
    previous,
    reach,
    extendedDaily,
    campaignRows,
    leadsByCampaign,
    leadBreakdown,
    pipelineDistribution,
    leads,
    speedToLead,
    heatmap,
    prevDailyRaw,
    provisional,
    annotations,
    adDataDays,
    funnelByCampaign,
    learningCampaigns,
    stageLag,
    mappedStages,
    speedCohort,
    agingInput,
    uncalledInput,
    cohortInput,
    channelInput,
    callTimingInput,
    qualityCohort,
    forecastResult,
    duplicateCandidates,
  ] = await Promise.all([
    // Only these two pass `includeRevenue` — they feed the headline tiles and
    // the deltas. The trailing-window and month-on-month rows below do not
    // display revenue, and fetching it for all ~22 of them would add a round
    // trip each to a page that already issues roughly sixty.
    getPeriodMetrics(client.id, range, "Selected range", undefined, filter, platform, true),
    getPeriodMetrics(client.id, prevRange, "Previous period", undefined, filter, platform, true),
    // Reach is a Meta concept (deduplicated people, in `fb_period_reach`); Google
    // has no equivalent in our schema, so the Google view leaves it null.
    platform === "meta" ? getPeriodReach(client.id, range) : Promise.resolve(null),
    getDailySeries(client.id, anomalyRange, tz, anomalyKeys, undefined, filter, platform),

    getCampaignBreakdown(client.id, range, platform),
    getLeadsByCampaign(client.id, range, filter, platform),
    getLeadAttributionBreakdown(client.id, range, filter, platform),
    getPipelineDistribution(client.id, filter, platform),
    getLeads(client.id, filter, 2000, platform),
    show("speed_to_lead")
      ? getSpeedToLead(client.id, range, filter, platform)
      : Promise.resolve(EMPTY_SPEED_TO_LEAD),
    show("heatmap")
      ? getLeadArrivalHeatmap(client.id, range, tz, filter, platform)
      : Promise.resolve(EMPTY_HEATMAP),
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
    getProvisionalCoverage(client.id, range, platform),
    getTrendAnnotations(client.id, range, tz),
    // Over the SAME extended window the series covers, so a gap that began
    // before the range is still known to have begun.
    getAdDataDays(client.id, anomalyRange, platform),
    // Per-campaign funnel counts for keep/kill — one grouped query, so the
    // engine can judge on appointments rather than on leads (§6.6).
    getFunnelByCampaign(client.id, range, filter, platform),
    getLearningCampaigns(client.id, platform),
    getStageLag(client.id, range, filter, platform),
    getMappedStages(client.id),
    // The cohort behind "does answering faster book more" — one row per lead,
    // with its response time and every stage it later reached.
    show("speed_outcome")
      ? getSpeedToLeadOutcomes(client.id, range, tz, filter, platform)
      : Promise.resolve({ trackingStartedAt: null, preTracking: 0, leads: [] }),
    // Current-state, so no window: "which leads are rotting" is not a
    // question about the selected dates.
    show("aging")
      ? getStageAging(client.id, filter, platform)
      : Promise.resolve({ dwells: [], sitting: [] }),
    // Both sides of the lead filter, so the engine can say how many uncalled
    // leads sit outside it rather than printing a short list as a complete one.
    show("uncalled")
      ? getUncalledLeads(client.id, tz, filter, platform)
      : Promise.resolve({
          leads: [],
          callWeekdays: [],
          trackingStartedAt: null,
          preTracking: 0,
          costPerLead: null,
        }),
    // Arrival cohorts for the trailing year, and every conversion they went on
    // to produce — followed forward out of their own month.
    show("maturation")
      ? getCohortMaturation(client.id, months, tz, filter, platform)
      : Promise.resolve({ leadsByMonth: new Map<string, number>(), conversions: [] }),
    show("channels")
      ? getChannelMix(client.id, months, tz, filter, platform)
      : Promise.resolve({ rows: [], splitDefinable: false }),
    /*
     * Call attempts and lead arrivals by local hour. Degrades to an empty list
     * rather than throwing: this reads the raw webhook log, which is the one
     * table that must never take a page down.
     */
    show("call_timing")
      ? getCallTiming(client.id, tz, range).catch((err) => {
          console.error("[dashboard] call timing unavailable:", err);
          return [];
        })
      : Promise.resolve([]),
    show("lead_quality")
      ? getQualityCohort(client.id, range, tz, filter, platform).catch((err) => {
          console.error("[dashboard] quality cohort unavailable:", err);
          return [];
        })
      : Promise.resolve([]),
    /*
     * The calendar month, not the selected range — the forecast is a claim
     * about the month and loads its own window. Guarded like the two above so a
     * failure costs one panel rather than the page.
     */
    show("forecast")
      ? loadForecast(client.id, tz, filter, platform).catch((err) => {
          console.error("[dashboard] forecast unavailable:", err);
          return null;
        })
      : Promise.resolve(null),
    /*
     * Reaches further back than the range on purpose — a duplicate is a pair,
     * and a pair straddles boundaries. Guarded like its neighbours.
     */
    show("duplicates")
      ? getDuplicateCandidates(client.id, range, filter, platform).catch((err) => {
          console.error("[dashboard] duplicate scan unavailable:", err);
          return { rows: [], total: 0 };
        })
      : Promise.resolve({ rows: [], total: 0 }),
  ]);

  /*
   * The chart's own range, sliced back off the end. `getDailySeries` emits one
   * row per requested key in order, so the last `rangeKeys.length` rows are
   * exactly the selected range — but slice by key rather than by count, because
   * an off-by-one here would silently shift every point on the trend chart by a
   * day and look like a data problem.
   */
  const dailyRaw = extendedDaily.filter((p) => p.dateKey >= range.startKey);

  /*
   * Creative queries run AFTER the core bundle, not inside it — deliberately
   * serialized, and measured rather than assumed.
   *
   * Running them concurrently, a creative failure took the whole dashboard down
   * 6 times out of 10 against the live database. Isolating them behind
   * `allSettled` was not enough: the Neon WebSocket pool tears down the
   * connection a failed query was using, and every OTHER query in flight on that
   * same connection fails with it — so `getCampaignBreakdown` died carrying a
   * "column m.creative_key does not exist" cause it had nothing to do with.
   *
   * Sequencing them after costs one round trip of three indexed aggregates. It
   * buys the guarantee that the newest section on the page can never take down
   * the numbers that were working yesterday.
   */
  const {
    creatives,
    creativeLeads,
    adLevelSynced,
    creativesError,
    revenueCoverage,
    breakdowns,
    fatigue,
  } = await loadCreatives(client.id, range, filter, platform, client.timezone);

  // Reach is only valid when queried for this exact window — never summed.
  current.ads.reach = reach;
  // Re-derive with revenue passed back in. Omitting it here would silently reset
  // roas/avgDeal to null on the ONE period the headline tiles read from, while
  // every table row kept its value — a discrepancy nobody would trace back here.
  current.derived = derive(current.funnel, current.ads, current.revenue);

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
    revenue: pctChange(
      current.revenue?.revenue ?? null,
      previous.revenue?.revenue ?? null,
    ),
    roas: pctChange(current.derived.roas, previous.derived.roas),
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

  /*
   * The same campaign rows, carried down to appointments, shows and closes.
   *
   * Built from `funnelByCampaign`, which the keep/kill engine already
   * loaded — the deep-stage costs cost zero extra round trips, which is the
   * whole reason `getFunnelByCampaign` returns every stage rather than the one
   * keep/kill happened to need.
   */
  const campaignStages = buildCampaignStages(campaigns, funnelByCampaign, {
    mappedStages,
    lag: stageLag.lag,
  });

  /*
   * `asOf` is now, not the end of the selected range, and the distinction is
   * load-bearing. Maturation asks "has this lead had time to convert *yet*",
   * which is a question about the present — a January cohort viewed in August
   * is fully matured, and passing the range end would freeze it as though it
   * were still last winter and withhold every lead in it.
   */
  const aging = buildAging(agingInput.dwells, agingInput.sitting);

  /*
   * No `asOf` here, unlike every other engine on this page: the clock is whole
   * days between the lead's arrival date and today, both computed in the
   * client's timezone by Postgres, where the arithmetic is exact. The engine
   * only counts which of those days are working days.
   */
  const uncalled = buildUncalled(uncalledInput.leads, {
    callWeekdays: uncalledInput.callWeekdays,
    trackingStartedAt: uncalledInput.trackingStartedAt,
    preTracking: uncalledInput.preTracking,
    costPerLead: uncalledInput.costPerLead,
  });

  /*
   * No `asOf` and no censoring here either: a call attempt has its outcome the
   * moment it ends, so unlike every conversion on this page there is nothing to
   * wait for and nothing to bias against a recent hour.
   */
  const callTiming = buildCallTiming(callTimingInput);

  /*
   * `no_data` when the load failed, which is the same thing the panel renders
   * for a month that has not started — deliberately, because both are "there is
   * nothing to project from" and neither is a claim about the business. A
   * separate error state here would be a second way of saying it with no
   * different action attached.
   */
  /*
   * The scan reaches back beyond the range so pairs are not split at the
   * boundary, but only groups with an arrival INSIDE the range are reported —
   * otherwise a duplicate from four months ago would resurface on every
   * dashboard load forever, long after anyone could act on it.
   */
  const duplicatesAll = buildDuplicates(duplicateCandidates.rows, {
    totalLeads: duplicateCandidates.total,
  });
  const inRange = new Set(
    duplicateCandidates.rows.filter((r) => r.inRange).map((r) => r.id),
  );
  const duplicates: DuplicateReport = {
    ...duplicatesAll,
    groups: duplicatesAll.groups.filter((g) =>
      g.leads.some((l) => inRange.has(l.id)),
    ),
    /*
     * Recomputed over the reported groups rather than carried from the full
     * scan: the corrected cost per lead divides the RANGE's spend, so counting
     * repeats from outside the range would subtract leads that spend never
     * bought.
     */
    redundantLeads: duplicatesAll.groups
      .filter((g) => g.kind === "duplicate")
      .reduce((total, g) => {
        const here = g.leads.filter((l) => inRange.has(l.id)).length;
        /*
         * When the FIRST arrival predates the range, every arrival inside it is
         * a repeat. When the whole group sits inside, one of them is the
         * original and only the rest are repeats.
         */
        const originalIsInRange = here === g.leads.length;
        return total + here - (originalIsInRange ? 1 : 0);
      }, 0),
    returningGroups: duplicatesAll.groups.filter(
      (g) => g.kind === "returning" && g.leads.some((l) => inRange.has(l.id)),
    ).length,
    checkableLeads: duplicateCandidates.rows.filter((r) => r.inRange).length,
  };

  const forecast: ForecastReport = forecastResult ?? {
    verdict: "no_data",
    monthKey: "",
    completeDays: 0,
    remainingDays: 0,
    daysInMonth: 0,
    weekdayWeighted: false,
    metrics: [],
    projectedCpl: null,
    observedCpl: null,
  };

  /*
   * Pacing is loaded here, AFTER the forecast, and is handed the report rather
   * than loading its own.
   *
   * 🔴 Both panels answer "where does this month land", and they must not
   * answer it differently. Passing the report through means the pacing meter
   * quotes the same weekday-weighted figure "Where this month lands" shows,
   * rather than the cruder flat run rate it would compute alone — and it costs
   * no extra query. See `metrics/pacing.ts`.
   *
   * Guarded like its neighbours: `ad_budgets` is a new table, and a deploy
   * landing before its migration must cost this panel rather than the page.
   */
  const [pacing, budgetHistory] = await Promise.all([
    show("budget_pacing")
      ? loadPacing(client, platform, { forecast: forecastResult }).catch((err) => {
          console.error("[dashboard] pacing unavailable:", err);
          return null;
        })
      : Promise.resolve(null),
    /*
     * The record in arrears. Two queries whatever the window — see
     * `loadBudgetHistory` — and guarded like its neighbour so a deploy ahead of
     * the budgets migration costs this panel and nothing else.
     */
    show("budget_delivery")
      ? loadBudgetHistory(client, platform).catch((err) => {
          console.error("[dashboard] budget history unavailable:", err);
          return null;
        })
      : Promise.resolve(null),
  ]);

  /*
   * `asOf` is now, not the range end, and for the same reason maturation uses
   * it: whether a lead has had time to convert is a question about the present.
   * Passing the range end would freeze an old cohort as though it were still
   * the day the range closed and withhold leads that converted months ago.
   */
  const quality = buildQuality(qualityCohort, {
    stage: "appointment_booked",
    asOf: new Date(),
    campaignNames: Object.fromEntries(
      campaigns
        .filter((c) => c.campaignId)
        .map((c) => [c.campaignId as string, c.campaignName]),
    ),
  });

  /*
   * `asOf` is now, not the range end: a cohort's maturity is a question about
   * how much time has passed since it opened, which the date picker cannot
   * change.
   */
  const monthLabel = new Map(months.map((m) => [m.monthKey, m.label]));
  const channels = buildChannelMix(
    channelInput.rows.map((r) => ({ ...r, label: monthLabel.get(r.month) ?? r.month })),
  );

  const maturation = buildMaturation(
    months.map((m) => ({
      month: m.monthKey,
      label: m.label,
      leads: cohortInput.leadsByMonth.get(m.monthKey) ?? 0,
      startUtc: m.startUtc.toISOString(),
      complete: m.endUtc.getTime() <= Date.now(),
    })),
    cohortInput.conversions.map((c) => ({
      month: c.month,
      stage: c.stage as "appointment_booked" | "showed" | "closed_won",
      days: c.days,
    })),
    { asOf: new Date() },
  );

  const speedOutcome = buildSpeedOutcome(speedCohort.leads, {
    asOf: new Date(),
    mappedStages,
    trackingStartedAt: speedCohort.trackingStartedAt,
    preTracking: speedCohort.preTracking,
  });

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

  /*
   * Computed here rather than beside the query because the findings quote
   * money, and the currency is not known until the Google account summary
   * above has resolved — a Google view priced in Meta's currency would print
   * "$" over figures the platform reported in CAD.
   */
  /*
   * Keep / kill, from the campaign rows already assembled.
   *
   * The "Unattributed" pseudo-row is excluded: it has no spend of its own to
   * judge, and a bucket that exists to make totals reconcile is not something
   * anyone can switch off.
   */
  const keepKill = assessCandidates(
    campaigns
      .filter((cam) => cam.campaignId !== "")
      .map<Candidate>((cam) => ({
        id: cam.campaignId,
        name: cam.campaignName,
        spend: cam.spend,
        conversions: funnelByCampaign.get(cam.campaignId) ?? {},
        inLearning: learningCampaigns.has(cam.campaignId),
      })),
  );

  const anomalies = detectAnomalies({
    series: extendedDaily,
    testFrom: range.startKey,
    testTo: range.endKey,
    // The CLIENT's today, not the server's. A dashboard loaded at 21:00 in
    // California must not treat the Sydney client's tomorrow as finished.
    todayKey: todayKey(tz),
    adDataDays,
    currency,
  });

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
    campaigns,
    campaignStages,
    lagUnmeasurable: stageLag.excludedBackfill,
    pipelineDistribution,
    leads,
    speedToLead,
    speedOutcome,
    aging,
    uncalled,
    callTiming,
    forecast,
    pacing,
    budgetHistory,
    duplicates,
    quality,
    maturation,
    channels,
    channelSplitDefinable: channelInput.splitDefinable,
    heatmap,
    prevDaily: prevDailyRaw,
    provisional,
    annotations,
    anomalies,
    keepKill,
    creatives,
    fatigue,
    creativeLeads,
    adLevelSynced,
    creativesError,
    revenueCoverage,
    breakdowns,
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

/**
 * The useful sentence out of a database error.
 *
 * Drizzle's own `message` is the literal string "Failed query:" followed by the
 * entire SQL text — a 2KB diagnostic that buries the one line that says what is
 * wrong. Postgres puts that line on the `cause` (`relation "x" does not exist`),
 * so prefer it and cap whatever is left.
 */
function describeDbError(err: unknown): string {
  const cause = (err as { cause?: unknown })?.cause;
  const message =
    (cause as Error)?.message ?? (err as Error)?.message ?? String(err);
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}

interface CreativeBundle {
  creatives: CreativeWithOutcome[];
  creativeLeads: CreativeLeadReconciliation;
  adLevelSynced: boolean;
  creativesError: string | null;
  revenueCoverage: RevenueAttributionCoverage;
  breakdowns: Breakdowns;
  fatigue: FatigueReport;
}

const NO_BREAKDOWNS: Breakdowns = {
  groups: [],
  totalSpend: 0,
  everSynced: false,
  singleDay: false,
};

const NO_CREATIVES: CreativeBundle = {
  creatives: [],
  creativeLeads: { metaReported: 0, crmRecorded: 0, gap: 0 },
  adLevelSynced: false,
  creativesError: null,
  revenueCoverage: {
    totalDeals: 0,
    attributedDeals: 0,
    recentContacts: 0,
    recentContactsWithAdId: 0,
  },
  breakdowns: NO_BREAKDOWNS,
  fatigue: EMPTY_FATIGUE_REPORT,
};

/**
 * The creative queries, isolated behind a catch.
 *
 * Two reasons this is not just three more entries in the big `Promise.all`:
 *
 * 1. **Creative reporting is Meta-only.** Its identity is `image_hash` /
 *    `video_id`, which has no Google equivalent in our schema. The Google view
 *    gets an empty list rather than a borrowed one.
 * 2. **These are the only queries that depend on a migration.** Ship the code
 *    before running it and `column "video_3s_views" does not exist` rejects the
 *    shared `Promise.all`, taking down the whole dashboard — spend, funnel,
 *    leads and all — over one section that did not exist yesterday. Contained
 *    here, a schema that is behind costs exactly the panel it affects, and the
 *    reason is carried through to the UI rather than left to be guessed at.
 */
async function loadCreatives(
  clientId: string,
  range: DateWindow,
  filter: PaidLeadFilter,
  platform: AdPlatform,
  tz: string,
): Promise<CreativeBundle> {
  if (platform !== "meta") return NO_CREATIVES;

  /*
   * Fatigue reads its own span, not the picker's.
   *
   * "Has this creative stopped working" is a question about the creative's
   * history, and a viewer switching to a 7-day range has not changed the answer
   * — they have merely stopped being able to see it. Anchored to the END of the
   * selected range rather than to today, so a custom historical range still
   * reports what the right call would have been at the time.
   */
  const fatigueWindow = windowFromKeys(
    shiftDateKey(range.endKey, -(FATIGUE_DAYS - 1)),
    range.endKey,
    tz,
  );

  /*
   * `allSettled`, NOT `all` — and this is load-bearing rather than stylistic.
   *
   * All three of these queries fail together when the schema is behind. With
   * `Promise.all`, the try/catch below sees the FIRST rejection and the other
   * two reject with nobody listening, which Node treats as an unhandled
   * rejection and terminates the process over. Verified against the live
   * database: the catch reported the error correctly and the request died
   * anyway. `allSettled` gives every promise a handler.
   */
  const [creativesR, leadsR, syncedR, revenueR, breakdownsR, fatigueR] = await Promise.allSettled([
    getCreativePerformance(clientId, range),
    getCreativeLeadReconciliation(clientId, range, filter),
    hasAdLevelData(clientId),
    getCreativeRevenue(clientId, range, filter),
    // Same migration dependency, same isolation: `fb_breakdown_metrics` arrives
    // with 0011, so on a deploy that outruns the migration this must cost its own
    // panel rather than the page.
    getBreakdowns(clientId, range),
    getCreativeFatigueInput(clientId, fatigueWindow),
  ]);

  const failure = [creativesR, leadsR, syncedR, revenueR, breakdownsR, fatigueR].find(
    (r) => r.status === "rejected",
  );
  if (failure && failure.status === "rejected") {
    console.error("[dashboard] creative queries failed", failure.reason);
    return { ...NO_CREATIVES, creativesError: describeDbError(failure.reason) };
  }

  const revenue = revenueR.status === "fulfilled" ? revenueR.value : null;
  const base = creativesR.status === "fulfilled" ? creativesR.value : [];

  return {
    /*
     * Outcomes are attached per creative rather than kept in a parallel map so
     * a card cannot render spend from one row and revenue from another. `null`
     * means "no closed-won deal traced to this asset" — which, while the ad id
     * is missing from attribution, is true of every asset. The UI must read
     * `revenueCoverage` before drawing any conclusion from that.
     */
    creatives: base.map((c) => ({
      ...c,
      outcome: revenue?.byCreative.get(c.creativeKey) ?? null,
    })),
    creativeLeads:
      leadsR.status === "fulfilled" ? leadsR.value : NO_CREATIVES.creativeLeads,
    adLevelSynced: syncedR.status === "fulfilled" ? syncedR.value : false,
    creativesError: null,
    revenueCoverage: revenue?.coverage ?? NO_CREATIVES.revenueCoverage,
    breakdowns: breakdownsR.status === "fulfilled" ? breakdownsR.value : NO_BREAKDOWNS,
    fatigue:
      fatigueR.status === "fulfilled"
        ? assessFatigue(fatigueR.value)
        : EMPTY_FATIGUE_REPORT,
  };
}

/**
 * The four report tables, loaded off the critical path.
 *
 * Split out of `loadDashboard` after measuring it against production at a ~2.1s
 * median and ~4.5s p95: these ~20 window queries were blocking first paint for
 * content that sits below the fold, ignores the date picker, and ships collapsed
 * in two of four cases. The page renders its headline numbers, funnel and trend
 * immediately and streams these in behind a Suspense boundary.
 *
 * Takes the same client and platform as `loadDashboard` and re-derives the
 * filter rather than accepting one, so the two entry points cannot drift into
 * counting different leads.
 */
export async function loadDeferredTables(
  client: Client,
  platform: AdPlatform = "meta",
): Promise<DeferredTables> {
  const tz = client.timezone;
  const filter: PaidLeadFilter = {
    mode: client.paidLeadFilter,
    tag: client.paidLeadTag,
  };

  const [movingAverages, sevenCurrent, sevenPrevious, fourteenRaw, monthOnMonth] =
    await Promise.all([
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
        return getDailySeries(
          client.id,
          w,
          tz,
          eachDateKey(w, tz),
          undefined,
          filter,
          platform,
        );
      })(),
      Promise.all(
        trailingMonths(12, tz).map((m) =>
          getPeriodMetrics(client.id, m, m.label, undefined, filter, platform),
        ),
      ),
    ]);

  return {
    movingAverages,
    sevenDayChange: { current: sevenCurrent, previous: sevenPrevious },
    fourteenDayDaily: fourteenRaw
      .map((d) => ({ ...d, label: dayLabel(d.dateKey) }))
      .reverse(), // Most recent first, matching the sheet.
    monthOnMonth,
  };
}
