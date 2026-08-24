import { Suspense } from "react";
import Link from "next/link";
import {
  loadDeferredTables,
  MOVING_AVERAGE_DAYS,
  type DashboardData,
} from "@/lib/metrics/dashboard";
import {
  formatCurrency,
  formatNumber,
  formatPercent,
  formatMultiple,
  DASH,
} from "@/lib/metrics/compute";
import { StatTile } from "@/components/StatTile";
import { Funnel } from "@/components/Funnel";
import { MonthForecast } from "@/components/MonthForecast";
import { DuplicateLeads } from "@/components/DuplicateLeads";
import { PipelineExplorer } from "@/components/PipelineExplorer";
import { SpeedToLeadWidget } from "@/components/SpeedToLead";
import { SpeedOutcomePanel } from "@/components/SpeedOutcome";
import { CallTimingPanel } from "@/components/CallTiming";
import { LeadQualityPanel } from "@/components/LeadQuality";
import { StageAgingPanel } from "@/components/StageAging";
import { CallListPanel } from "@/components/CallList";
import { MaturationPanel } from "@/components/Maturation";
import { ChannelMixPanel } from "@/components/ChannelMix";
import { TrendCharts } from "@/components/TrendCharts";
import { MetricsTable } from "@/components/MetricsTable";
import { changesBetween } from "@/lib/metrics/table-columns";
import { LeadHeatmap } from "@/components/LeadHeatmap";
import { CampaignStageTable } from "@/components/CampaignStageTable";
import { CreativeGrid } from "@/components/CreativeGrid";
import { CreativeFatiguePanel } from "@/components/CreativeFatigue";
import { Breakdowns } from "@/components/Breakdowns";
import { InsightStrip } from "@/components/InsightStrip";
import { AnomalyPanel } from "@/components/AnomalyPanel";
import { WeeklySummary } from "@/components/WeeklySummary";
import { MonthlyCommentary } from "@/components/MonthlyCommentary";
import { KeepKill } from "@/components/KeepKill";
import { type DataStateProps } from "@/components/DataState";
import { BudgetPacing } from "@/components/BudgetPacing";
import { BudgetHistoryPanel } from "@/components/BudgetHistory";
import { monthLabel } from "@/lib/commentary/model";
import { Icon } from "@/components/Icon";
import type { Insight } from "@/lib/metrics/insights";
import type { CommentaryForEditor } from "@/lib/commentary/report";
import type { StoredSummary } from "@/lib/ai/store";
import type { AdPlatform, PeriodMetrics } from "@/lib/metrics/queries";
import type { Client } from "@/db/schema";
import {
  CADENCE_HINT,
  CADENCE_LABEL,
  SECTION_BY_ID,
  type SectionId,
} from "./registry";

/**
 * Renders one registry section.
 *
 * Split out of the page so ordering and visibility are a list to map over
 * rather than a diff through a 987-line JSX tree. The markup below is the same
 * markup that was inline — this is a shape change, verified against a captured
 * render of four URL variants, not a redesign.
 *
 * Everything a section can read arrives in `SectionContext`. It is deliberately
 * one wide object rather than per-section prop types: the page already computes
 * all of it, and threading nine different shapes through a switch would add
 * ceremony without adding a single guarantee.
 */
export interface SectionContext {
  data: DashboardData;
  client: Client;
  platform: AdPlatform;
  slug: string;
  staff: boolean;
  currency: string;
  spendLabel: string;
  /** What the KPI deltas compare against, named — "previous 30 days". */
  basis: string;
  insights: Insight[];
  campaignColors: Record<string, string>;
  campaignNames: Record<string, string>;
  /** Why ad data is absent or degraded. Null when the pipe is healthy. */
  adState: DataStateProps | null;
  /** Same, for the CRM side. Takes whether the calling panel is itself empty. */
  crmState: (emptyPanel: boolean) => DataStateProps | null;
  sparkSpend: number[];
  sparkLeads: number[];
  sparkAppts: number[];
  sparkWon: number[];
  valuesMissing: boolean;
  revenueFootnote: string | undefined;
  /**
   * Render charts at a fixed pixel width instead of measuring the container.
   *
   * Set by the report document, which is a fixed-width page meant to be
   * printed. `ResponsiveContainer` measures via `ResizeObserver`, and print
   * re-lays-out at the PAPER width without waiting for that observation — so a
   * measured chart prints at its stale screen width. Undefined everywhere else,
   * which leaves the dashboard exactly as it was.
   */
  printWidth?: number;
  /**
   * Stored written summaries for this period, plus whether drafting is wired
   * up. Loaded only for staff — the section is absent from a client registry,
   * so a client render never needs it and never pays for the query.
   */
  summaries?: {
    summaries: StoredSummary[];
    error: string | null;
    configured: boolean;
  };
  /**
   * The month being commented on, its working copy, and the previous month's
   * published plan. Staff only, for the same reason as `summaries`.
   *
   * `months` is the picker's list rather than a range, because this panel is
   * the one place on the dashboard that deliberately ignores the date picker —
   * see the `month` cadence in the registry.
   */
  commentary?: CommentaryForEditor & { months: string[] };
}

/**
 * A section whose window is not the one the date picker selects says so.
 *
 * The picker sits at the top of the page and does nothing for the report tables
 * (fixed trailing windows) or the pipeline explorer (current state, no date
 * filter at all). Selecting "last 7 days" and then reading a pipeline of 700
 * leads is the interface misleading the reader, not the data.
 */
function CadenceBadge({ id }: { id: SectionId }) {
  const def = SECTION_BY_ID[id];
  const label = CADENCE_LABEL[def.cadence];
  if (!label) return null;
  return (
    <div
      className="-mb-3 flex items-center gap-1.5 text-[11px]"
      style={{ color: "var(--text-muted)" }}
      title={CADENCE_HINT[def.cadence] ?? undefined}
    >
      <Icon name="help" size={11} />
      <span>{label} — not affected by the date range above</span>
    </div>
  );
}

export function renderSection(id: SectionId, ctx: SectionContext) {
  const {
    data,
    client,
    platform,
    slug,
    staff,
    currency,
    spendLabel,
    basis,
    insights,
    campaignColors,
    campaignNames,
    adState,
    crmState,
    sparkSpend,
    sparkLeads,
    sparkAppts,
    sparkWon,
    valuesMissing,
    revenueFootnote,
    printWidth,
  } = ctx;
  const { current, deltas, daily } = data;

  switch (id) {
    case "lead_filter_note":
      return (
        <>
      <LeadFilterNote
        filter={data.leadFilter}
        slug={slug}
        platform={platform}
        staff={staff}
      />
        </>
      );

    case "insights":
      return (
        <>
      {/* What changed — the narrative above the numbers. */}
      <InsightStrip insights={insights} />
        </>
      );

    case "anomalies":
      return (
        <>
      {/* Individual days outside this account's own normal. */}
      <AnomalyPanel report={data.anomalies} rangeLabel={data.range.label} />
        </>
      );

    case "weekly_summary":
      /*
       * Staff-only, and belt-and-braces: the section is already absent from a
       * client's registry, so this branch is unreachable for them. It stays
       * because "unreachable" is a property of another file.
       */
      if (!staff) return null;
      return (
        <>
      <WeeklySummary
        slug={slug}
        platform={platform}
        rangeStart={data.range.startKey}
        rangeEnd={data.range.endKey}
        periodLabel={data.range.label}
        initial={ctx.summaries?.summaries ?? []}
        unavailable={
          ctx.summaries?.error
            ? "Written summaries need a database migration that has not been applied yet. Every figure on this page is unaffected."
            : null
        }
        configured={ctx.summaries?.configured ?? false}
      />
        </>
      );

    case "commentary":
      /*
       * Staff-only, belt-and-braces: already absent from a client's registry,
       * so this branch is unreachable for them. It stays because
       * "unreachable" is a property of another file.
       */
      if (!staff || !ctx.commentary) return null;
      return (
        <>
      <MonthlyCommentary
        slug={slug}
        platform={platform}
        month={ctx.commentary.month}
        months={ctx.commentary.months}
        initial={ctx.commentary}
      />
        </>
      );

    case "kpis":
      return (
        <>
      {/* Headline KPIs */}
      <section
        className="grid grid-cols-2 gap-3.5 md:grid-cols-3 lg:grid-cols-4"
        aria-label="Headline metrics"
      >
        <StatTile
          label="Ad spend"
          value={formatCurrency(current.ads.spend, currency)}
          numeric={current.ads.spend}
          format="currency"
          currency={currency}
          metricKey="spend"
          basis={basis}
          change={deltas.spend}
          spark={sparkSpend}
        />
        <StatTile
          label="New leads"
          value={formatNumber(current.funnel.new_lead)}
          numeric={current.funnel.new_lead}
          format="number"
          metricKey="new_lead"
          basis={basis}
          change={deltas.new_lead}
          spark={sparkLeads}
          emphasis
        />
        <StatTile
          label="Cost per lead"
          value={formatCurrency(current.derived.cpLead, currency)}
          numeric={current.derived.cpLead}
          format="currency"
          currency={currency}
          metricKey="cpLead"
          basis={basis}
          change={deltas.cpLead}
          /*
           * Both numbers, never only the flattering one.
           *
           * Once junk leads are being marked, cost per lead has two honest
           * readings: what every lead cost, and what the leads that were
           * actually prospects cost. Showing only the second quietly drops junk
           * from the denominator, which is exactly the massaging this product
           * replaced. Showing both also cancels the incentive split — the client
           * has reason to over-mark junk to argue the ads are bad, the agency to
           * under-mark it; with both on screen neither move works.
           */
          footnote={
            current.derived.cpLead === null && current.funnel.new_lead > 0
              ? "No spend recorded"
              : current.derived.cpLeadQualified !== null
                ? `${formatCurrency(current.derived.cpLeadQualified, currency)} excluding ${formatNumber(current.funnel.disqualified)} disqualified`
                : undefined
          }
        />
        <StatTile
          label="Appointments"
          value={formatNumber(current.funnel.appointment_booked)}
          numeric={current.funnel.appointment_booked}
          format="number"
          metricKey="appointment_booked"
          basis={basis}
          change={deltas.appointment_booked}
          spark={sparkAppts}
          footnote={`${formatPercent(current.derived.bookPct, 1)} of leads`}
        />
        <StatTile
          label="Showed"
          value={formatNumber(current.funnel.showed)}
          numeric={current.funnel.showed}
          format="number"
          metricKey="showed"
          basis={basis}
          change={deltas.showed}
          footnote={`${formatPercent(current.derived.showPct, 1)} of appts`}
        />
        <StatTile
          label="Closed / won"
          value={formatNumber(current.funnel.closed_won)}
          numeric={current.funnel.closed_won}
          format="number"
          metricKey="closed_won"
          basis={basis}
          change={deltas.closed_won}
          spark={sparkWon}
          footnote={`${formatCurrency(current.derived.cpWon, currency)} each`}
        />
        {/*
         * Revenue and ROAS: the two tiles that let a client answer "did this
         * make money", which six cost metrics could not.
         *
         * `valuesMissing` is the honest case and it is live today — deals are
         * closing with no value recorded against them, so a naive tile would
         * print $0.00 and read as "the ads produced no revenue" when the truth
         * is that nobody filled the field. Same failure shape as the source
         * sheet's $0.00 cost-per-lead. Show a dash and name the reason.
         */}
        <StatTile
          label="Revenue"
          value={
            valuesMissing || !current.revenue
              ? DASH
              : formatCurrency(current.revenue.revenue, currency)
          }
          numeric={valuesMissing ? null : (current.revenue?.revenue ?? null)}
          format="currency"
          currency={currency}
          metricKey="revenue"
          basis={basis}
          change={valuesMissing ? null : deltas.revenue}
          footnote={revenueFootnote}
        />
        <StatTile
          label="ROAS"
          value={formatMultiple(current.derived.roas)}
          numeric={current.derived.roas}
          format="multiple"
          metricKey="roas"
          basis={basis}
          change={deltas.roas}
          footnote={
            valuesMissing
              ? "Needs deal values in GHL"
              : current.derived.avgDeal !== null
                ? `${formatCurrency(current.derived.avgDeal, currency)} avg deal`
                : undefined
          }
        />
      </section>
        </>
      );

    case "budget_delivery": {
      // Absent, not empty, when the load failed or nothing was ever agreed —
      // the panel itself declines to render a history of nothing.
      if (!data.budgetHistory) return null;
      return (
        <BudgetHistoryPanel
          history={data.budgetHistory.history}
          currency={data.budgetHistory.currency}
        />
      );
    }

    case "budget_pacing": {
      /*
       * Absent, not empty, when the load failed or the table is not there yet:
       * a pacing panel showing zeroes would read as "no spend against budget",
       * which is a claim rather than a gap.
       */
      if (!data.pacing) return null;
      return (
        <BudgetPacing
          pacing={data.pacing}
          currency={data.client.currency}
          monthLabel={monthLabel(data.pacing.monthKey)}
        />
      );
    }

    case "forecast":
      return (
        <>
          {/*
            The first panel on the page about what has NOT happened yet. Reads
            the calendar month rather than the selected range — see
            `forecast-load.ts` for why that had to be its own query.
          */}
          <MonthForecast report={data.forecast} currency={data.client.currency} />
        </>
      );

    case "duplicates":
      return (
        <>
          {/*
            Coverage-first: on this book most contacts carry neither a phone nor
            an email, and the panel says so before it says anything else.
          */}
          <DuplicateLeads
            report={data.duplicates}
            spend={data.current.ads.spend}
            currency={data.client.currency}
            costPerLead={data.current.derived.cpLead}
          />
        </>
      );

    case "funnel":
      return (
        <>
      {/*
        THE FUNNEL, FULL WIDTH, DIRECTLY UNDER THE HEADLINE NUMBERS.

        It used to render sixth — below speed-to-lead, a scrollable lead
        browser and the campaign table — and share a two-column row with the
        trend chart, which capped its stage-label column at 150px.

        It is the one thing here no competitor can build. GoHighLevel exposes
        no stage history, so this app's append-only ledger is the only source
        for "where are we losing people", which is the question the numbers
        above provoke and the question the old spreadsheet could not answer at
        all. Burying it under a lead list inverted the page's priorities.
      */}
      <Funnel
        steps={data.funnel}
        exits={{
          no_show: current.funnel.no_show,
          lost: current.funnel.lost,
        }}
      />
        </>
      );

    case "trend":
      return (
        <>
      {/* Spend vs leads over the selected range — two stacked panels, never a
          dual axis, which would manufacture a correlation between them. */}
      <TrendCharts
        daily={daily}
        prevDaily={data.prevDaily}
        currency={currency}
        spendLabel={spendLabel}
        spendState={adState}
        leadsState={crmState(current.funnel.new_lead === 0)}
        annotations={data.annotations}
        fixedWidth={printWidth}
      />
        </>
      );

    case "campaigns":
      return (
        <>
      {/* Which campaign brought the leads — and, one click away, the
          appointments, shows and closed deals those leads became. */}
      <CampaignStageTable
        data={data.campaignStages}
        currency={currency}
        campaignColors={campaignColors}
        spendLabel={spendLabel}
        lagUnmeasurable={data.lagUnmeasurable}
        emptyState={adState}
      />
        </>
      );

    case "keep_kill":
      // Agency-facing; already absent from a client's registry.
      if (!staff) return null;
      return (
        <>
      <KeepKill report={data.keepKill} currency={currency} />
        </>
      );

    case "creatives":
      /*
       * Meta only. Creative identity is `image_hash` / `video_id`, which Google
       * has no equivalent for in our schema — rendering an empty grid on the
       * Google tab would read as "no creatives ran" rather than "this platform
       * is not reported at asset level here".
       */
      if (platform !== "meta") return null;
      return (
        <>
      {/* Which ASSET is working — one card per image or video, not per ad id */}
      <CreativeGrid
        creatives={data.creatives}
        reconciliation={data.creativeLeads}
        revenueCoverage={data.revenueCoverage}
        currency={currency}
        /*
         * A failed creative query outranks a degraded ad pipe as the thing to
         * report: if we could not read the data at all, saying "no ads ran" or
         * "spend is stale" would both be claims we cannot support.
         */
        emptyState={
          data.creativesError
            ? {
                title: "Creative data could not be read",
                detail:
                  "The rest of this page is unaffected. This usually means the database schema is behind the deployed code.",
                diagnostic: data.creativesError,
                tone: "critical" as const,
              }
            : adState
        }
        adLevelSynced={data.adLevelSynced}
      />
        </>
      );

    case "creative_fatigue":
      /*
       * Meta only, for the same reason as the grid above: the engine is keyed
       * on `image_hash` / `video_id`, which our Google schema has no
       * counterpart for. Rendering it on the Google tab would say "no creative
       * has tired", which is a claim about ads nobody measured.
       */
      if (platform !== "meta") return null;
      return (
        <>
      {/* Which asset has stopped working, judged against its own past */}
      <CreativeFatiguePanel
        report={data.fatigue}
        currency={currency}
        /*
         * A failed creative query means the engine saw no rows at all, which
         * would otherwise render as the reassuring "nothing has tired". Folded
         * into the not-synced state, whose copy is explicitly about the sync
         * rather than about the ads.
         */
        adLevelSynced={data.adLevelSynced && !data.creativesError}
      />
        </>
      );

    case "breakdowns":
      // Meta only — `fb_breakdown_metrics` is populated from Meta's insights
      // breakdowns, which Google Ads has no counterpart to in our schema.
      if (platform !== "meta") return null;
      return (
        <>
      {/* Where the money went — by region, placement, device, age, gender */}
      <Breakdowns
        data={data.breakdowns}
        currency={currency}
        emptyState={data.creativesError ? null : adState}
      />
        </>
      );

    case "speed_to_lead":
      return (
        <>
      {/* Operational detail below the decision-level view: how fast we
          responded, where leads sit right now, and when they arrive. */}
      <SpeedToLeadWidget
        data={data.speedToLead}
        timezone={data.client.timezone}
      />
        </>
      );

    case "speed_outcome":
      return (
        <>
      {/* …and whether answering faster actually changed the outcome. */}
      <SpeedOutcomePanel data={data.speedOutcome} />
        </>
      );

    case "call_timing":
      return (
        <>
      {/* …and when picking up the phone is worth anything at all. */}
      <CallTimingPanel report={data.callTiming} />
        </>
      );

    case "lead_quality":
      return (
        <>
      {/* Where the good leads come from — the source, not the queue. */}
      <LeadQualityPanel report={data.quality} />
        </>
      );

    case "aging":
      return (
        <>
          <CadenceBadge id="aging" />
      {/* Who to call this afternoon — open leads that stopped moving. */}
      <StageAgingPanel data={data.aging} campaignNames={campaignNames} />
        </>
      );

    case "uncalled":
      return (
        <>
          <CadenceBadge id="uncalled" />
          {/* Names and phone numbers — the only actionable list on the page. */}
          <CallListPanel
            data={data.uncalled}
            currency={currency}
            campaignNames={campaignNames}
          />
        </>
      );

    case "maturation":
      return (
        <>
          <CadenceBadge id="maturation" />
      {/* …and whether the month-on-month row below is comparing like with like. */}
      <MaturationPanel data={data.maturation} />
        </>
      );

    case "channels":
      return (
        <>
          <CadenceBadge id="channels" />
      {/* Is the advertising adding anything the pipeline would not have had? */}
      <ChannelMixPanel
        data={data.channels}
        currency={currency}
        splitDefinable={data.channelSplitDefinable}
        filterMode={data.leadFilter.mode}
      />
        </>
      );

    case "pipeline":
      return (
        <>
          <CadenceBadge id="pipeline" />
      {/* Where leads are now — filter by campaign, click a stage to see who */}
      <PipelineExplorer
        leads={data.leads}
        distribution={data.pipelineDistribution}
        currency={currency}
        timezone={data.client.timezone}
        campaignColors={campaignColors}
        campaignNames={campaignNames}
      />
        </>
      );

    case "heatmap":
      return (
        <>
      {/* When leads arrive — weekday × hour */}
      <LeadHeatmap
        data={data.heatmap}
        emptyState={crmState(data.heatmap.total === 0)}
      />
        </>
      );

    case "report_tables":
      return (
        <>
          <CadenceBadge id="report_tables" />
      {/*
        The four report views from the source sheet.
        Streamed rather than blocking: they are ~20 window queries, which
        measured as the dominant cost of the page (~2.1s median / ~4.5s p95).
        Everything above renders first; these arrive behind it. Safe to defer
        because they are all FIXED trailing windows that ignore the date
        picker, so a late arrival can never contradict the selected range.
      */}
      <Suspense fallback={<ReportTablesSkeleton />}>
        <ReportTables client={client} platform={platform} currency={currency} />
      </Suspense>
        </>
      );
  }
}

/** Strip a PeriodMetrics down to what MetricsTable needs. */
function pick(m: PeriodMetrics) {
  return { funnel: m.funnel, ads: m.ads, derived: m.derived };
}

export const CAMPAIGN_DOTS = [
  "var(--series-1)",
  "var(--series-2)",
  "var(--series-3)",
  "var(--series-4)",
  "var(--series-5)",
  "var(--series-7)",
];


/**
 * The most consequential warning in the app.
 *
 * Until the webhook fires, no funnel history is being recorded — and GHL has no
 * stage-history API, so that data cannot be recovered later by any means.
 */
export function NoWebhookBanner({ slug }: { slug: string }) {
  return (
    <div
      className="flex flex-wrap items-center gap-3 rounded-[10px] border p-4"
      style={{
        borderColor: "var(--status-critical)",
        background: "color-mix(in srgb, var(--status-critical) 8%, transparent)",
      }}
    >
      <span
        aria-hidden="true"
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white"
        style={{ background: "var(--status-critical)" }}
      >
        ✕
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold" style={{ color: "var(--text-primary)" }}>
          No GHL webhook events received yet — funnel history is not being recorded
        </p>
        <p className="mt-0.5 text-xs" style={{ color: "var(--text-secondary)" }}>
          GoHighLevel has no stage-history API. Every day this stays unconnected
          is a day of pipeline history that cannot be recovered later.
        </p>
      </div>
      <Link
        href={`/c/${slug}/setup`}
        className="shrink-0 rounded-[8px] px-3 py-2 text-[13px] font-medium text-white"
        style={{ background: "var(--status-critical)" }}
      >
        Finish setup
      </Link>
    </div>
  );
}

export function AttributionBanner({
  slug,
  platform,
}: {
  slug: string;
  platform: AdPlatform;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-3 rounded-[10px] border p-4"
      style={{
        borderColor: "var(--status-warning)",
        background: "color-mix(in srgb, var(--status-warning) 10%, transparent)",
      }}
    >
      <span
        aria-hidden="true"
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold"
        style={{ background: "var(--status-warning)", color: "#0b0b0b" }}
      >
        !
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold" style={{ color: "var(--text-primary)" }}>
          Spend recorded, but no leads qualified as paid
        </p>
        <p className="mt-0.5 text-xs" style={{ color: "var(--text-secondary)" }}>
          {platform === "google"
            ? "Cost metrics will show a dash. Either the gclid isn't being captured in the ad URLs, or these clicks aren't reaching the CRM as leads."
            : "Cost metrics will show a dash. Either URL parameters are missing from the ads, or the Facebook lead tag is not being applied."}
        </p>
      </div>
      <Link
        href={`/c/${slug}/setup`}
        className="shrink-0 rounded-[8px] border px-3 py-2 text-[13px] font-medium"
        style={{
          borderColor: "var(--border-strong)",
          color: "var(--text-secondary)",
        }}
      >
        Check settings
      </Link>
    </div>
  );
}

/**
 * Always states which leads these numbers describe.
 *
 * Without this the filter is invisible: a viewer sees "12 leads" with no way to
 * know whether that is the whole pipeline or only the Facebook-sourced share.
 * Showing the excluded count makes the difference explicit rather than a thing
 * you have to remember.
 */
function LeadFilterNote({
  filter,
  slug,
  platform,
  staff,
}: {
  filter: {
    mode: "all" | "attributed" | "tagged" | "either";
    tag: string;
    total: number;
    paid: number;
  };
  slug: string;
  platform: AdPlatform;
  staff: boolean;
}) {
  const excluded = filter.total - filter.paid;

  // Google leads are matched by their own attribution (a Google click id or
  // campaign id) and ignore the Meta mode/tag entirely, so describe that rather
  // than the Facebook filter the numbers were NOT computed from.
  const description =
    platform === "google"
      ? "Counting leads with a Google click ID (gclid) or Google campaign ID"
      : filter.mode === "all"
        ? "Counting every lead in the pipeline — cost metrics include organic and referral leads"
        : filter.mode === "attributed"
          ? "Counting only leads with a Facebook campaign ID"
          : filter.mode === "tagged"
            ? `Counting only leads tagged "${filter.tag}"`
            : `Counting leads with a Facebook campaign ID or tagged "${filter.tag}"`;

  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[8px] border px-3 py-2 text-xs"
      style={{ borderColor: "var(--border)", background: "var(--surface-2)" }}
    >
      <span style={{ color: "var(--text-secondary)" }}>{description}</span>
      {/* Google always filters by its own attribution (there is no "all" mode
          for it), so the excluded count is meaningful regardless of the Meta
          `filter.mode` — only suppress it on the Meta tab's "count everything". */}
      {excluded > 0 && (platform === "google" || filter.mode !== "all") && (
        <span className="tnum" style={{ color: "var(--text-muted)" }}>
          · {excluded} non-paid lead{excluded === 1 ? "" : "s"} excluded
        </span>
      )}
      {staff && (
        <Link
          href={`/c/${slug}/setup`}
          className="ml-auto hover:underline"
          style={{ color: "var(--text-muted)" }}
        >
          Change
        </Link>
      )}
    </div>
  );
}

/**
 * The four report tables, resolved after the page shell has already painted.
 *
 * Its own async server component so `loadDeferredTables` sits behind a Suspense
 * boundary instead of inside the page's blocking `await`.
 */
async function ReportTables({
  client,
  platform,
  currency,
}: {
  client: Client;
  platform: AdPlatform;
  currency: string;
}) {
  const t = await loadDeferredTables(client, platform);

  return (
    <>
      <MetricsTable
        title="90-day moving averages"
        subtitle="Trailing windows ending yesterday — today is excluded because it is partial"
        firstColumnLabel="Window"
        rows={t.movingAverages.map((m, i) => ({
          label: `${MOVING_AVERAGE_DAYS[i]} Days`,
          funnel: m.funnel,
          ads: m.ads,
          derived: m.derived,
        }))}
        currency={currency}
      />

      <MetricsTable
        title="7-day change"
        subtitle="Last 7 days against the 7 before"
        firstColumnLabel="Period"
        rows={[
          {
            label: "Last 7 days",
            ...pick(t.sevenDayChange.current),
            emphasis: true,
          },
          { label: "Previous period", ...pick(t.sevenDayChange.previous) },
          {
            // The row the table was named for. `showChanges` makes any row
            // carrying `changes` render deltas in place of values, so this is a
            // third row rather than an annotation on the first — otherwise the
            // actual figures would be replaced by their own percentages.
            label: "Change",
            ...pick(t.sevenDayChange.current),
            changes: changesBetween(
              pick(t.sevenDayChange.current),
              pick(t.sevenDayChange.previous),
            ),
          },
        ]}
        showChanges
        currency={currency}
      />

      <MetricsTable
        title="14-day daily report"
        subtitle="One row per day, most recent first"
        firstColumnLabel="Date"
        rows={t.fourteenDayDaily.map((d) => ({
          label: d.label,
          funnel: d.funnel,
          ads: d.ads,
          derived: d.derived,
        }))}
        currency={currency}
        defaultOpen={false}
      />

      <MetricsTable
        title="Month on month"
        subtitle="Trailing 12 calendar months in the client's timezone"
        firstColumnLabel="Month"
        rows={t.monthOnMonth.map((m) => ({
          label: m.label,
          funnel: m.funnel,
          ads: m.ads,
          derived: m.derived,
        }))}
        currency={currency}
        defaultOpen={false}
      />
    </>
  );
}

/** Placeholder matching the four collapsed table headers, so nothing jumps. */
function ReportTablesSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true">
      <span className="sr-only">Loading report tables…</span>
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="card p-5">
          <div className="skeleton h-4 w-48" />
          <div className="skeleton mt-2 h-3 w-72" />
        </div>
      ))}
    </div>
  );
}
