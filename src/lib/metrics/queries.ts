import { and, eq, gte, lte, sql, inArray, type SQL } from "drizzle-orm";
import type { AdPlatform } from "@/lib/platforms";
import { db } from "@/db";
import {
  fbBreakdownMetrics,
  fbDailyMetrics,
  fbPeriodReach,
  googleAdAccounts,
  googleDailyMetrics,
  tiktokDailyMetrics,
} from "@/db/schema";
import type {
  BreakdownKey,
  CanonicalStage,
  CreativeType,
  DeliveryRanking,
} from "@/db/schema";
import {
  CONNECTED_SECONDS,
  type HourInput as CallTimingInput,
} from "./calltime";
import {
  EMPTY_ADS,
  EMPTY_FUNNEL,
  EMPTY_REVENUE,
  costPer,
  derive,
  type AdTotals,
  type DerivedMetrics,
  type FunnelCounts,
  type RevenueTotals,
} from "./compute";
import { orderSegments } from "./breakdown-order";
import { benchmarkSegment, type SegmentBenchmark } from "./benchmark";
import type { CreativeTotals } from "./creative";
import type { CreativeDay, FatigueInput } from "./fatigue";
import type { SpeedOutcomeLead } from "./speed-outcome";
import type { QualityLead } from "./quality";
import type { LeadSourceInput } from "./lead-sources";
import type { DwellObservation, SittingOpportunity } from "./aging";
import type { CallWeekday, UncalledLead } from "./uncalled";
import type { MonthChannel } from "./channels";

/** `MonthChannel` without the label, which the loader supplies. */
type ChannelMonthRow = Omit<MonthChannel, "label">;
import {
  deriveSpendAnnotations,
  SPEND_BASELINE_DAYS,
  type TrendAnnotation,
} from "./annotations";
import { toDateKey, type DateWindow } from "@/lib/dates";

export interface PeriodMetrics {
  label: string;
  window: DateWindow;
  funnel: FunnelCounts;
  ads: AdTotals;
  /**
   * `null` when revenue was not queried for this period.
   *
   * Opt-in rather than always-on: `getRevenue` is a second round trip, and
   * `loadDashboard` builds ~22 period rows (6 moving averages, 12 months, a
   * 7-day pair, current + previous) against a page already issuing ~60 queries.
   * Only the periods that actually display revenue pay for it.
   *
   * The type is nullable rather than defaulting to zeroes precisely so a future
   * revenue column added to `MetricsTable` renders a dash instead of a
   * confident $0.00 for rows nobody ever fetched.
   */
  revenue: RevenueTotals | null;
  derived: DerivedMetrics;
}

/**
 * How a client identifies paid leads. Mirrors `clients.paidLeadFilter`.
 */
export interface PaidLeadFilter {
  mode: "all" | "attributed" | "tagged" | "either";
  tag: string;
}

export const DEFAULT_LEAD_FILTER: PaidLeadFilter = {
  mode: "either",
  tag: "facebook-lead",
};

/**
 * SQL predicate restricting a query to paid leads.
 *
 * This is what keeps cost-per-lead honest. A GHL pipeline receives leads from
 * everywhere — organic, referral, walk-in — but only Facebook spend sits in the
 * numerator. Dividing by every lead understates true paid CPL by exactly the
 * non-paid share, which is how a campaign can look twice as efficient as it is.
 *
 * Two independent signals, because each alone has a blind spot:
 *   - `meta_campaign_id` from UTMs — absent on native Instant Form leads, which
 *     carry no UTMs regardless of how the ads are set up.
 *   - a GHL tag — covers the above, but depends on someone or some automation
 *     actually applying it.
 *
 * Returns `null` when no filtering applies, so callers can skip the join.
 */
export function paidLeadPredicate(filter: PaidLeadFilter): SQL | null {
  const tag = filter.tag.trim().toLowerCase();

  switch (filter.mode) {
    case "all":
      return null;
    case "attributed":
      return sql`c.meta_campaign_id IS NOT NULL`;
    case "tagged":
      return sql`c.tags @> ARRAY[${tag}]::text[]`;
    case "either":
      return sql`(c.meta_campaign_id IS NOT NULL OR c.tags @> ARRAY[${tag}]::text[])`;
  }
}

/**
 * Which ad platform a dashboard view is scoped to.
 *
 * Defined in `@/lib/platforms` alongside the parser that produces it, so the
 * list of platforms and the code that validates a `?platform=` parameter cannot
 * drift apart. Re-exported here because most callers reach for it next to the
 * query functions that take it.
 */
export type { AdPlatform } from "@/lib/platforms";

/**
 * Platform-scoped "which leads count" predicate.
 *
 * The two dashboards must never borrow each other's leads, or a Google
 * cost-per-lead would be Google spend divided by Facebook leads. Meta uses the
 * client's configured paid-lead filter (meta_campaign_id / tag). Google leads
 * are identified by their own attribution — a `gclid` or a Google campaign id
 * captured from the ad URL.
 */
export function platformLeadPredicate(
  platform: AdPlatform,
  filter: PaidLeadFilter,
): SQL | null {
  if (platform === "google") {
    return sql`(c.google_campaign_id IS NOT NULL OR c.gclid IS NOT NULL)`;
  }
  if (platform === "tiktok") {
    /*
     * 🔴 No tag fallback, matching Google and unlike Meta.
     *
     * `paidLeadFilter` on the client is a META concept — it exists because
     * Meta's native Instant Forms arrive with no UTMs at all, so a tag is the
     * only way to identify them. A TikTok lead reaches GHL through a landing
     * page with `ttclid` on it; a lead carrying the client's Facebook tag is
     * not a TikTok lead, and honouring the tag here would count Meta's leads
     * against TikTok's spend on the TikTok view.
     */
    return sql`(c.tiktok_campaign_id IS NOT NULL OR c.ttclid IS NOT NULL)`;
  }
  return paidLeadPredicate(filter);
}

/**
 * The metrics table for a platform whose reporting is a simple daily roll-up.
 *
 * Google and TikTok share a shape — spend, impressions, clicks, conversions,
 * campaign name, one row per campaign per day — and Meta's does not: it carries
 * a link-click/all-click split, Meta-reported leads, video quartiles, delivery
 * rankings, and a separate period table for `reach`, which is non-additive and
 * cannot be summed from daily rows.
 *
 * So the branch is "simple roll-up or Meta", not a three-way switch. Returning
 * null for Meta rather than adding a third case keeps the asymmetry visible:
 * anything reading this has to handle Meta's richer shape explicitly, instead
 * of a `default:` quietly treating it as if it were the same.
 */
function simpleAdTable(platform: AdPlatform) {
  if (platform === "google") {
    return {
      table: googleDailyMetrics,
      campaignId: googleDailyMetrics.googleCampaignId,
      sqlName: "google_daily_metrics",
    } as const;
  }
  if (platform === "tiktok") {
    return {
      table: tiktokDailyMetrics,
      campaignId: tiktokDailyMetrics.tiktokCampaignId,
      sqlName: "tiktok_daily_metrics",
    } as const;
  }
  return null;
}

/**
 * Spend per calendar month for one client and platform, in one query.
 *
 * The month key comes from the `date` column itself, never from a timestamp:
 * every row in these tables was already bucketed in the ad account's own
 * timezone by the sync, so the calendar month that day belongs to is settled.
 * Re-deriving it with `AT TIME ZONE` would apply a zone a second time and move
 * spend across month boundaries — the double-conversion `shiftDateKey` exists
 * to avoid.
 *
 * 🔴 `to_char`, not `substring`. `date` is a real `date` column and Postgres
 * does not implicitly cast one to text, so `substring(date, 1, 7)` is not a
 * subtly wrong answer — it is a hard error on every call. This function shipped
 * with exactly that and nothing caught it: it typechecked, it built, the suite
 * was green, and `loadBudgetHistory` swallows the throw into an empty history,
 * so the panel rendered nothing and explained nothing. See
 * `monthly-spend.test.ts`, which exists to execute this rather than reason
 * about it.
 *
 * One query rather than twelve `getAdTotals` calls, because this feeds a
 * trailing-12-month panel on a page already issuing dozens.
 */
export async function getMonthlySpend(
  clientId: string,
  platform: AdPlatform,
  startKey: string,
  endKey: string,
): Promise<Map<string, number>> {
  const simple = simpleAdTable(platform);

  const rows = simple
    ? await db.execute<{ month: string; spend: number }>(sql`
        SELECT to_char(date, 'YYYY-MM') AS month,
               COALESCE(SUM(spend), 0)::float AS spend
        FROM ${sql.raw(simple.sqlName)}
        WHERE client_id = ${clientId}
          AND date >= ${startKey} AND date <= ${endKey}
        GROUP BY 1
      `)
    : await db.execute<{ month: string; spend: number }>(sql`
        SELECT to_char(date, 'YYYY-MM') AS month,
               COALESCE(SUM(spend), 0)::float AS spend
        FROM fb_daily_metrics
        WHERE client_id = ${clientId}
          AND level = 'campaign'
          AND date >= ${startKey} AND date <= ${endKey}
        GROUP BY 1
      `);

  const out = new Map<string, number>();
  for (const r of rows.rows ?? []) out.set(r.month, Number(r.spend) || 0);
  return out;
}

/** The contacts column carrying each platform's campaign id. */
function campaignIdColumn(platform: AdPlatform): SQL {
  if (platform === "google") return sql`c.google_campaign_id`;
  if (platform === "tiktok") return sql`c.tiktok_campaign_id`;
  return sql`c.meta_campaign_id`;
}

/**
 * Funnel counts for a window, from the append-only ledger.
 *
 * COUNT(DISTINCT opportunity_id), not COUNT(*), and this distinction is
 * load-bearing. A lead bounced Contacted → Booked → Contacted → Booked would
 * otherwise count as two appointments, halving the reported cost per
 * appointment and making the campaign look twice as efficient as it is.
 *
 * Semantics: "entered this stage during the window", i.e. flow not stock. That
 * matches how the source sheet's APPTS/SHOWN/WON columns were meant to read.
 *
 * The paid-lead filter is applied to EVERY stage, not just the lead stage —
 * cost-per-appointment must divide Facebook spend by Facebook appointments, or
 * the ratio is comparing two different populations.
 *
 * Note this uses an INNER join once filtering is active, so transitions with no
 * linked contact (backfill snapshots) are correctly excluded from paid counts.
 */
export async function getFunnelCounts(
  clientId: string,
  window: DateWindow,
  campaignIds?: string[],
  filter: PaidLeadFilter = DEFAULT_LEAD_FILTER,
  platform: AdPlatform = "meta",
): Promise<FunnelCounts> {
  const paid = platformLeadPredicate(platform, filter);
  const needsJoin = paid !== null || Boolean(campaignIds?.length);

  const clauses: SQL[] = [
    sql`st.client_id = ${clientId}`,
    sql`st.changed_at >= ${window.startUtc}`,
    sql`st.changed_at < ${window.endUtc}`,
    sql`st.to_canonical IS NOT NULL`,
  ];
  if (paid) clauses.push(paid);
  if (campaignIds?.length) {
    clauses.push(sql`${campaignIdColumn(platform)} = ANY(${campaignIds})`);
  }

  const rows = await db.execute<{ stage: string; count: number }>(sql`
    SELECT st.to_canonical AS stage,
           COUNT(DISTINCT st.opportunity_id)::int AS count
    FROM stage_transitions st
    ${needsJoin ? sql`JOIN contacts c ON c.id = st.contact_id` : sql``}
    WHERE ${sql.join(clauses, sql` AND `)}
    GROUP BY st.to_canonical
  `);

  const out: FunnelCounts = { ...EMPTY_FUNNEL };
  for (const r of resultRows<{ stage: string; count: number }>(rows)) {
    if (r.stage) out[r.stage as keyof FunnelCounts] = Number(r.count) || 0;
  }

  /*
   * Leads that were real prospects.
   *
   * A second query rather than `new_lead - disqualified`, and the distinction
   * matters: those two counts describe different populations. A lead that
   * arrived in June and was marked junk in August would subtract from AUGUST's
   * leads without ever having been counted in them — and on a quiet month that
   * drives the figure negative, producing a nonsense cost per lead.
   *
   * "Entered new_lead in the window, and has NO disqualification transition,
   * ever" is always a subset of `new_lead` by construction, so qualified cost
   * per lead can only ever be higher than raw cost per lead — which is what a
   * reader expects when they see two numbers side by side.
   *
   * Skipped when nothing was disqualified, which is every client not using the
   * stage — no reason to pay for a second round trip to learn nothing.
   */
  out.new_lead_qualified =
    out.disqualified > 0
      ? await countQualifiedLeads(clauses, needsJoin)
      : out.new_lead;

  return out;
}

/**
 * Distinct opportunities entering `new_lead` in the window, never disqualified.
 *
 * Takes the caller's already-built clauses so the client, window, paid-lead
 * filter and campaign scope are byte-identical to the main funnel query. Rebuilt
 * separately they could drift, and a qualified count filtered differently from
 * the raw count would produce a ratio between two different populations.
 */
async function countQualifiedLeads(
  clauses: SQL[],
  needsJoin: boolean,
): Promise<number> {
  const rows = await db.execute<{ count: number }>(sql`
    SELECT COUNT(DISTINCT st.opportunity_id)::int AS count
    FROM stage_transitions st
    ${needsJoin ? sql`JOIN contacts c ON c.id = st.contact_id` : sql``}
    WHERE ${sql.join(clauses, sql` AND `)}
      AND st.to_canonical = 'new_lead'
      AND NOT EXISTS (
        SELECT 1 FROM stage_transitions d
         WHERE d.opportunity_id = st.opportunity_id
           AND d.to_canonical = 'disqualified'
      )
  `);
  return Number(resultRows<{ count: number }>(rows)[0]?.count) || 0;
}

/** Both drivers return `.rows`; this keeps the cast in one place. */
function resultRows<T>(result: unknown): T[] {
  return ((result as { rows?: T[] })?.rows ?? []) as T[];
}

/**
 * Closed-won value for a window.
 *
 * Deliberately mirrors `getFunnelCounts` exactly — same window semantics
 * ("entered closed_won during the window"), same DISTINCT-opportunity rule,
 * same paid-lead and campaign filters. `wonOpps` here must equal
 * `funnel.closed_won` from the same call; if it ever doesn't, one of the two is
 * wrong and the difference is the bug.
 *
 * DISTINCT over (id, monetary_value) is DISTINCT over id — `opportunities.id`
 * is the primary key, so the value cannot vary within a row.
 */
export async function getRevenue(
  clientId: string,
  window: DateWindow,
  campaignIds?: string[],
  filter: PaidLeadFilter = DEFAULT_LEAD_FILTER,
  platform: AdPlatform = "meta",
): Promise<RevenueTotals> {
  const paid = platformLeadPredicate(platform, filter);
  const needsJoin = paid !== null || Boolean(campaignIds?.length);

  const clauses: SQL[] = [
    sql`st.client_id = ${clientId}`,
    sql`st.changed_at >= ${window.startUtc}`,
    sql`st.changed_at < ${window.endUtc}`,
    sql`st.to_canonical = 'closed_won'`,
  ];
  if (paid) clauses.push(paid);
  if (campaignIds?.length) {
    clauses.push(sql`${campaignIdColumn(platform)} = ANY(${campaignIds})`);
  }

  const rows = await db.execute<{
    won_opps: number;
    won_with_value: number;
    revenue: number;
  }>(sql`
    WITH won AS (
      SELECT DISTINCT o.id, o.monetary_value
      FROM stage_transitions st
      JOIN opportunities o ON o.id = st.opportunity_id
      ${needsJoin ? sql`JOIN contacts c ON c.id = st.contact_id` : sql``}
      WHERE ${sql.join(clauses, sql` AND `)}
    )
    SELECT COUNT(*)::int AS won_opps,
           COUNT(*) FILTER (WHERE monetary_value > 0)::int AS won_with_value,
           COALESCE(SUM(monetary_value), 0)::float AS revenue
    FROM won
  `);

  const r = resultRows<{
    won_opps: number;
    won_with_value: number;
    revenue: number;
  }>(rows)[0];
  if (!r) return { ...EMPTY_REVENUE };
  return {
    wonOpps: Number(r.won_opps) || 0,
    wonWithValue: Number(r.won_with_value) || 0,
    revenue: Number(r.revenue) || 0,
  };
}

/**
 * How much of a window is still subject to Meta restating it.
 *
 * `fb_daily_metrics.is_provisional` has been written on every ingest since the
 * beginning and read by NOTHING. The only surfacing was a footer sentence that
 * appeared on every Meta view unconditionally — including ranges made entirely
 * of settled data — which is the fastest way to train a reader to ignore a
 * caveat. A disclaimer that always fires carries no information.
 *
 * With this, the note appears only when the range genuinely contains provisional
 * rows, and can name the date from which figures may still move.
 *
 * Meta-only: Google has no equivalent restatement flag in our schema.
 */
export interface ProvisionalCoverage {
  totalRows: number;
  provisionalRows: number;
  /** Earliest still-provisional date in the window (YYYY-MM-DD), or null. */
  since: string | null;
}

export async function getProvisionalCoverage(
  clientId: string,
  window: DateWindow,
  platform: AdPlatform = "meta",
): Promise<ProvisionalCoverage> {
  if (platform !== "meta") {
    return { totalRows: 0, provisionalRows: 0, since: null };
  }

  const rows = await db
    .select({
      total: sql<number>`COUNT(*)::int`,
      provisional: sql<number>`COUNT(*) FILTER (WHERE ${fbDailyMetrics.isProvisional})::int`,
      since: sql<
        string | null
      >`MIN(${fbDailyMetrics.date}) FILTER (WHERE ${fbDailyMetrics.isProvisional})`,
    })
    .from(fbDailyMetrics)
    .where(
      and(
        eq(fbDailyMetrics.clientId, clientId),
        gte(fbDailyMetrics.date, window.startKey),
        lte(fbDailyMetrics.date, window.endKey),
      ),
    );

  const r = rows[0];
  return {
    totalRows: Number(r?.total ?? 0),
    provisionalRows: Number(r?.provisional ?? 0),
    since: r?.since ?? null,
  };
}

/**
 * Which days in a window we actually hold an ad-platform row for.
 *
 * 🔴 The distinction `getDailySeries` deliberately erases. It emits a zero for
 * every day it has no data on — correct for a chart, where a gap reads as
 * broken rendering — but downstream that zero is indistinguishable from a day
 * that genuinely cost nothing.
 *
 * That matters because Meta's insights endpoint returns NO ROWS for a paused
 * day and NO ROWS for a day nobody synced. Anomaly detection reading zeroes
 * would turn one failed nightly job into a confident "spend collapsed" alert,
 * which is the same class of mistake as the spreadsheet reporting 25 leads
 * against $0.00 of spend.
 *
 * One indexed group-by. Cheap enough to be worth the certainty.
 */
export async function getAdDataDays(
  clientId: string,
  window: DateWindow,
  platform: AdPlatform = "meta",
): Promise<Set<string>> {
  const table = simpleAdTable(platform)?.table ?? fbDailyMetrics;
  const rows = await db
    .selectDistinct({ date: table.date })
    .from(table)
    .where(
      and(
        eq(table.clientId, clientId),
        gte(table.date, window.startKey),
        lte(table.date, window.endKey),
      ),
    );
  return new Set(rows.map((r) => String(r.date)));
}

/**
 * Ad totals for a window.
 *
 * Reach is deliberately NOT selected here — summing daily reach would
 * overstate it 2–5x because it counts distinct people per query window. Use
 * `getPeriodReach` for that.
 */
export async function getAdTotals(
  clientId: string,
  window: DateWindow,
  campaignIds?: string[],
  platform: AdPlatform = "meta",
): Promise<AdTotals> {
  // Google is a separate dashboard, not a blended total — its spend, clicks and
  // impressions belong only to the Google view. Google has no link-click vs
  // all-click split, so its clicks feed both so CTR/CPC stay coherent.
  const simple = simpleAdTable(platform);
  if (simple) {
    const g = await getSimpleTotals(clientId, window, platform);
    return {
      spend: g.spend,
      impressions: g.impressions,
      clicksAll: g.clicks,
      /*
       * Neither Google nor TikTok reports a link-click separate from a click,
       * so the one number feeds both fields and CTR/CPC stay coherent rather
       * than one of them reading zero.
       */
      linkClicks: g.clicks,
      fbLeads: 0,
      // No period-reach table for either — see `simpleAdTable`.
      reach: null,
    };
  }

  const conditions = [
    eq(fbDailyMetrics.clientId, clientId),
    gte(fbDailyMetrics.date, window.startKey),
    lte(fbDailyMetrics.date, window.endKey),
    eq(fbDailyMetrics.level, "campaign"),
  ];
  if (campaignIds?.length) {
    conditions.push(inArray(fbDailyMetrics.metaCampaignId, campaignIds));
  }

  const [row] = await db
    .select({
      spend: sql<string>`COALESCE(SUM(${fbDailyMetrics.spend}), 0)`,
      impressions: sql<string>`COALESCE(SUM(${fbDailyMetrics.impressions}), 0)`,
      clicksAll: sql<string>`COALESCE(SUM(${fbDailyMetrics.clicksAll}), 0)`,
      linkClicks: sql<string>`COALESCE(SUM(${fbDailyMetrics.linkClicks}), 0)`,
      fbLeads: sql<string>`COALESCE(SUM(${fbDailyMetrics.leadsTotal}), 0)`,
    })
    .from(fbDailyMetrics)
    .where(and(...conditions));

  return {
    spend: Number(row?.spend) || 0,
    impressions: Number(row?.impressions) || 0,
    clicksAll: Number(row?.clicksAll) || 0,
    linkClicks: Number(row?.linkClicks) || 0,
    fbLeads: Number(row?.fbLeads) || 0,
    reach: null,
  };
}

/** Summed spend/impressions/clicks for a simple-roll-up platform. Zeroes if none. */
async function getSimpleTotals(
  clientId: string,
  window: DateWindow,
  platform: AdPlatform,
): Promise<{ spend: number; impressions: number; clicks: number }> {
  const t = simpleAdTable(platform);
  if (!t) return { spend: 0, impressions: 0, clicks: 0 };
  const { table } = t;
  const [row] = await db
    .select({
      spend: sql<string>`COALESCE(SUM(${table.spend}), 0)`,
      impressions: sql<string>`COALESCE(SUM(${table.impressions}), 0)`,
      clicks: sql<string>`COALESCE(SUM(${table.clicks}), 0)`,
    })
    .from(table)
    .where(
      and(
        eq(table.clientId, clientId),
        gte(table.date, window.startKey),
        lte(table.date, window.endKey),
      ),
    );
  return {
    spend: Number(row?.spend) || 0,
    impressions: Number(row?.impressions) || 0,
    clicks: Number(row?.clicks) || 0,
  };
}

/**
 * Display summary for the Google view: the primary account's currency (so money
 * isn't mislabelled with the Meta account's symbol) and the most recent sync
 * time (for the footer).
 */
export async function getGoogleAccountSummary(
  clientId: string,
): Promise<{ currency: string | null; lastSynced: Date | null }> {
  const rows = await db
    .select({
      currency: googleAdAccounts.currency,
      isPrimary: googleAdAccounts.isPrimary,
      lastSyncedAt: googleAdAccounts.lastSyncedAt,
      status: googleAdAccounts.status,
    })
    .from(googleAdAccounts)
    .where(eq(googleAdAccounts.clientId, clientId));

  const active = rows.filter((r) => r.status !== "removed");
  const primary = active.find((r) => r.isPrimary) ?? active[0];
  let lastSynced: Date | null = null;
  for (const r of active) {
    if (r.lastSyncedAt && (!lastSynced || r.lastSyncedAt > lastSynced)) {
      lastSynced = r.lastSyncedAt;
    }
  }
  return { currency: primary?.currency ?? null, lastSynced };
}

/**
 * Reach for an exact period, from the separately-queried cache.
 *
 * Returns null when we have not queried that precise window — better an honest
 * dash than a number derived the wrong way.
 */
export async function getPeriodReach(
  clientId: string,
  window: DateWindow,
): Promise<number | null> {
  const rows = await db
    .select({ reach: fbPeriodReach.reach })
    .from(fbPeriodReach)
    .where(
      and(
        eq(fbPeriodReach.clientId, clientId),
        eq(fbPeriodReach.periodStart, window.startKey),
        eq(fbPeriodReach.periodEnd, window.endKey),
        // Account-level total only (campaign id ""). Reach is deduplicated people
        // and cannot be summed across campaigns OR across ad accounts.
        eq(fbPeriodReach.metaCampaignId, ""),
      ),
    );
  // 0 rows → we never queried this exact window (honest dash). >1 row → the client
  // runs multiple ad accounts, whose reach cannot be summed into one figure, so we
  // decline rather than report a wrong total.
  if (rows.length !== 1) return null;
  return rows[0].reach !== null ? Number(rows[0].reach) : null;
}

/** Everything needed to render one period row. */
export async function getPeriodMetrics(
  clientId: string,
  window: DateWindow,
  label: string,
  campaignIds?: string[],
  filter: PaidLeadFilter = DEFAULT_LEAD_FILTER,
  platform: AdPlatform = "meta",
  includeRevenue = false,
): Promise<PeriodMetrics> {
  const [funnel, ads, revenue] = await Promise.all([
    getFunnelCounts(clientId, window, campaignIds, filter, platform),
    getAdTotals(clientId, window, campaignIds, platform),
    includeRevenue
      ? getRevenue(clientId, window, campaignIds, filter, platform)
      : Promise.resolve(null),
  ]);
  return {
    label,
    window,
    funnel,
    ads,
    revenue,
    derived: derive(funnel, ads, revenue),
  };
}

/* ------------------------------------------------------------------ *
 * Daily series — powers the 14-day table, sparklines, and trend chart
 * ------------------------------------------------------------------ */

export interface DailyPoint {
  dateKey: string;
  funnel: FunnelCounts;
  ads: AdTotals;
  derived: DerivedMetrics;
}

/**
 * Per-day rows across a window, in one pass.
 *
 * Two grouped queries rather than N per-day queries: at 90 days that is the
 * difference between 2 round trips and 180.
 */
export async function getDailySeries(
  clientId: string,
  window: DateWindow,
  tz: string,
  dateKeys: string[],
  campaignIds?: string[],
  filter: PaidLeadFilter = DEFAULT_LEAD_FILTER,
  platform: AdPlatform = "meta",
): Promise<DailyPoint[]> {
  /*
   * Per-day ad spend for the selected platform only. Each platform is its own
   * dashboard — Google and TikTok spend never blend into the Facebook trend, or
   * into each other. Neither reports a link click separate from a click, so for
   * those two the one number feeds both fields.
   */
  const adsByDate = new Map<string, AdTotals>();
  const loadAds = async () => {
    const simple = simpleAdTable(platform);
    if (simple) {
      const { table } = simple;
      const gRows = await db
        .select({
          dateKey: table.date,
          spend: sql<string>`COALESCE(SUM(${table.spend}), 0)`,
          impressions: sql<string>`COALESCE(SUM(${table.impressions}), 0)`,
          clicks: sql<string>`COALESCE(SUM(${table.clicks}), 0)`,
        })
        .from(table)
        .where(
          and(
            eq(table.clientId, clientId),
            gte(table.date, window.startKey),
            lte(table.date, window.endKey),
          ),
        )
        /*
         * 🔴 `table.date`, NOT `googleDailyMetrics.date`.
         *
         * This function is parameterised by platform and `simpleAdTable` returns
         * whichever table the platform names — but the GROUP BY was left pinned
         * to Google's. Selecting FROM `tiktok_daily_metrics` while grouping by a
         * column of `google_daily_metrics` is not a wrong answer, it is a
         * "missing FROM-clause entry" error, so the whole TikTok dashboard threw
         * the moment the platform became selectable.
         *
         * The second instance of this exact slip in this file; the first was the
         * campaign branch's `groupBy(googleDailyMetrics.googleCampaignId)`.
         * Hardcoding a column inside a function that takes a table as a
         * parameter typechecks perfectly, because both are real columns.
         */
        .groupBy(table.date);
      for (const r of gRows) {
        const clicks = Number(r.clicks) || 0;
        adsByDate.set(String(r.dateKey), {
          spend: Number(r.spend) || 0,
          impressions: Number(r.impressions) || 0,
          clicksAll: clicks,
          linkClicks: clicks,
          fbLeads: 0,
          reach: null,
        });
      }
      return;
    }

    const adConditions = [
      eq(fbDailyMetrics.clientId, clientId),
      gte(fbDailyMetrics.date, window.startKey),
      lte(fbDailyMetrics.date, window.endKey),
      eq(fbDailyMetrics.level, "campaign"),
    ];
    if (campaignIds?.length) {
      adConditions.push(inArray(fbDailyMetrics.metaCampaignId, campaignIds));
    }
    const adRows = await db
      .select({
        dateKey: fbDailyMetrics.date,
        spend: sql<string>`COALESCE(SUM(${fbDailyMetrics.spend}), 0)`,
        impressions: sql<string>`COALESCE(SUM(${fbDailyMetrics.impressions}), 0)`,
        clicksAll: sql<string>`COALESCE(SUM(${fbDailyMetrics.clicksAll}), 0)`,
        linkClicks: sql<string>`COALESCE(SUM(${fbDailyMetrics.linkClicks}), 0)`,
        fbLeads: sql<string>`COALESCE(SUM(${fbDailyMetrics.leadsTotal}), 0)`,
      })
      .from(fbDailyMetrics)
      .where(and(...adConditions))
      .groupBy(fbDailyMetrics.date);
    for (const r of adRows) {
      adsByDate.set(String(r.dateKey), {
        spend: Number(r.spend) || 0,
        impressions: Number(r.impressions) || 0,
        clicksAll: Number(r.clicksAll) || 0,
        linkClicks: Number(r.linkClicks) || 0,
        fbLeads: Number(r.fbLeads) || 0,
        reach: null,
      });
    }
  };

  const [, funnelRows] = await Promise.all([
    loadAds(),

    /*
     * Bucket transitions into the CLIENT's local day. `changed_at` is stored in
     * UTC, so without the AT TIME ZONE conversion a transition at 6pm Pacific
     * would land on the following day and the daily report would be skewed by
     * the UTC offset every single row.
     */
    (async () => {
      const paid = platformLeadPredicate(platform, filter);
      const clauses: SQL[] = [
        sql`st.client_id = ${clientId}`,
        sql`st.changed_at >= ${window.startUtc}`,
        sql`st.changed_at < ${window.endUtc}`,
        sql`st.to_canonical IS NOT NULL`,
      ];
      if (paid) clauses.push(paid);

      const res = await db.execute<{
        dateKey: string;
        stage: string;
        count: number;
      }>(sql`
        SELECT to_char((st.changed_at AT TIME ZONE ${tz})::date, 'YYYY-MM-DD') AS "dateKey",
               st.to_canonical AS stage,
               COUNT(DISTINCT st.opportunity_id)::int AS count
        FROM stage_transitions st
        ${paid ? sql`JOIN contacts c ON c.id = st.contact_id` : sql``}
        WHERE ${sql.join(clauses, sql` AND `)}
        GROUP BY 1, 2
      `);
      return resultRows<{ dateKey: string; stage: string; count: number }>(res);
    })(),
  ]);

  const funnelByDate = new Map<string, FunnelCounts>();
  for (const r of funnelRows) {
    const key = String(r.dateKey);
    const existing = funnelByDate.get(key) ?? { ...EMPTY_FUNNEL };
    if (r.stage) existing[r.stage as keyof FunnelCounts] = Number(r.count) || 0;
    funnelByDate.set(key, existing);
  }

  // Emit a row for EVERY day in the window, including days with no activity —
  // a gap in a chart reads as missing data, a zero reads as a quiet day.
  return dateKeys.map((dateKey) => {
    const ads = adsByDate.get(dateKey) ?? { ...EMPTY_ADS };
    const funnel = funnelByDate.get(dateKey) ?? { ...EMPTY_FUNNEL };
    return { dateKey, funnel, ads, derived: derive(funnel, ads) };
  });
}

export interface CampaignRow {
  campaignId: string;
  campaignName: string | null;
  platform: AdPlatform;
  ads: AdTotals;
}

/** Per-campaign breakdown for a window, for the selected platform only. */
export async function getCampaignBreakdown(
  clientId: string,
  window: DateWindow,
  platform: AdPlatform = "meta",
): Promise<CampaignRow[]> {
  const simple = simpleAdTable(platform);
  if (simple) {
    const { table, campaignId } = simple;
    const gRows = await db
      .select({
        campaignId,
        campaignName: sql<string>`MAX(${table.campaignName})`,
        spend: sql<string>`COALESCE(SUM(${table.spend}), 0)`,
        impressions: sql<string>`COALESCE(SUM(${table.impressions}), 0)`,
        clicks: sql<string>`COALESCE(SUM(${table.clicks}), 0)`,
      })
      .from(table)
      .where(
        and(
          eq(table.clientId, clientId),
          gte(table.date, window.startKey),
          lte(table.date, window.endKey),
        ),
      )
      /*
       * The selected platform's own campaign column. This read
       * `googleDailyMetrics.googleCampaignId` literally until TikTok was added
       * — which typechecked, because drizzle accepts any column here, and
       * would have grouped by a column belonging to a table that is not in the
       * FROM clause.
       */
      .groupBy(campaignId);

    return gRows.map((r) => {
      const clicks = Number(r.clicks) || 0;
      return {
        campaignId: r.campaignId,
        campaignName: r.campaignName ?? null,
        // Not hardcoded: a TikTok row labelled "google" would colour and filter
        // as Google everywhere downstream.
        platform,
        ads: {
          spend: Number(r.spend) || 0,
          impressions: Number(r.impressions) || 0,
          clicksAll: clicks,
          linkClicks: clicks,
          fbLeads: 0,
          reach: null,
        },
      };
    });
  }

  const metaRows = await db
    .select({
      campaignId: fbDailyMetrics.metaCampaignId,
      campaignName: sql<string>`MAX(${fbDailyMetrics.campaignName})`,
      spend: sql<string>`COALESCE(SUM(${fbDailyMetrics.spend}), 0)`,
      impressions: sql<string>`COALESCE(SUM(${fbDailyMetrics.impressions}), 0)`,
      clicksAll: sql<string>`COALESCE(SUM(${fbDailyMetrics.clicksAll}), 0)`,
      linkClicks: sql<string>`COALESCE(SUM(${fbDailyMetrics.linkClicks}), 0)`,
      fbLeads: sql<string>`COALESCE(SUM(${fbDailyMetrics.leadsTotal}), 0)`,
    })
    .from(fbDailyMetrics)
    .where(
      and(
        eq(fbDailyMetrics.clientId, clientId),
        gte(fbDailyMetrics.date, window.startKey),
        lte(fbDailyMetrics.date, window.endKey),
        eq(fbDailyMetrics.level, "campaign"),
      ),
    )
    .groupBy(fbDailyMetrics.metaCampaignId);

  return metaRows.map((r) => ({
    campaignId: r.campaignId,
    campaignName: r.campaignName ?? null,
    platform: "meta" as const,
    ads: {
      spend: Number(r.spend) || 0,
      impressions: Number(r.impressions) || 0,
      clicksAll: Number(r.clicksAll) || 0,
      linkClicks: Number(r.linkClicks) || 0,
      fbLeads: Number(r.fbLeads) || 0,
      reach: null,
    },
  }));
}

/** Leads per campaign, from CRM attribution — pairs with the spend above. */
export async function getLeadsByCampaign(
  clientId: string,
  window: DateWindow,
  filter: PaidLeadFilter = DEFAULT_LEAD_FILTER,
  platform: AdPlatform = "meta",
): Promise<Map<string, number>> {
  const paid = platformLeadPredicate(platform, filter);
  const col = campaignIdColumn(platform);
  const clauses: SQL[] = [
    sql`st.client_id = ${clientId}`,
    sql`st.to_canonical = 'new_lead'`,
    sql`st.changed_at >= ${window.startUtc}`,
    sql`st.changed_at < ${window.endUtc}`,
  ];
  if (paid) clauses.push(paid);

  const rows = await db.execute<{ campaign_id: string | null; count: number }>(
    sql`
      SELECT ${col} AS campaign_id,
             COUNT(DISTINCT st.opportunity_id)::int AS count
      FROM stage_transitions st
      JOIN contacts c ON c.id = st.contact_id
      WHERE ${sql.join(clauses, sql` AND `)}
      GROUP BY ${col}
    `,
  );

  const out = new Map<string, number>();
  for (const r of resultRows<{ campaign_id: string | null; count: number }>(rows)) {
    /*
     * A paid lead with no campaign id is one identified by TAG rather than
     * UTMs — typically an Instant Form lead. Bucketed as "Unattributed" rather
     * than dropped, so the per-campaign rows still sum to the funnel total.
     */
    out.set(r.campaign_id ?? "", Number(r.count) || 0);
  }
  return out;
}

export const UNATTRIBUTED = "" as const;

/**
 * Every funnel stage, per campaign, in one grouped query.
 *
 * `getFunnelCounts` already accepts `campaignIds`, so this could be N calls —
 * but N campaigns × the query's own two round trips is how a keep/kill panel
 * turns a 60-query page into a 90-query one. One `GROUP BY campaign, stage`
 * returns the same numbers.
 *
 * 🔴 Counts DISTINCT opportunities entering each stage, exactly as
 * `getFunnelCounts` does. Counting raw transitions would let a lead bounced
 * between stages inflate its campaign's numbers, and the keep/kill engine would
 * then reward whichever campaign's leads got shuffled the most.
 */
export async function getFunnelByCampaign(
  clientId: string,
  window: DateWindow,
  filter: PaidLeadFilter = DEFAULT_LEAD_FILTER,
  platform: AdPlatform = "meta",
): Promise<Map<string, Partial<Record<CanonicalStage, number>>>> {
  const paid = platformLeadPredicate(platform, filter);
  const col = campaignIdColumn(platform);
  const clauses: SQL[] = [
    sql`st.client_id = ${clientId}`,
    sql`st.to_canonical IS NOT NULL`,
    sql`st.changed_at >= ${window.startUtc}`,
    sql`st.changed_at < ${window.endUtc}`,
  ];
  if (paid) clauses.push(paid);

  const rows = await db.execute<{
    campaign_id: string | null;
    stage: string;
    count: number;
  }>(sql`
    SELECT ${col} AS campaign_id,
           st.to_canonical AS stage,
           COUNT(DISTINCT st.opportunity_id)::int AS count
    FROM stage_transitions st
    JOIN contacts c ON c.id = st.contact_id
    WHERE ${sql.join(clauses, sql` AND `)}
    GROUP BY ${col}, st.to_canonical
  `);

  const out = new Map<string, Partial<Record<CanonicalStage, number>>>();
  for (const r of resultRows<{
    campaign_id: string | null;
    stage: string;
    count: number;
  }>(rows)) {
    // Same bucketing as `getLeadsByCampaign`: a tag-identified paid lead with no
    // campaign id is "Unattributed", never dropped.
    const key = r.campaign_id ?? UNATTRIBUTED;
    const entry = out.get(key) ?? {};
    entry[r.stage as CanonicalStage] = Number(r.count) || 0;
    out.set(key, entry);
  }
  return out;
}

/**
 * Campaigns holding at least one ad Meta still reports as learning.
 *
 * 🔴 Feeds the one keep/kill guard that is about Meta's mechanics rather than
 * statistics: an ad set that has not exited the learning phase is not yet
 * delivering at its own steady-state performance, so recommending it be
 * switched off is confidently wrong. See `keepkill.ts`.
 *
 * Meta-only — Google has no equivalent state in our schema, so the Google view
 * simply has no ads to exclude.
 */
export async function getLearningCampaigns(
  clientId: string,
  platform: AdPlatform = "meta",
): Promise<Set<string>> {
  if (platform !== "meta") return new Set();
  try {
    const rows = await db.execute<{ campaign_id: string | null }>(sql`
      SELECT DISTINCT meta_campaign_id AS campaign_id
      FROM meta_ad_creatives
      WHERE client_id = ${clientId}
        AND learning_stage IN ('LEARNING', 'LEARNING_LIMITED')
    `);
    return new Set(
      resultRows<{ campaign_id: string | null }>(rows)
        .map((r) => r.campaign_id)
        .filter((id): id is string => Boolean(id)),
    );
  } catch (err) {
    /*
     * Degrades to "nothing is learning", which is the SAFE direction only
     * because the learning check can merely soften a kill into "too early". An
     * empty set here can never turn a keep into a kill.
     */
    console.error("[keepkill] learning state unavailable:", err);
    return new Set();
  }
}

/* ------------------------------------------------------------------ *
 * Speed to lead — how fast the first outbound CALL reaches a new lead
 * ------------------------------------------------------------------ */

/** Whether a lead's first-call time is measurable, and if so how it went. */
export type LeadCallStatus = "called" | "not_called";

export interface SpeedToLeadRow {
  name: string | null;
  /** Lead-in time (ISO). */
  leadInAt: string;
  /** First outbound call time (ISO), or null if never called. */
  firstCallAt: string | null;
  /** Seconds from lead-in to first call, or null if uncalled. */
  secondsToCall: number | null;
  /** Only measurable leads appear as rows, so status is called | not_called. */
  status: LeadCallStatus;
}

export interface SpeedToLead {
  /**
   * When outbound-call tracking first went live for this client (ISO), or null
   * if we have never received a call event. Calls, like stage history, only
   * accumulate FORWARD from this instant — leads that arrived earlier have no
   * knowable first-call time and must not be counted as "not called".
   */
  trackingStartedAt: string | null;
  /** All paid leads that came in during the window. */
  leads: number;
  /** Of those, the ones that arrived after tracking went live — measurable. */
  trackable: number;
  /** Leads that predate tracking — first-call time unknowable, not a miss. */
  preTracking: number;
  /** Trackable leads that received a first outbound call. */
  called: number;
  /** Trackable leads with no call yet — genuine misses. */
  uncalled: number;
  /** Median seconds from lead-in to first call (trackable, called leads only). */
  medianSeconds: number | null;
  /** Cumulative counts: called within 5 min / 1 hr / 24 hr (of trackable leads). */
  within5m: number;
  within1h: number;
  within24h: number;
  /** Per-lead breakdown — trackable leads only (misses first, then slowest), capped at 100. */
  rows: SpeedToLeadRow[];
}

/**
 * Speed to lead = time from a lead arriving to the FIRST outbound call.
 *
 * Anchored on `contacts.first_call_at` (set by an OutboundMessage webhook where
 * messageType = CALL) minus `ghl_created_at` (lead-in). Measured over leads that
 * ARRIVED in the window, so it answers "how fast did we call this period's
 * leads", and surfaces the ones never called at all — the number a manual stage
 * move would hide.
 */
export async function getSpeedToLead(
  clientId: string,
  window: DateWindow,
  filter: PaidLeadFilter = DEFAULT_LEAD_FILTER,
  platform: AdPlatform = "meta",
): Promise<SpeedToLead> {
  const paid = platformLeadPredicate(platform, filter);
  const clauses: SQL[] = [
    sql`c.client_id = ${clientId}`,
    sql`c.ghl_created_at >= ${window.startUtc}`,
    sql`c.ghl_created_at < ${window.endUtc}`,
  ];
  if (paid) clauses.push(paid);

  /*
   * When could we FIRST have observed an outbound call for this client? That is
   * the earliest OutboundMessage webhook we ever received. Before that instant
   * we had no call visibility at all, so a lead that arrived earlier has no
   * knowable first-call time — it is "unknown", never "not called". Anchoring on
   * this cutover is what stops the widget from mislabelling every historical
   * lead as a miss (the source sheet's "SHOWN = 0 forever" failure).
   */
  const tsRes = await db.execute<{ started: string | Date | null }>(sql`
    SELECT MIN(received_at) AS started
    FROM webhook_events
    WHERE client_id = ${clientId} AND event_type = 'OutboundMessage'
  `);
  const startedRaw = resultRows<{ started: string | Date | null }>(tsRes)[0]?.started;
  const trackingStart: Date | null = startedRaw ? new Date(startedRaw) : null;

  // A lead is "trackable" only if it arrived at or after the cutover — for those
  // we were watching from the moment they came in, so a missing call is a real
  // miss rather than an unrecorded one. Null cutover ⇒ nothing is trackable yet.
  const trackable = sql`c.ghl_created_at >= ${trackingStart}::timestamptz`;
  // Guard against clock-skew rows where a call predates the lead.
  const calledSql = sql`${trackable} AND c.first_call_at IS NOT NULL AND c.first_call_at >= c.ghl_created_at`;

  type Row = {
    leads: number;
    trackable: number;
    called: number;
    within_5m: number;
    within_1h: number;
    within_24h: number;
    median_seconds: number | null;
  };
  const rows = await db.execute<Row>(sql`
    SELECT
      COUNT(*)::int AS leads,
      COUNT(*) FILTER (WHERE ${trackable})::int AS trackable,
      COUNT(*) FILTER (WHERE ${calledSql})::int AS called,
      COUNT(*) FILTER (WHERE ${calledSql} AND c.first_call_at <= c.ghl_created_at + interval '5 minutes')::int AS within_5m,
      COUNT(*) FILTER (WHERE ${calledSql} AND c.first_call_at <= c.ghl_created_at + interval '1 hour')::int AS within_1h,
      COUNT(*) FILTER (WHERE ${calledSql} AND c.first_call_at <= c.ghl_created_at + interval '24 hours')::int AS within_24h,
      percentile_cont(0.5) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (c.first_call_at - c.ghl_created_at))
      ) FILTER (WHERE ${calledSql}) AS median_seconds
    FROM contacts c
    WHERE ${sql.join(clauses, sql` AND `)}
  `);
  const r = resultRows<Row>(rows)[0];
  const leads = Number(r?.leads) || 0;
  const trackableN = Number(r?.trackable) || 0;
  const calledN = Number(r?.called) || 0;

  // Per-lead rows are the ACTIONABLE, trustworthy set only: trackable leads.
  // Pre-tracking leads are summarised as a count rather than enumerated, so the
  // list never fills with rows whose call time we simply cannot know.
  type RowR = {
    name: string | null;
    lead_in_at: string | Date;
    first_call_at: string | Date | null;
    seconds_to_call: number | null;
  };
  const perLeadRes = await db.execute<RowR>(sql`
    SELECT
      COALESCE(NULLIF(TRIM(CONCAT(c.first_name, ' ', c.last_name)), ''), c.email, c.phone) AS name,
      c.ghl_created_at AS lead_in_at,
      c.first_call_at AS first_call_at,
      CASE WHEN ${calledSql} THEN EXTRACT(EPOCH FROM (c.first_call_at - c.ghl_created_at)) END AS seconds_to_call
    FROM contacts c
    WHERE ${sql.join(clauses, sql` AND `)} AND ${trackable}
    ORDER BY
      (CASE WHEN ${calledSql} THEN 1 ELSE 0 END) ASC,               -- misses first
      CASE WHEN NOT (${calledSql}) THEN c.ghl_created_at END ASC,   -- oldest miss first
      seconds_to_call DESC NULLS LAST                               -- then slowest calls
    LIMIT 100
  `);
  const perLead: SpeedToLeadRow[] = resultRows<RowR>(perLeadRes).map((x) => {
    const seconds = x.seconds_to_call != null ? Number(x.seconds_to_call) : null;
    return {
      name: x.name ?? null,
      leadInAt: new Date(x.lead_in_at).toISOString(),
      firstCallAt: x.first_call_at ? new Date(x.first_call_at).toISOString() : null,
      secondsToCall: seconds,
      status: seconds != null ? "called" : "not_called",
    };
  });

  return {
    trackingStartedAt: trackingStart ? trackingStart.toISOString() : null,
    leads,
    trackable: trackableN,
    preTracking: Math.max(0, leads - trackableN),
    called: calledN,
    uncalled: Math.max(0, trackableN - calledN),
    medianSeconds: r?.median_seconds != null ? Number(r.median_seconds) : null,
    within5m: Number(r?.within_5m) || 0,
    within1h: Number(r?.within_1h) || 0,
    within24h: Number(r?.within_24h) || 0,
    rows: perLead,
  };
}

/* ------------------------------------------------------------------ *
 * Pipeline distribution — "where every lead sits right now"
 * ------------------------------------------------------------------ */

export interface PipelineStageCount {
  ghlStageName: string | null;
  canonicalStage: CanonicalStage | null;
  displayOrder: number;
  count: number;
  value: number;
}

/**
 * Current-state snapshot: how many paid leads are sitting in each pipeline
 * stage right now, ordered as the client's GHL pipeline is ordered.
 *
 * This is deliberately NOT window-scoped and NOT derived from the transition
 * ledger. It reads `opportunities.current_stage_id` directly, so it answers
 * "where are my leads today" exactly — which is the one funnel question a
 * history-less backfill CAN answer completely. The ledger-based `getFunnelCounts`
 * answers the complementary "how many entered a stage in a window", which for
 * backfilled data is only a floor.
 */
export async function getPipelineDistribution(
  clientId: string,
  filter: PaidLeadFilter = DEFAULT_LEAD_FILTER,
  platform: AdPlatform = "meta",
): Promise<{ stages: PipelineStageCount[]; total: number }> {
  const paid = platformLeadPredicate(platform, filter);
  const clauses: SQL[] = [sql`o.client_id = ${clientId}`];
  if (paid) clauses.push(paid);

  const rows = await db.execute<{
    name: string | null;
    canonical: string | null;
    ord: number;
    count: number;
    value: number;
  }>(sql`
    SELECT ps.ghl_stage_name              AS name,
           ps.canonical_stage             AS canonical,
           COALESCE(ps.display_order, 999) AS ord,
           COUNT(*)::int                  AS count,
           COALESCE(SUM(o.monetary_value), 0)::float AS value
    FROM opportunities o
    JOIN contacts c ON c.id = o.contact_id
    LEFT JOIN pipeline_stages ps ON ps.id = o.current_stage_id
    WHERE ${sql.join(clauses, sql` AND `)}
    GROUP BY ps.ghl_stage_name, ps.canonical_stage, ps.display_order
    ORDER BY ord
  `);

  const stages = resultRows<{
    name: string | null;
    canonical: string | null;
    ord: number;
    count: number;
    value: number;
  }>(rows).map((r) => ({
    ghlStageName: r.name,
    canonicalStage: (r.canonical as CanonicalStage | null) ?? null,
    displayOrder: Number(r.ord) || 0,
    count: Number(r.count) || 0,
    value: Number(r.value) || 0,
  }));

  return { stages, total: stages.reduce((s, x) => s + x.count, 0) };
}

/* ------------------------------------------------------------------ *
 * Individual leads — who is in which stage, and what brought them
 * ------------------------------------------------------------------ */

export interface LeadRow {
  id: string;
  name: string | null;
  campaignName: string | null;
  campaignId: string | null;
  ghlStageName: string | null;
  ghlPipelineName: string | null;
  canonicalStage: CanonicalStage | null;
  displayOrder: number;
  createdAt: string | null;
  value: number;
  status: string | null;
}

/**
 * Every paid lead as an individual row: the person, the stage they are in right
 * now, and the campaign attribution that brought them. This is the drill-down
 * behind the pipeline distribution — "show me WHO is in Appointment Booked, and
 * which ad they came from". Current-state, not window-scoped, to match the
 * distribution it expands.
 */
export async function getLeads(
  clientId: string,
  filter: PaidLeadFilter = DEFAULT_LEAD_FILTER,
  limit = 2000,
  platform: AdPlatform = "meta",
): Promise<LeadRow[]> {
  const paid = platformLeadPredicate(platform, filter);
  const col = campaignIdColumn(platform);
  const clauses: SQL[] = [sql`o.client_id = ${clientId}`];
  if (paid) clauses.push(paid);

  const rows = await db.execute<{
    id: string;
    name: string | null;
    campaign_name: string | null;
    campaign_id: string | null;
    stage_name: string | null;
    pipeline_name: string | null;
    canonical: string | null;
    ord: number;
    created_at: string | null;
    value: number;
    status: string | null;
  }>(sql`
    SELECT o.id::text                     AS id,
           o.name                         AS name,
           c.utm_campaign                 AS campaign_name,
           ${col}                         AS campaign_id,
           ps.ghl_stage_name              AS stage_name,
           ps.ghl_pipeline_name           AS pipeline_name,
           ps.canonical_stage             AS canonical,
           COALESCE(ps.display_order, 999) AS ord,
           o.ghl_created_at               AS created_at,
           COALESCE(o.monetary_value, 0)::float AS value,
           o.status                       AS status
    FROM opportunities o
    JOIN contacts c ON c.id = o.contact_id
    LEFT JOIN pipeline_stages ps ON ps.id = o.current_stage_id
    WHERE ${sql.join(clauses, sql` AND `)}
    ORDER BY ord ASC, o.ghl_created_at DESC NULLS LAST
    LIMIT ${limit}
  `);

  return resultRows<{
    id: string;
    name: string | null;
    campaign_name: string | null;
    campaign_id: string | null;
    stage_name: string | null;
    pipeline_name: string | null;
    canonical: string | null;
    ord: number;
    created_at: string | null;
    value: number;
    status: string | null;
  }>(rows).map((r) => ({
    id: r.id,
    name: r.name,
    campaignName: r.campaign_name,
    campaignId: r.campaign_id,
    ghlStageName: r.stage_name,
    ghlPipelineName: r.pipeline_name,
    canonicalStage: (r.canonical as CanonicalStage | null) ?? null,
    displayOrder: Number(r.ord) || 0,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    value: Number(r.value) || 0,
    status: r.status,
  }));
}

/** Canonical stages that currently have no GHL stage mapped — health check. */
export async function getUnmappedStageIds(clientId: string): Promise<string[]> {
  const rows = await db.execute<{ ghl_stage_id: string }>(
    sql`
      SELECT ghl_stage_id FROM pipeline_stages
      WHERE client_id = ${clientId} AND canonical_stage IS NULL
    `,
  );
  return resultRows<{ ghl_stage_id: string }>(rows).map((r) => r.ghl_stage_id);
}

/**
 * How many leads the paid filter is excluding.
 *
 * Surfaced in the UI because the failure mode is silent: if UTMs are missing
 * AND nobody applies the tag, paid lead counts read zero while the pipeline is
 * visibly full, and cost-per-lead shows a dash. Seeing "12 of 40 leads counted
 * as paid" makes that immediately diagnosable.
 */
export async function getLeadAttributionBreakdown(
  clientId: string,
  window: DateWindow,
  filter: PaidLeadFilter = DEFAULT_LEAD_FILTER,
  platform: AdPlatform = "meta",
): Promise<{ total: number; attributed: number; tagged: number; paid: number }> {
  const tag = filter.tag.trim().toLowerCase();
  const paid = platformLeadPredicate(platform, filter);
  const attributedExpr =
    platform === "google"
      ? sql`(c.google_campaign_id IS NOT NULL OR c.gclid IS NOT NULL)`
      : platform === "tiktok"
        ? sql`(c.tiktok_campaign_id IS NOT NULL OR c.ttclid IS NOT NULL)`
        : sql`c.meta_campaign_id IS NOT NULL`;

  const rows = await db.execute<{
    total: number;
    attributed: number;
    tagged: number;
    paid: number;
  }>(sql`
    SELECT
      COUNT(DISTINCT st.opportunity_id)::int AS total,
      COUNT(DISTINCT st.opportunity_id) FILTER (
        WHERE ${attributedExpr})::int AS attributed,
      COUNT(DISTINCT st.opportunity_id) FILTER (
        WHERE c.tags @> ARRAY[${tag}]::text[])::int AS tagged,
      COUNT(DISTINCT st.opportunity_id) FILTER (
        WHERE ${paid ?? sql`TRUE`})::int AS paid
    FROM stage_transitions st
    LEFT JOIN contacts c ON c.id = st.contact_id
    WHERE st.client_id = ${clientId}
      AND st.to_canonical = 'new_lead'
      AND st.changed_at >= ${window.startUtc}
      AND st.changed_at <  ${window.endUtc}
  `);

  const r = resultRows<{
    total: number;
    attributed: number;
    tagged: number;
    paid: number;
  }>(rows)[0];

  return {
    total: Number(r?.total ?? 0),
    attributed: Number(r?.attributed ?? 0),
    tagged: Number(r?.tagged ?? 0),
    paid: Number(r?.paid ?? 0),
  };
}

/** When paid leads arrive, bucketed by weekday × hour of day. */
export interface LeadHeatmap {
  /** grid[dow][hour] = paid leads that entered new_lead then. dow 0=Sun..6=Sat. */
  grid: number[][];
  byDow: number[]; // length 7
  byHour: number[]; // length 24
  max: number; // busiest single cell, for the colour scale
  total: number;
}

/**
 * Lead-arrival heatmap: when do paid leads actually come in?
 *
 * Same counting basis as the funnel's lead stage — DISTINCT opportunities
 * entering `new_lead`, paid-filtered — so the grid totals reconcile with the
 * "New leads" KPI. Bucketed in the CLIENT's timezone (Postgres `extract` over
 * `AT TIME ZONE`), because "which hour" is only meaningful locally: a 7pm-local
 * lead spike is invisible if bucketed in UTC. Directly actionable for ad
 * scheduling — the sheet could never show it.
 */
export async function getLeadArrivalHeatmap(
  clientId: string,
  window: DateWindow,
  tz: string,
  filter: PaidLeadFilter = DEFAULT_LEAD_FILTER,
  platform: AdPlatform = "meta",
): Promise<LeadHeatmap> {
  const paid = platformLeadPredicate(platform, filter);
  const rows = await db.execute<{ dow: number; hour: number; count: number }>(sql`
    SELECT
      extract(dow  from (st.changed_at AT TIME ZONE ${tz}))::int AS dow,
      extract(hour from (st.changed_at AT TIME ZONE ${tz}))::int AS hour,
      COUNT(DISTINCT st.opportunity_id)::int AS count
    FROM stage_transitions st
    ${paid ? sql`JOIN contacts c ON c.id = st.contact_id` : sql``}
    WHERE st.client_id = ${clientId}
      AND st.to_canonical = 'new_lead'
      AND st.changed_at >= ${window.startUtc}
      AND st.changed_at <  ${window.endUtc}
      ${paid ? sql`AND ${paid}` : sql``}
    GROUP BY 1, 2
  `);

  const grid: number[][] = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const byDow = new Array(7).fill(0);
  const byHour = new Array(24).fill(0);
  let max = 0;
  let total = 0;
  for (const r of resultRows<{ dow: number; hour: number; count: number }>(rows)) {
    const d = Number(r.dow);
    const h = Number(r.hour);
    const n = Number(r.count) || 0;
    if (d < 0 || d > 6 || h < 0 || h > 23) continue;
    grid[d][h] = n;
    byDow[d] += n;
    byHour[h] += n;
    total += n;
    if (n > max) max = n;
  }
  return { grid, byDow, byHour, max, total };
}

/* ------------------------------------------------------------------ *
 * Creative performance — the leaderboard, grouped by ASSET not by ad
 * ------------------------------------------------------------------ */

/** One creative asset's performance over a window. */
export interface CreativeRow {
  /** `image_hash` / `video_id`. Empty string = the unresolved bucket. */
  creativeKey: string;
  creativeType: CreativeType;
  /** A representative ad name — the same asset can run under several. */
  adName: string | null;
  title: string | null;
  body: string | null;
  callToActionType: string | null;
  thumbnailUrl: string | null;
  linkUrl: string | null;
  videoLengthSeconds: number | null;
  /** How many distinct ads carry this asset. >1 is the norm, not an anomaly. */
  adCount: number;
  adsetCount: number;
  campaignNames: string[];
  /**
   * Ad-set learning state, rolled up: true when ANY ad set running this asset
   * has not exited learning. Deliberately pessimistic — one ad set still
   * learning is enough to make the asset's cost per result unrepresentative.
   */
  learning: boolean;
  learningLimited: boolean;
  /** True when at least one ad carrying this asset is still ACTIVE. */
  active: boolean;
  totals: CreativeTotals;
  /**
   * Meta's own delivery judgements — the most recent day that carried one.
   *
   * NOT averaged across days or ads: a ranking is a percentile against other
   * advertisers competing for the same audience, and the mean of two percentiles
   * from different weeks is not a percentile of anything.
   */
  qualityRanking: DeliveryRanking | null;
  engagementRanking: DeliveryRanking | null;
  conversionRanking: DeliveryRanking | null;
  rankingDate: string | null;
}

/**
 * Per-creative performance for a window.
 *
 * 🔴 **Grouped by `creative_key`, never by ad id.** The same video running in
 * twelve ad sets is twelve ad ids; grouping on those splits one asset's spend
 * and leads twelve ways, and its cost per lead reads roughly twelve times too
 * low — which looks exactly like a star performer.
 *
 * Two honesty constraints are baked into the shape:
 *
 * 1. **Leads here are META-REPORTED, not CRM leads.** Every other lead figure on
 *    the dashboard comes from the stage-transition ledger, but GHL attribution
 *    carries no ad id — `utm_content` holds the ad *name* at best — so a CRM
 *    lead cannot be traced to the asset that produced it. The two counts will
 *    differ. `getCreativeLeadReconciliation` returns both so the UI can state
 *    the gap rather than let someone discover it by subtraction.
 * 2. **The empty-key bucket is kept, not dropped.** Dynamic Creative and
 *    carousels have no single identifying asset, and unreadable creatives have
 *    none either. Dropping them would make the grid's spend silently fail to
 *    reconcile with the campaign table. It is returned as a row with
 *    `creativeKey === ""` for the UI to render apart from real assets.
 */
export async function getCreativePerformance(
  clientId: string,
  window: DateWindow,
): Promise<CreativeRow[]> {
  const [metricRows, metaRows] = await Promise.all([
    db.execute<CreativeMetricRow>(sql`
      SELECT
        m.creative_key,
        MAX(m.creative_type::text)                       AS creative_type,
        COUNT(DISTINCT NULLIF(m.meta_ad_id, ''))::int    AS ad_count,
        COUNT(DISTINCT NULLIF(m.meta_adset_id, ''))::int AS adset_count,
        COALESCE(
          ARRAY_AGG(DISTINCT m.campaign_name) FILTER (WHERE m.campaign_name IS NOT NULL),
          '{}'
        )                                                AS campaign_names,
        COALESCE(SUM(m.impressions), 0)::bigint          AS impressions,
        COALESCE(SUM(m.video_3s_views), 0)::bigint       AS video_3s_views,
        COALESCE(SUM(m.video_plays), 0)::bigint          AS video_plays,
        COALESCE(SUM(m.thru_plays), 0)::bigint           AS thru_plays,
        COALESCE(SUM(m.video_p25), 0)::bigint            AS video_p25,
        COALESCE(SUM(m.video_p50), 0)::bigint            AS video_p50,
        COALESCE(SUM(m.video_p75), 0)::bigint            AS video_p75,
        COALESCE(SUM(m.video_p95), 0)::bigint            AS video_p95,
        COALESCE(SUM(m.video_p100), 0)::bigint           AS video_p100,
        COALESCE(SUM(m.link_clicks), 0)::bigint          AS link_clicks,
        COALESCE(SUM(m.landing_page_views), 0)::bigint   AS landing_page_views,
        COALESCE(SUM(m.outbound_clicks), 0)::bigint      AS outbound_clicks,
        COALESCE(SUM(m.spend), 0)                        AS spend,
        COALESCE(SUM(m.leads_total), 0)::bigint          AS leads,
        /*
         * The most recent day that actually carried a ranking, not an average.
         * FILTER drops the days Meta returned UNKNOWN, which means "not enough
         * delivery to judge" and is a different statement from AVERAGE.
         */
        (ARRAY_AGG(m.quality_ranking::text ORDER BY m.date DESC)
           FILTER (WHERE m.quality_ranking IS NOT NULL
                     AND m.quality_ranking <> 'unknown'))[1]        AS quality_ranking,
        (ARRAY_AGG(m.engagement_rate_ranking::text ORDER BY m.date DESC)
           FILTER (WHERE m.engagement_rate_ranking IS NOT NULL
                     AND m.engagement_rate_ranking <> 'unknown'))[1] AS engagement_ranking,
        (ARRAY_AGG(m.conversion_rate_ranking::text ORDER BY m.date DESC)
           FILTER (WHERE m.conversion_rate_ranking IS NOT NULL
                     AND m.conversion_rate_ranking <> 'unknown'))[1] AS conversion_ranking,
        (ARRAY_AGG(m.date::text ORDER BY m.date DESC)
           FILTER (WHERE m.quality_ranking IS NOT NULL
                     AND m.quality_ranking <> 'unknown'))[1]        AS ranking_date
      FROM fb_daily_metrics m
      WHERE m.client_id = ${clientId}
        AND m.level = 'ad'
        AND m.date >= ${window.startKey}
        AND m.date <= ${window.endKey}
      GROUP BY m.creative_key
    `),
    creativeIdentity(clientId),
  ]);

  const meta = new Map<string, CreativeMetaRow>();
  for (const r of resultRows<CreativeMetaRow>(metaRows)) {
    meta.set(r.creative_key, r);
  }

  return resultRows<CreativeMetricRow>(metricRows)
    .map((r): CreativeRow => {
      const m = meta.get(r.creative_key);
      return {
        creativeKey: r.creative_key,
        creativeType: asCreativeType(r.creative_type),
        adName: m?.ad_name ?? null,
        title: m?.title ?? null,
        body: m?.body ?? null,
        callToActionType: m?.call_to_action_type ?? null,
        thumbnailUrl: m?.thumbnail_url ?? null,
        linkUrl: m?.link_url ?? null,
        videoLengthSeconds:
          m?.video_length_seconds != null ? Number(m.video_length_seconds) : null,
        adCount: Number(r.ad_count) || 0,
        adsetCount: Number(r.adset_count) || 0,
        campaignNames: Array.isArray(r.campaign_names) ? r.campaign_names : [],
        learning: Boolean(m?.learning),
        learningLimited: Boolean(m?.learning_limited),
        active: Boolean(m?.active),
        totals: {
          impressions: Number(r.impressions) || 0,
          video3sViews: Number(r.video_3s_views) || 0,
          videoPlays: Number(r.video_plays) || 0,
          thruPlays: Number(r.thru_plays) || 0,
          videoP25: Number(r.video_p25) || 0,
          videoP50: Number(r.video_p50) || 0,
          videoP75: Number(r.video_p75) || 0,
          videoP95: Number(r.video_p95) || 0,
          videoP100: Number(r.video_p100) || 0,
          linkClicks: Number(r.link_clicks) || 0,
          landingPageViews: Number(r.landing_page_views) || 0,
          outboundClicks: Number(r.outbound_clicks) || 0,
          spend: Number(r.spend) || 0,
          leads: Number(r.leads) || 0,
        },
        qualityRanking: asRanking(r.quality_ranking),
        engagementRanking: asRanking(r.engagement_ranking),
        conversionRanking: asRanking(r.conversion_ranking),
        rankingDate: r.ranking_date ?? null,
      };
    })
    .sort((a, b) => b.totals.spend - a.totals.spend);
}

interface CreativeMetricRow extends Record<string, unknown> {
  creative_key: string;
  creative_type: string | null;
  ad_count: number;
  adset_count: number;
  campaign_names: string[] | null;
  impressions: string;
  video_3s_views: string;
  video_plays: string;
  thru_plays: string;
  video_p25: string;
  video_p50: string;
  video_p75: string;
  video_p95: string;
  video_p100: string;
  link_clicks: string;
  landing_page_views: string;
  outbound_clicks: string;
  spend: string;
  leads: string;
  quality_ranking: string | null;
  engagement_ranking: string | null;
  conversion_ranking: string | null;
  ranking_date: string | null;
}

interface CreativeMetaRow extends Record<string, unknown> {
  creative_key: string;
  ad_name: string | null;
  title: string | null;
  body: string | null;
  call_to_action_type: string | null;
  link_url: string | null;
  thumbnail_url: string | null;
  video_length_seconds: string | null;
  learning: boolean | null;
  learning_limited: boolean | null;
  active: boolean | null;
}

/**
 * What each asset looks like, and whether anything is still running it.
 *
 * Window-independent by design — an asset's headline and thumbnail are
 * properties of the asset, not of the dates being reported on — so the same
 * query serves the leaderboard and the fatigue engine, which read over
 * different spans. Shared rather than copied so a fix to the representative-row
 * ordering below cannot land in one and not the other.
 */
function creativeIdentity(clientId: string) {
  return db.execute<CreativeMetaRow>(sql`
    SELECT
      c.creative_key,
      /*
       * A representative value per asset, preferring the most recently synced
       * ad that actually has one. Ordering on (x IS NULL) puts non-nulls first,
       * so a newer ad with a blank headline does not blank out the grid.
       */
      (ARRAY_AGG(c.ad_name ORDER BY (c.ad_name IS NULL), c.synced_at DESC))[1]   AS ad_name,
      (ARRAY_AGG(c.title ORDER BY (c.title IS NULL), c.synced_at DESC))[1]       AS title,
      (ARRAY_AGG(c.body ORDER BY (c.body IS NULL), c.synced_at DESC))[1]         AS body,
      (ARRAY_AGG(c.call_to_action_type
         ORDER BY (c.call_to_action_type IS NULL), c.synced_at DESC))[1]         AS call_to_action_type,
      (ARRAY_AGG(c.link_url ORDER BY (c.link_url IS NULL), c.synced_at DESC))[1] AS link_url,
      /* Thumbnail URLs expire, so the freshest one is the only usable one. */
      (ARRAY_AGG(c.thumbnail_url
         ORDER BY (c.thumbnail_url IS NULL), c.synced_at DESC))[1]               AS thumbnail_url,
      MAX(c.video_length_seconds)                                               AS video_length_seconds,
      BOOL_OR(c.learning_stage = 'LEARNING')                                     AS learning,
      BOOL_OR(c.learning_stage = 'LEARNING_LIMITED')                             AS learning_limited,
      BOOL_OR(c.status = 'ACTIVE')                                               AS active
    FROM meta_ad_creatives c
    WHERE c.client_id = ${clientId}
      AND c.creative_key <> ''
    GROUP BY c.creative_key
  `);
}

/* ------------------------------------------------------------------ *
 * Creative fatigue — one row per asset per day
 * ------------------------------------------------------------------ */

interface FatigueDayRow extends Record<string, unknown> {
  creative_key: string;
  date: string;
  creative_type: string | null;
  impressions: string;
  link_clicks: string;
  video_3s_views: string;
  spend: string;
  leads: string;
  reach: string;
  ad_count: number;
}

/**
 * The daily series each asset is judged against its own past on.
 *
 * Three shape decisions, each of which changes what the engine can conclude:
 *
 * 1. **Grouped by `creative_key`, like the leaderboard.** Grouping by ad id
 *    would split one asset's history across every ad set it ever ran in, and a
 *    creative's "decline" would then be indistinguishable from it being moved
 *    into a new ad set.
 * 2. 🔴 **The unresolved bucket is excluded, and this is the one place that is
 *    right.** `getCreativePerformance` keeps `creative_key = ''` so spend
 *    reconciles; here it would be actively wrong. That bucket is Dynamic
 *    Creative and unreadable assets pooled together, and its *composition*
 *    changes from day to day — so a fall in its CTR is a different mix of ads,
 *    not an audience tiring of anything. There is no asset to reshoot.
 * 3. **`reach` and `ad_count` travel together.** Reach is deduplicated people;
 *    summing it across the several ads carrying one asset double-counts anyone
 *    who saw two of them. The count comes back so the engine can decline to
 *    quote a frequency on days it would be a sum of overlapping groups, rather
 *    than quoting one that is quietly too low.
 */
export async function getCreativeFatigueInput(
  clientId: string,
  window: DateWindow,
): Promise<FatigueInput[]> {
  const [seriesRows, metaRows] = await Promise.all([
    db.execute<FatigueDayRow>(sql`
      SELECT
        m.creative_key,
        m.date::text                                     AS date,
        MAX(m.creative_type::text)                       AS creative_type,
        COALESCE(SUM(m.impressions), 0)::bigint          AS impressions,
        COALESCE(SUM(m.link_clicks), 0)::bigint          AS link_clicks,
        COALESCE(SUM(m.video_3s_views), 0)::bigint       AS video_3s_views,
        COALESCE(SUM(m.spend), 0)                        AS spend,
        COALESCE(SUM(m.leads_total), 0)::bigint          AS leads,
        COALESCE(SUM(m.reach), 0)::bigint                AS reach,
        COUNT(DISTINCT NULLIF(m.meta_ad_id, ''))::int    AS ad_count
      FROM fb_daily_metrics m
      WHERE m.client_id = ${clientId}
        AND m.level = 'ad'
        AND m.creative_key <> ''
        AND m.date >= ${window.startKey}
        AND m.date <= ${window.endKey}
      GROUP BY m.creative_key, m.date
      ORDER BY m.creative_key, m.date
    `),
    creativeIdentity(clientId),
  ]);

  const meta = new Map<string, CreativeMetaRow>();
  for (const r of resultRows<CreativeMetaRow>(metaRows)) meta.set(r.creative_key, r);

  const byCreative = new Map<string, { type: CreativeType; days: CreativeDay[] }>();
  for (const r of resultRows<FatigueDayRow>(seriesRows)) {
    let entry = byCreative.get(r.creative_key);
    if (!entry) {
      entry = { type: asCreativeType(r.creative_type), days: [] };
      byCreative.set(r.creative_key, entry);
    } else if (entry.type === "unknown") {
      // An asset whose type was only readable on some days.
      entry.type = asCreativeType(r.creative_type);
    }
    entry.days.push({
      dateKey: r.date,
      impressions: Number(r.impressions) || 0,
      linkClicks: Number(r.link_clicks) || 0,
      video3sViews: Number(r.video_3s_views) || 0,
      spend: Number(r.spend) || 0,
      leads: Number(r.leads) || 0,
      reach: Number(r.reach) || 0,
      adCount: Number(r.ad_count) || 0,
    });
  }

  return [...byCreative].map(([creativeKey, { type, days }]) => {
    const m = meta.get(creativeKey);
    return {
      creativeKey,
      name: m?.title || m?.ad_name || creativeKey,
      type,
      /*
       * Absent identity means the creative row was never synced — usually an
       * asset deleted in Ads Manager whose metrics rows survive. Treated as
       * inactive: there is nothing left to refresh.
       */
      active: Boolean(m?.active),
      learning: Boolean(m?.learning),
      thumbnailUrl: m?.thumbnail_url ?? null,
      days,
    };
  });
}

const CREATIVE_TYPES: readonly CreativeType[] = ["image", "video", "carousel", "unknown"];
function asCreativeType(v: string | null): CreativeType {
  return CREATIVE_TYPES.includes(v as CreativeType) ? (v as CreativeType) : "unknown";
}

const RANKINGS: readonly DeliveryRanking[] = [
  "below_average_10",
  "below_average_20",
  "below_average_35",
  "average",
  "above_average",
  "unknown",
];
function asRanking(v: string | null): DeliveryRanking | null {
  return v && RANKINGS.includes(v as DeliveryRanking) ? (v as DeliveryRanking) : null;
}

/**
 * The two lead counts for the same window, side by side.
 *
 * The creative grid CANNOT use CRM leads. GHL attribution carries no ad id at
 * all — the landing URL gives us a campaign id and sometimes an ad-set id, and
 * `utm_content` carries the ad *name*, which is renameable and therefore not an
 * identity. So per-asset cost per lead is necessarily Meta's own conversion
 * count, while every other lead figure on this page is the CRM ledger's.
 *
 * These two numbers do not agree, and they never will: Meta counts a conversion
 * against the ad it attributes it to within its own attribution window, the CRM
 * counts an opportunity that actually reached the pipeline. Publishing one
 * number under the same label as the other is how a client ends up asking why
 * the dashboard contradicts itself. Both are returned so the grid can say which
 * it is using and by how much they differ.
 */
export interface CreativeLeadReconciliation {
  metaReported: number;
  crmRecorded: number;
  /** metaReported − crmRecorded. Positive means Meta claims more. */
  gap: number;
}

/* ------------------------------------------------------------------ *
 * Trend annotations — "what happened on the 14th?"
 * ------------------------------------------------------------------ */

// The derivation itself is pure and lives next door, so it can be unit-tested
// without a database. Re-exported so callers keep one import site.
export type { AnnotationKind, TrendAnnotation } from "./annotations";
export { deriveSpendAnnotations } from "./annotations";

/**
 * Events worth marking on the time axis, from data already stored.
 *
 * The question this answers is the one every client asks and no dashboard in
 * this category answers: *what happened on the 14th?* Databox and
 * AgencyAnalytics charge for manual annotations; these write themselves.
 *
 * Two sources, and the first matters more than it looks:
 *
 * 1. **`audit_log`.** A stage remap retroactively relabels history — thousands
 *    of past transitions can enter or leave the funnel in one call — so a funnel
 *    that steps overnight has two indistinguishable explanations, "the ads
 *    changed" and "someone remapped a stage". Marking the second is the
 *    difference between an explicable chart and a mysterious one. Ad accounts
 *    being attached or removed change spend the same way.
 * 2. **Derived signals.** A campaign's first or last day of delivery, and a
 *    day-over-day spend jump of ≥3×. Floored at $50 so $2 → $6 is not announced
 *    as an event; a threshold with no floor fires constantly on small accounts
 *    and trains people to ignore the marks.
 */
export async function getTrendAnnotations(
  clientId: string,
  window: DateWindow,
  tz: string,
): Promise<TrendAnnotation[]> {
  const [auditRows, campaignRows] = await Promise.all([
    db.execute<{ at: string; action: string; metadata: unknown }>(sql`
      SELECT to_char(a.at AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS at,
             a.action,
             a.metadata
        FROM audit_log a
       WHERE a.client_id = ${clientId}
         AND a.at >= ${window.startUtc}
         AND a.at <  ${window.endUtc}
         AND a.action IN ('stages.remap','meta_account.add','meta_account.remove',
                          'google_account.add','google_account.remove')
       ORDER BY a.at ASC
    `),
    /*
     * Per-campaign daily spend across the window PLUS several days of lead-in.
     *
     * The lead-in exists so the first visible days can still be compared against
     * a trailing baseline. Without it, the opening days of any range can never
     * be marked — and when someone zooms in on a week precisely because
     * something changed in it, that is exactly the week whose change would go
     * unmarked. Sized to `SPEND_BASELINE_DAYS`.
     */
    db.execute<{
      date: string;
      campaign_id: string;
      campaign_name: string | null;
      spend: string;
    }>(sql`
      SELECT m.date::text AS date,
             m.meta_campaign_id AS campaign_id,
             MAX(m.campaign_name) AS campaign_name,
             COALESCE(SUM(m.spend), 0) AS spend
        FROM fb_daily_metrics m
       WHERE m.client_id = ${clientId}
         AND m.level = 'campaign'
         AND m.date >= (${window.startKey}::date - (${SPEND_BASELINE_DAYS} * INTERVAL '1 day'))
         AND m.date <= ${window.endKey}
       GROUP BY m.date, m.meta_campaign_id
       ORDER BY m.meta_campaign_id, m.date
    `),
  ]);

  const out: TrendAnnotation[] = [];

  for (const r of resultRows<{ at: string; action: string; metadata: unknown }>(
    auditRows,
  )) {
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    switch (r.action) {
      case "stages.remap": {
        const n = Number(meta.reclassifiedTransitions) || 0;
        out.push({
          dateKey: r.at,
          kind: "stage_remap",
          label: "Stage mapping changed",
          detail:
            n > 0
              ? `${n} past transitions were reclassified, so funnel figures before this date may have moved.`
              : "Pipeline stages were remapped.",
        });
        break;
      }
      case "meta_account.add":
      case "google_account.add":
        out.push({
          dateKey: r.at,
          kind: "account_added",
          label: "Ad account added",
          detail: "Spend from a newly connected account starts appearing here.",
        });
        break;
      case "meta_account.remove":
      case "google_account.remove":
        out.push({
          dateKey: r.at,
          kind: "account_removed",
          label: "Ad account removed",
          detail: "An account stopped reporting into this dashboard.",
        });
        break;
    }
  }

  out.push(...deriveSpendAnnotations(
    resultRows<{
      date: string;
      campaign_id: string;
      campaign_name: string | null;
      spend: string;
    }>(campaignRows),
    window.startKey,
  ));

  return out.sort((a, b) => a.dateKey.localeCompare(b.dateKey));
}

/* ------------------------------------------------------------------ *
 * Audience breakdowns — where the money actually went
 * ------------------------------------------------------------------ */

export interface BreakdownSegment {
  value: string;
  spend: number;
  impressions: number;
  linkClicks: number;
  leads: number;
  /** Share of the SEGMENTED spend, not of account spend. See `unsegmented`. */
  shareOfSegmented: number | null;
  cpLead: number | null;
  /**
   * Where this segment's cost per lead sits against the panel's own average,
   * and whether it clears the noise in its lead count enough to say so.
   *
   * See `benchmark.ts` for why the yardstick is the panel and not the account,
   * and why a segment with four leads usually stays silent.
   */
  benchmark: SegmentBenchmark;
  /**
   * Deduplicated people, and null for any multi-day range.
   *
   * Reach counts distinct people inside one queried window. Summing a segment's
   * daily reach counts a returning viewer once per day, and summing across
   * segments counts one person once per placement they saw the ad on. Both
   * overstate, so an aggregate declines rather than guesses.
   */
  reach: number | null;
}

export interface BreakdownGroup {
  key: BreakdownKey;
  segments: BreakdownSegment[];
  /** Total spend across the returned segments. */
  segmentedSpend: number;
  /** Total leads across the returned segments — the denominator of `cpLead`. */
  segmentedLeads: number;
  /**
   * The panel's own weighted average cost per lead, and the yardstick every
   * segment's `benchmark` is measured against.
   *
   * Built from `segmentedSpend / segmentedLeads` rather than from account
   * totals, because the segments deliberately do not sum to the account — see
   * `unsegmentedSpend` below, and the longer note in `benchmark.ts`.
   */
  cpLead: number | null;
  /**
   * Account spend for the same window that no segment accounts for.
   *
   * 🔴 **Expected, permanent, and must be displayed.** Meta withholds segments
   * whose audience falls below its privacy threshold, so segment rows do not sum
   * to the campaign total and never will. A reader who adds up the age rows,
   * finds them short of the headline figure, and concludes the dashboard is
   * broken is the failure this field exists to prevent.
   */
  unsegmentedSpend: number;
  /** True when this breakdown has never returned a row for this client. */
  missing: boolean;
}

/**
 * Every audience breakdown for a window, with its reconciliation gap.
 *
 * `totalSpend` is the account's own figure from `fb_daily_metrics`, queried
 * independently — it is the yardstick the segments are measured against, not
 * their sum.
 */
export interface Breakdowns {
  groups: BreakdownGroup[];
  totalSpend: number;
  /** Whether ANY breakdown row exists for this client, at any date. */
  everSynced: boolean;
  /** True when the window is a single day, where reach is meaningful. */
  singleDay: boolean;
}

const BREAKDOWN_ORDER: readonly BreakdownKey[] = [
  // Region first: for a local service business, clicks outside the service area
  // are usually the largest silent waste in the account.
  "region",
  "placement",
  "device",
  "age",
  "gender",
];


export async function getBreakdowns(
  clientId: string,
  window: DateWindow,
): Promise<Breakdowns> {
  const singleDay = window.startKey === window.endKey;

  const [segmentRows, totals, ever] = await Promise.all([
    db
      .select({
        breakdownKey: fbBreakdownMetrics.breakdownKey,
        segmentValue: fbBreakdownMetrics.segmentValue,
        spend: sql<string>`COALESCE(SUM(${fbBreakdownMetrics.spend}), 0)`,
        impressions: sql<string>`COALESCE(SUM(${fbBreakdownMetrics.impressions}), 0)`,
        linkClicks: sql<string>`COALESCE(SUM(${fbBreakdownMetrics.linkClicks}), 0)`,
        leads: sql<string>`COALESCE(SUM(${fbBreakdownMetrics.leadsTotal}), 0)`,
        /*
         * Summed ONLY to be discarded below unless the window is a single day.
         * Selecting it here rather than conditionally keeps one query shape; the
         * decision about whether it means anything is made in one place.
         */
        reach: sql<string>`COALESCE(SUM(${fbBreakdownMetrics.reach}), 0)`,
      })
      .from(fbBreakdownMetrics)
      .where(
        and(
          eq(fbBreakdownMetrics.clientId, clientId),
          gte(fbBreakdownMetrics.dateStart, window.startKey),
          lte(fbBreakdownMetrics.dateEnd, window.endKey),
        ),
      )
      .groupBy(fbBreakdownMetrics.breakdownKey, fbBreakdownMetrics.segmentValue),

    getAdTotals(clientId, window, undefined, "meta"),

    db
      .select({ one: sql<number>`1` })
      .from(fbBreakdownMetrics)
      .where(eq(fbBreakdownMetrics.clientId, clientId))
      .limit(1),
  ]);

  const byKey = new Map<BreakdownKey, BreakdownSegment[]>();
  for (const r of segmentRows) {
    const list = byKey.get(r.breakdownKey) ?? [];
    const spend = Number(r.spend) || 0;
    const leads = Number(r.leads) || 0;
    list.push({
      value: r.segmentValue,
      spend,
      impressions: Number(r.impressions) || 0,
      linkClicks: Number(r.linkClicks) || 0,
      leads,
      shareOfSegmented: null, // filled once the group total is known
      cpLead: costPer(spend, leads),
      benchmark: { verdict: "none" }, // same — needs the panel average
      reach: singleDay ? Number(r.reach) || 0 : null,
    });
    byKey.set(r.breakdownKey, list);
  }

  const groups: BreakdownGroup[] = BREAKDOWN_ORDER.map((key) => {
    const segments = orderSegments(key, byKey.get(key) ?? []);
    const segmentedSpend = segments.reduce((s, x) => s + x.spend, 0);
    const segmentedLeads = segments.reduce((s, x) => s + x.leads, 0);
    const panelCpLead = costPer(segmentedSpend, segmentedLeads);
    for (const s of segments) {
      s.shareOfSegmented = segmentedSpend > 0 ? s.spend / segmentedSpend : null;
      s.benchmark = benchmarkSegment(s.spend, s.leads, panelCpLead);
    }
    return {
      key,
      segments,
      segmentedSpend,
      segmentedLeads,
      cpLead: panelCpLead,
      /*
       * Clamped at zero. Meta's segment sums can very slightly EXCEED the
       * account total through independent rounding of each row's spend, and a
       * negative "unsegmented" figure would read as a bug rather than as noise.
       */
      unsegmentedSpend: Math.max(0, totals.spend - segmentedSpend),
      missing: segments.length === 0,
    };
  });

  return {
    groups,
    totalSpend: totals.spend,
    everSynced: ever.length > 0,
    singleDay,
  };
}

/* ------------------------------------------------------------------ *
 * Creative-level revenue — which ads bring CUSTOMERS, not leads
 * ------------------------------------------------------------------ */

/** What one creative produced downstream of the click. */
export interface CreativeOutcome {
  creativeKey: string;
  /** Distinct opportunities from this creative that entered `closed_won`. */
  deals: number;
  /** Of those, how many carried a deal value. Revenue is only their sum. */
  dealsWithValue: number;
  revenue: number;
  appointments: number;
  showed: number;
  /** Median days from lead-in to close. Null below two closed deals. */
  medianDaysToClose: number | null;
}

/**
 * How much of the revenue picture is actually traceable to a creative.
 *
 * This is not a footnote — it is the headline. The join below is only as good as
 * the ad id on the contact, and if that is missing the correct output is "we
 * cannot tell you", not a table of zeroes that reads as "these ads produced no
 * customers".
 */
export interface RevenueAttributionCoverage {
  /** Closed-won opportunities in the window, paid-filtered. */
  totalDeals: number;
  /** Of those, how many carry a `meta_ad_id` we can resolve to a creative. */
  attributedDeals: number;
  /** Contacts created in the window carrying an ad id — is the pipe live NOW? */
  recentContactsWithAdId: number;
  recentContacts: number;
}

export interface CreativeRevenue {
  byCreative: Map<string, CreativeOutcome>;
  coverage: RevenueAttributionCoverage;
}

const EMPTY_CREATIVE_REVENUE: CreativeRevenue = {
  byCreative: new Map(),
  coverage: {
    totalDeals: 0,
    attributedDeals: 0,
    recentContactsWithAdId: 0,
    recentContacts: 0,
  },
};

/**
 * Revenue, appointments, shows and sales-cycle length per CREATIVE.
 *
 * The thing no CRM-less competitor can compute: *"this video produced 22 leads
 * at $31 and 4 closed deals worth $18,400; this image produced 31 leads at $19
 * and zero closes."* The second looks better on every dashboard in the world and
 * is the worse ad.
 *
 * 🔴 **The join key is `contacts.meta_ad_id`, and it is the whole ballgame.**
 * GHL does not store Meta ad ids natively; the id only arrives if the ad's URL
 * parameters carry `ad_id={{ad.id}}`. Measured against this database on
 * 2026-08-12: 1 contact of 1,595 had an ad id, and 0 of 64 closed-won deals did.
 * So this query is correct and currently returns nothing, which is why it
 * returns COVERAGE alongside the numbers — a caller that renders the map without
 * checking coverage would publish "no creative produced a customer", which is a
 * false statement about the ads rather than a true one about the data.
 *
 * Deliberately NOT joined via ad SET as a fallback. An ad set routinely runs
 * several creatives, so ad-set revenue divided among them is a guess wearing a
 * number's clothing — and the one case where it is unambiguous (an ad set
 * running exactly one creative) has zero rows to validate against today.
 */
export async function getCreativeRevenue(
  clientId: string,
  window: DateWindow,
  filter: PaidLeadFilter = DEFAULT_LEAD_FILTER,
): Promise<CreativeRevenue> {
  const paid = platformLeadPredicate("meta", filter);
  const paidClause = paid ? sql` AND ${paid}` : sql``;

  /*
   * `first_lead` is the opportunity's own lead-in, from the ledger — used for
   * sales-cycle length. Taken as the MIN over all of that opportunity's
   * `new_lead` transitions rather than the one inside the window, because a deal
   * closing in August may well have entered the pipeline in June and the cycle
   * length is the whole span, not the part that happens to fall in range.
   */
  const rows = await db.execute<CreativeOutcomeRow>(sql`
    WITH deal AS (
      SELECT DISTINCT ON (st.opportunity_id)
             st.opportunity_id,
             c.meta_ad_id,
             o.monetary_value,
             st.changed_at AS won_at
        FROM stage_transitions st
        JOIN contacts c      ON c.id = st.contact_id
        JOIN opportunities o ON o.id = st.opportunity_id
       WHERE st.client_id = ${clientId}
         AND st.to_canonical = 'closed_won'
         AND st.changed_at >= ${window.startUtc}
         AND st.changed_at <  ${window.endUtc}${paidClause}
       ORDER BY st.opportunity_id, st.changed_at ASC
    ),
    lead_in AS (
      SELECT opportunity_id, MIN(changed_at) AS lead_at
        FROM stage_transitions
       WHERE client_id = ${clientId} AND to_canonical = 'new_lead'
       GROUP BY opportunity_id
    ),
    /*
     * ad id → creative key, ONE row per ad.
     *
     * meta_ad_creatives is unique on (client_id, meta_ad_id), so joining a
     * deal through this cannot multiply it. Going the other way — creative_key
     * → its many ad ids — would fan each deal out across every ad carrying the
     * creative and multiply the revenue by that count, which is the same
     * split-by-ad-id error the creative key exists to prevent, running in
     * reverse.
     */
    ad_creative AS (
      SELECT meta_ad_id, creative_key
        FROM meta_ad_creatives
       WHERE client_id = ${clientId} AND creative_key <> ''
    ),
    deal_rollup AS (
      SELECT ac.creative_key,
             COUNT(DISTINCT d.opportunity_id)::int                        AS deals,
             COUNT(DISTINCT d.opportunity_id)
               FILTER (WHERE COALESCE(d.monetary_value, 0) > 0)::int      AS deals_with_value,
             COALESCE(SUM(d.monetary_value), 0)::float                    AS revenue,
             PERCENTILE_CONT(0.5) WITHIN GROUP (
               ORDER BY EXTRACT(EPOCH FROM (d.won_at - li.lead_at)) / 86400
             )                                                            AS median_days
        FROM deal d
        JOIN ad_creative ac ON ac.meta_ad_id = d.meta_ad_id
        LEFT JOIN lead_in li ON li.opportunity_id = d.opportunity_id
       GROUP BY ac.creative_key
    ),
    stage_rollup AS (
      SELECT ac.creative_key,
             COUNT(DISTINCT st.opportunity_id)
               FILTER (WHERE st.to_canonical = 'appointment_booked')::int AS appointments,
             COUNT(DISTINCT st.opportunity_id)
               FILTER (WHERE st.to_canonical = 'showed')::int             AS showed
        FROM stage_transitions st
        JOIN contacts c     ON c.id = st.contact_id
        JOIN ad_creative ac ON ac.meta_ad_id = c.meta_ad_id
       WHERE st.client_id = ${clientId}
         AND st.changed_at >= ${window.startUtc}
         AND st.changed_at <  ${window.endUtc}${paidClause}
       GROUP BY ac.creative_key
    )
    /*
     * FULL OUTER: a creative that booked appointments nobody closed must still
     * appear. That case — plenty of bookings, zero revenue — is precisely the
     * signal this whole section exists to surface, and an inner join would
     * delete it.
     */
    SELECT COALESCE(d.creative_key, s.creative_key)  AS creative_key,
           COALESCE(d.deals, 0)                      AS deals,
           COALESCE(d.deals_with_value, 0)           AS deals_with_value,
           COALESCE(d.revenue, 0)                    AS revenue,
           d.median_days                             AS median_days,
           COALESCE(s.appointments, 0)               AS appointments,
           COALESCE(s.showed, 0)                     AS showed
      FROM deal_rollup d
      FULL OUTER JOIN stage_rollup s ON s.creative_key = d.creative_key
  `);

  const byCreative = new Map<string, CreativeOutcome>();
  for (const r of resultRows<CreativeOutcomeRow>(rows)) {
    const deals = Number(r.deals) || 0;
    byCreative.set(r.creative_key, {
      creativeKey: r.creative_key,
      deals,
      dealsWithValue: Number(r.deals_with_value) || 0,
      revenue: Number(r.revenue) || 0,
      appointments: Number(r.appointments) || 0,
      showed: Number(r.showed) || 0,
      // A "median" of one deal is that deal. Withheld below two, because a
      // single 3-day close reads as a sales cycle and is a sample of one.
      medianDaysToClose:
        deals >= 2 && r.median_days != null ? Number(r.median_days) : null,
    });
  }

  return { byCreative, coverage: await getRevenueCoverage(clientId, window, filter) };
}

interface CreativeOutcomeRow extends Record<string, unknown> {
  creative_key: string;
  deals: number;
  deals_with_value: number;
  revenue: number;
  median_days: string | null;
  appointments: number;
  showed: number;
}

/** How much of the revenue picture the ad id actually reaches. */
async function getRevenueCoverage(
  clientId: string,
  window: DateWindow,
  filter: PaidLeadFilter,
): Promise<RevenueAttributionCoverage> {
  const paid = platformLeadPredicate("meta", filter);
  const paidClause = paid ? sql` AND ${paid}` : sql``;

  const rows = await db.execute<{
    total_deals: number;
    attributed_deals: number;
    recent_contacts: number;
    recent_with_ad_id: number;
  }>(sql`
    SELECT
      (SELECT COUNT(DISTINCT st.opportunity_id)::int
         FROM stage_transitions st
         JOIN contacts c ON c.id = st.contact_id
        WHERE st.client_id = ${clientId}
          AND st.to_canonical = 'closed_won'
          AND st.changed_at >= ${window.startUtc}
          AND st.changed_at <  ${window.endUtc}${paidClause}
      ) AS total_deals,
      (SELECT COUNT(DISTINCT st.opportunity_id)::int
         FROM stage_transitions st
         JOIN contacts c ON c.id = st.contact_id
        WHERE st.client_id = ${clientId}
          AND st.to_canonical = 'closed_won'
          AND st.changed_at >= ${window.startUtc}
          AND st.changed_at <  ${window.endUtc}
          AND c.meta_ad_id IS NOT NULL${paidClause}
      ) AS attributed_deals,
      (SELECT COUNT(*)::int FROM contacts c
        WHERE c.client_id = ${clientId}
          AND c.created_at >= NOW() - INTERVAL '30 days'
      ) AS recent_contacts,
      (SELECT COUNT(*)::int FROM contacts c
        WHERE c.client_id = ${clientId}
          AND c.created_at >= NOW() - INTERVAL '30 days'
          AND c.meta_ad_id IS NOT NULL
      ) AS recent_with_ad_id
  `);

  const r = resultRows<{
    total_deals: number;
    attributed_deals: number;
    recent_contacts: number;
    recent_with_ad_id: number;
  }>(rows)[0];
  if (!r) return EMPTY_CREATIVE_REVENUE.coverage;
  return {
    totalDeals: Number(r.total_deals) || 0,
    attributedDeals: Number(r.attributed_deals) || 0,
    recentContacts: Number(r.recent_contacts) || 0,
    recentContactsWithAdId: Number(r.recent_with_ad_id) || 0,
  };
}

/**
 * Whether ad-level sync has ever written a row for this client.
 *
 * Separates two states that look identical in an empty result set: "no ads
 * delivered in the selected range" and "per-creative reporting had not been
 * switched on when that range happened". Only the first means no ads ran, and
 * telling a client the second is the first is a false statement about their
 * account. Deliberately not date-scoped — that is the whole point.
 */
export async function hasAdLevelData(clientId: string): Promise<boolean> {
  const rows = await db
    .select({ one: sql<number>`1` })
    .from(fbDailyMetrics)
    .where(and(eq(fbDailyMetrics.clientId, clientId), eq(fbDailyMetrics.level, "ad")))
    .limit(1);
  return rows.length > 0;
}

export async function getCreativeLeadReconciliation(
  clientId: string,
  window: DateWindow,
  filter: PaidLeadFilter = DEFAULT_LEAD_FILTER,
): Promise<CreativeLeadReconciliation> {
  const [adRow] = await db
    .select({
      leads: sql<string>`COALESCE(SUM(${fbDailyMetrics.leadsTotal}), 0)`,
    })
    .from(fbDailyMetrics)
    .where(
      and(
        eq(fbDailyMetrics.clientId, clientId),
        gte(fbDailyMetrics.date, window.startKey),
        lte(fbDailyMetrics.date, window.endKey),
        eq(fbDailyMetrics.level, "ad"),
      ),
    );

  const funnel = await getFunnelCounts(clientId, window, undefined, filter, "meta");
  const metaReported = Number(adRow?.leads) || 0;
  const crmRecorded = funnel.new_lead;
  return { metaReported, crmRecorded, gap: metaReported - crmRecorded };
}

export type { CanonicalStage };

/* ------------------------------------------------------------------ *
 * The book — every client's totals in one pass
 * ------------------------------------------------------------------ */

/** One client's window pair, in that client's own timezone. */
export interface BookWindow {
  clientId: string;
  current: DateWindow;
  previous: DateWindow;
  filter: PaidLeadFilter;
}

/** Per client, per bucket. Raw counts only; every ratio is derived later. */
export type BookBucket = "current" | "previous";

export interface BookAggregate {
  clientId: string;
  bucket: BookBucket;
  metaSpend: number;
  googleSpend: number;
  tiktokSpend: number;
  funnel: FunnelCounts;
  revenue: RevenueTotals;
}

/**
 * 🔴 Every client's window is its OWN window.
 *
 * "Last 30 days" ends at a different instant for a client in Los Angeles than
 * for one in London, and Meta buckets each account's day in that account's
 * timezone. Passing one pair of dates for the whole book would shift some
 * clients' figures by a day against the dashboard they can open themselves —
 * two numbers for the same month, which is the failure this product exists to
 * prevent. So the windows arrive per client and travel into the query as data.
 *
 * Both buckets are in one VALUES list, so period-over-period costs no extra
 * round trip.
 */
function bookWindows(windows: readonly BookWindow[]): SQL {
  const rows = windows.flatMap((w) => [
    sql`(${w.clientId}::uuid, 'current'::text, ${w.current.startKey}::date, ${w.current.endKey}::date, ${w.current.startUtc}::timestamptz, ${w.current.endUtc}::timestamptz, ${w.filter.mode}::text, ${w.filter.tag.trim().toLowerCase()}::text)`,
    sql`(${w.clientId}::uuid, 'previous'::text, ${w.previous.startKey}::date, ${w.previous.endKey}::date, ${w.previous.startUtc}::timestamptz, ${w.previous.endUtc}::timestamptz, ${w.filter.mode}::text, ${w.filter.tag.trim().toLowerCase()}::text)`,
  ]);
  return sql`w (client_id, bucket, start_key, end_key, start_utc, end_utc, lead_mode, lead_tag) AS (
    VALUES ${sql.join(rows, sql`, `)}
  )`;
}

/**
 * Which leads count, expressed once, per row of the window table.
 *
 * The per-client version of this lives in `paidLeadPredicate` as four separate
 * branches chosen in TypeScript. Here every client is in flight at once and
 * each has its own mode, so the branch has to happen in SQL against the row's
 * own `lead_mode`.
 *
 * 🔴 The `LEFT JOIN` on contacts and the `lead_mode = 'all'` escape are one
 * mechanism, not two. `getFunnelCounts` only joins contacts when a filter is
 * active, so under mode `all` it counts transitions that have no linked contact
 * — backfill snapshots, chiefly. An inner join here would silently drop those
 * and this screen would report fewer leads than the client's own dashboard for
 * exactly the clients who count every lead.
 */
function bookLeadPredicate(): SQL {
  return sql`(
    w.lead_mode = 'all'
    OR (w.lead_mode IN ('attributed', 'either') AND c.meta_campaign_id IS NOT NULL)
    OR (w.lead_mode IN ('tagged', 'either') AND c.tags @> ARRAY[w.lead_tag]::text[])
    OR c.google_campaign_id IS NOT NULL
    OR c.gclid IS NOT NULL
  )`;
}

/**
 * Every client's spend, funnel and revenue for both buckets, in three queries.
 *
 * Three rather than three-per-client. A book of fifty clients loaded by calling
 * the per-client helpers would be two hundred round trips, and the Neon pool
 * has already demonstrated on this codebase that one failure among many
 * concurrent queries takes its neighbours down with the connection.
 */
export async function getBookAggregates(
  windows: readonly BookWindow[],
): Promise<BookAggregate[]> {
  if (windows.length === 0) return [];
  const w = bookWindows(windows);
  const paid = bookLeadPredicate();

  const [spendRows, funnelRows, revenueRows] = await Promise.all([
    /*
     * UNION ALL rather than two LEFT JOINs in one SELECT: joining both metric
     * tables to the same window row multiplies them together, and a client with
     * 30 Meta days and 30 Google days would report 900 days of each.
     *
     * `level = 'campaign'` matches `getAdTotals`. Ad-level rows report the same
     * money one level down; counting both doubles every account's spend.
     */
    /*
     * 🔴 Three branches, because the book's spend must be ALL of a client's
     * spend.
     *
     * TikTok was missing from this union, and the shape of that bug is the
     * dangerous one: leads come from `stage_transitions`, which is
     * platform-agnostic, so a TikTok client contributed its leads to the book
     * while contributing none of its spend. The portfolio cost per lead came
     * out *lower* than the truth — a client that was actually expensive read as
     * the efficient one, and the number was perfectly plausible. Under-reported
     * spend flatters, which is why it goes unquestioned.
     */
    db.execute<{
      client_id: string;
      bucket: BookBucket;
      meta_spend: number;
      google_spend: number;
      tiktok_spend: number;
    }>(sql`
      WITH ${w},
      parts AS (
        SELECT w.client_id, w.bucket,
               COALESCE(SUM(m.spend), 0)::float AS meta_spend,
               0::float                         AS google_spend,
               0::float                         AS tiktok_spend
        FROM w
        LEFT JOIN fb_daily_metrics m
          ON m.client_id = w.client_id
         AND m.level = 'campaign'
         AND m.date >= w.start_key AND m.date <= w.end_key
        GROUP BY w.client_id, w.bucket
        UNION ALL
        SELECT w.client_id, w.bucket,
               0::float,
               COALESCE(SUM(g.spend), 0)::float,
               0::float
        FROM w
        LEFT JOIN google_daily_metrics g
          ON g.client_id = w.client_id
         AND g.date >= w.start_key AND g.date <= w.end_key
        GROUP BY w.client_id, w.bucket
        UNION ALL
        -- No level filter here, unlike Meta: tiktok_daily_metrics holds
        -- campaign rows only, so there is no ad-level duplicate to exclude.
        SELECT w.client_id, w.bucket,
               0::float,
               0::float,
               COALESCE(SUM(t.spend), 0)::float
        FROM w
        LEFT JOIN tiktok_daily_metrics t
          ON t.client_id = w.client_id
         AND t.date >= w.start_key AND t.date <= w.end_key
        GROUP BY w.client_id, w.bucket
      )
      SELECT client_id,
             bucket,
             SUM(meta_spend)::float   AS meta_spend,
             SUM(google_spend)::float AS google_spend,
             SUM(tiktok_spend)::float AS tiktok_spend
      FROM parts
      GROUP BY client_id, bucket
    `),

    // COUNT(DISTINCT opportunity_id), exactly as `getFunnelCounts` — a lead
    // bounced in and out of a stage is one appointment, not several.
    db.execute<{
      client_id: string;
      bucket: BookBucket;
      stage: string;
      count: number;
    }>(sql`
      WITH ${w}
      SELECT w.client_id, w.bucket, st.to_canonical AS stage,
             COUNT(DISTINCT st.opportunity_id)::int AS count
      FROM w
      JOIN stage_transitions st
        ON st.client_id = w.client_id
       AND st.changed_at >= w.start_utc
       AND st.changed_at <  w.end_utc
       AND st.to_canonical IS NOT NULL
      LEFT JOIN contacts c ON c.id = st.contact_id
      WHERE ${paid}
      GROUP BY w.client_id, w.bucket, st.to_canonical
    `),

    db.execute<{
      client_id: string;
      bucket: BookBucket;
      won_opps: number;
      won_with_value: number;
      revenue: number;
    }>(sql`
      WITH ${w},
      won AS (
        SELECT DISTINCT w.client_id, w.bucket, o.id, o.monetary_value
        FROM w
        JOIN stage_transitions st
          ON st.client_id = w.client_id
         AND st.changed_at >= w.start_utc
         AND st.changed_at <  w.end_utc
         AND st.to_canonical = 'closed_won'
        JOIN opportunities o ON o.id = st.opportunity_id
        LEFT JOIN contacts c ON c.id = st.contact_id
        WHERE ${paid}
      )
      SELECT client_id, bucket,
             COUNT(*)::int                                       AS won_opps,
             COUNT(*) FILTER (WHERE monetary_value > 0)::int     AS won_with_value,
             COALESCE(SUM(monetary_value), 0)::float             AS revenue
      FROM won
      GROUP BY client_id, bucket
    `),
  ]);

  const out = new Map<string, BookAggregate>();
  const at = (clientId: string, bucket: BookBucket): BookAggregate => {
    const k = `${clientId}:${bucket}`;
    let v = out.get(k);
    if (!v) {
      v = {
        clientId,
        bucket,
        metaSpend: 0,
        googleSpend: 0,
        tiktokSpend: 0,
        funnel: { ...EMPTY_FUNNEL },
        revenue: { ...EMPTY_REVENUE },
      };
      out.set(k, v);
    }
    return v;
  };

  for (const r of resultRows<{
    client_id: string;
    bucket: BookBucket;
    meta_spend: number;
    google_spend: number;
    tiktok_spend: number;
  }>(spendRows)) {
    const a = at(r.client_id, r.bucket);
    a.metaSpend = Number(r.meta_spend) || 0;
    a.googleSpend = Number(r.google_spend) || 0;
    a.tiktokSpend = Number(r.tiktok_spend) || 0;
  }

  for (const r of resultRows<{
    client_id: string;
    bucket: BookBucket;
    stage: string;
    count: number;
  }>(funnelRows)) {
    if (!r.stage) continue;
    const a = at(r.client_id, r.bucket);
    a.funnel[r.stage as keyof FunnelCounts] = Number(r.count) || 0;
  }

  for (const r of resultRows<{
    client_id: string;
    bucket: BookBucket;
    won_opps: number;
    won_with_value: number;
    revenue: number;
  }>(revenueRows)) {
    const a = at(r.client_id, r.bucket);
    a.revenue = {
      wonOpps: Number(r.won_opps) || 0,
      wonWithValue: Number(r.won_with_value) || 0,
      revenue: Number(r.revenue) || 0,
    };
  }

  return [...out.values()];
}

/**
 * Google account currencies per client.
 *
 * Meta, Google and TikTok spend are added together per client on the book
 * screen, which is only sound when they are priced the same. Cheap enough to
 * always ask, and a mismatch is the kind of thing nobody notices until a
 * quarterly number is wrong by the exchange rate.
 */
export async function getGoogleCurrencies(
  clientIds: readonly string[],
): Promise<Map<string, string[]>> {
  return accountCurrencies(clientIds, "google_ad_accounts");
}

/** The same, for TikTok advertisers. See `getGoogleCurrencies`. */
export async function getTiktokCurrencies(
  clientIds: readonly string[],
): Promise<Map<string, string[]>> {
  return accountCurrencies(clientIds, "tiktok_ad_accounts");
}

/**
 * Shared body of the two above.
 *
 * 🔴 `table` is a literal union, never a string, and never caller input — it is
 * interpolated raw because Postgres cannot parameterise a table name. Widening
 * that type is how this becomes an injection point, so it must stay closed.
 */
async function accountCurrencies(
  clientIds: readonly string[],
  table: "google_ad_accounts" | "tiktok_ad_accounts",
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (clientIds.length === 0) return out;

  const rows = await db.execute<{ client_id: string; currencies: string[] }>(sql`
    SELECT client_id,
           ARRAY_AGG(DISTINCT currency) AS currencies
    FROM ${sql.raw(table)}
    WHERE client_id IN (${sql.join(
      clientIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})
      AND currency IS NOT NULL
      AND status = 'active'
    GROUP BY client_id
  `);
  for (const r of resultRows<{ client_id: string; currencies: string[] }>(rows)) {
    out.set(r.client_id, Array.isArray(r.currencies) ? r.currencies : []);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Stage lag — how far apart the numerator and denominator really are
 * ------------------------------------------------------------------ */

/** Median days from a lead arriving to reaching each deeper stage. */
export type StageLagResult = {
  lag: Partial<Record<CanonicalStage, number | null>>;
  /** Opportunities whose lead transition is a backfill, so unmeasurable. */
  excludedBackfill: number;
};

/**
 * How old are the conversions in this window?
 *
 * Cost per closed deal divides THIS period's spend by deals whose leads arrived
 * earlier — sometimes much earlier — and the mismatch grows with every stage
 * down the funnel. Without a number the caveat is a shrug; with one it is
 * actionable ("closes here came from leads a median of 34 days old, so this
 * divides recent spend against older leads").
 *
 * 🔴 **Backfill rows are excluded from the LEAD side only, and the asymmetry is
 * deliberate.** The GHL backfill writes one synthetic transition per
 * pre-existing opportunity, stamped with `lastStageChangeAt`.
 *
 * As a *lead* date that is wrong and dangerous: for an opportunity sitting in
 * `new_lead`, `lastStageChangeAt` is when it last moved, not when the lead
 * arrived, so measuring from it reports a same-day sales cycle for a business
 * whose real one is six weeks. Those rows are therefore kept out of
 * `first_lead`, and counted in `excludedBackfill` so a client whose history is
 * mostly backfill can be told the lag is unmeasurable rather than shown a
 * confident zero.
 *
 * As a *destination* date it is correct, and excluding it would throw away real
 * measurements. `lastStageChangeAt` is the one true timestamp GHL exposes — it
 * is the entire reason the backfill exists — so an opportunity backfilled into
 * `appointment_booked`, whose lead arrived by webhook earlier, is a genuine
 * observation of how long that booking took. (The pairing cannot go wrong in
 * the other direction: a backfilled lead is already absent from `first_lead`,
 * so no synthetic-to-synthetic pair can form.)
 */
export async function getStageLag(
  clientId: string,
  window: DateWindow,
  filter: PaidLeadFilter = DEFAULT_LEAD_FILTER,
  platform: AdPlatform = "meta",
): Promise<StageLagResult> {
  const paid = platformLeadPredicate(platform, filter);

  const rows = await db.execute<{
    stage: string;
    n: number;
    median_days: number | null;
  }>(sql`
    WITH first_lead AS (
      /*
       * MIN, not MAX. A lead that went cold and re-entered the pipeline was
       * still bought by the FIRST click, and that is the date the spend
       * happened — which is the whole question this measurement answers.
       *
       * client_id here is a performance bound, not a tenancy guard, and it is
       * worth being precise about which: opportunity_id is a uuid primary key
       * so an opportunity belongs to exactly one client and the join below
       * cannot cross tenants with or without it. Removing it would still be
       * wrong — the CTE would scan every client's ledger — but it would be a
       * slow query, not a leak.
       */
      SELECT opportunity_id, MIN(changed_at) AS at
      FROM stage_transitions
      WHERE client_id = ${clientId}
        AND to_canonical = 'new_lead'
        AND source <> 'backfill_snapshot'
      GROUP BY opportunity_id
    )
    SELECT st.to_canonical AS stage,
           COUNT(*)::int   AS n,
           PERCENTILE_CONT(0.5) WITHIN GROUP (
             ORDER BY EXTRACT(EPOCH FROM (st.changed_at - fl.at)) / 86400.0
           )               AS median_days
    FROM stage_transitions st
    JOIN first_lead fl ON fl.opportunity_id = st.opportunity_id
    ${paid ? sql`JOIN contacts c ON c.id = st.contact_id` : sql``}
    WHERE st.client_id = ${clientId}
      AND st.changed_at >= ${window.startUtc}
      AND st.changed_at <  ${window.endUtc}
      AND st.to_canonical IN ('appointment_booked', 'showed', 'closed_won')
      AND st.changed_at >= fl.at
      ${paid ? sql`AND ${paid}` : sql``}
    GROUP BY st.to_canonical
  `);

  const lag: Partial<Record<CanonicalStage, number | null>> = {};
  for (const r of resultRows<{ stage: string; n: number; median_days: number | null }>(
    rows,
  )) {
    /*
     * Below three observations a median is one arbitrary opportunity's sales
     * cycle wearing a statistic's clothes. Null, and the caveat says so.
     */
    lag[r.stage as CanonicalStage] =
      Number(r.n) >= 3 && r.median_days !== null ? Number(r.median_days) : null;
  }

  const [excluded] = await db.execute<{ count: number }>(sql`
    SELECT COUNT(DISTINCT opportunity_id)::int AS count
    FROM stage_transitions
    WHERE client_id = ${clientId}
      AND to_canonical = 'new_lead'
      AND source = 'backfill_snapshot'
  `).then((r) => resultRows<{ count: number }>(r));

  return { lag, excludedBackfill: Number(excluded?.count) || 0 };
}

/**
 * Which canonical stages have at least one GHL stage bound to them.
 *
 * 🔴 The difference between "nobody showed up" and "nothing can ever be counted
 * as a show" is the difference between a business result and a broken
 * configuration, and the source spreadsheet reported `SHOWN = 0` for its entire
 * history without anyone being able to tell which it was.
 */
/* ------------------------------------------------------------------ *
 * Speed to lead → outcome — the join neither half could make alone
 * ------------------------------------------------------------------ */

/**
 * Every trackable lead in the window, with its response time and what became
 * of it.
 *
 * Two things about the shape of this query are load-bearing.
 *
 * **The cohort is defined by arrival, the outcome is not bounded at all.** A
 * lead that arrived in the window and booked three weeks after the window closed
 * still booked because of that lead, so `getFunnelCounts`' "entered this stage
 * during the window" semantics are exactly wrong here — they would count a
 * lead's arrival and then discard its conversion for landing a day late, and the
 * miscount would fall hardest on the most recent leads. Flow-in-window is right
 * for a period report; a cohort follows its members out.
 *
 * **`MIN(changed_at)`, so re-entry cannot inflate anything.** A lead bounced
 * back and forth between stages reaches each one once as far as this is
 * concerned, and the days-to-outcome is measured to the first time it got there.
 *
 * Rows rather than aggregates because every decision above them — maturation,
 * bucketing, the calling window, the contrast — is a judgement worth testing in
 * a pure function rather than burying in SQL. The cohort is one client's leads
 * over one date range; `getLeads` already pulls up to 2,000 on the same page.
 */
export async function getSpeedToLeadOutcomes(
  clientId: string,
  window: DateWindow,
  timezone: string,
  filter: PaidLeadFilter = DEFAULT_LEAD_FILTER,
  platform: AdPlatform = "meta",
): Promise<{
  trackingStartedAt: string | null;
  preTracking: number;
  leads: SpeedOutcomeLead[];
}> {
  const paid = platformLeadPredicate(platform, filter);
  const clauses: SQL[] = [
    sql`c.client_id = ${clientId}`,
    sql`c.ghl_created_at >= ${window.startUtc}`,
    sql`c.ghl_created_at < ${window.endUtc}`,
  ];
  if (paid) clauses.push(paid);
  const where = sql.join(clauses, sql` AND `);

  /*
   * Same cutover as `getSpeedToLead`, and for the same reason: before the first
   * OutboundMessage webhook we had no call visibility, so a lead that arrived
   * earlier has no knowable response time. Including those would fill the
   * "never called" row with leads that were very probably called — the precise
   * inversion of a real finding.
   */
  const tsRes = await db.execute<{ started: string | Date | null }>(sql`
    SELECT MIN(received_at) AS started
    FROM webhook_events
    WHERE client_id = ${clientId} AND event_type = 'OutboundMessage'
  `);
  const startedRaw = resultRows<{ started: string | Date | null }>(tsRes)[0]?.started;
  const trackingStart: Date | null = startedRaw ? new Date(startedRaw) : null;

  if (!trackingStart) {
    const [n] = resultRows<{ n: number }>(
      await db.execute<{ n: number }>(sql`
        SELECT COUNT(*)::int AS n FROM contacts c WHERE ${where}
      `),
    );
    return { trackingStartedAt: null, preTracking: Number(n?.n) || 0, leads: [] };
  }

  type Row = {
    lead_at: string | Date;
    seconds_to_call: number | null;
    arrival_dow: number;
    arrival_hour: number;
    call_dow: number | null;
    call_hour: number | null;
    booked_days: number | null;
    showed_days: number | null;
    won_days: number | null;
  };

  const res = await db.execute<Row>(sql`
    WITH cohort AS (
      SELECT c.id,
             c.ghl_created_at AS lead_at,
             c.first_call_at
      FROM contacts c
      WHERE ${where}
        AND c.ghl_created_at >= ${trackingStart}::timestamptz
    ),
    reached AS (
      /*
       * No window bound on changed_at — the cohort is followed forward out of
       * the range. The lower guard is against clock skew only: a transition
       * stamped before its own contact existed is not an outcome of it.
       */
      SELECT st.contact_id,
             MIN(st.changed_at) FILTER (WHERE st.to_canonical = 'appointment_booked') AS booked_at,
             MIN(st.changed_at) FILTER (WHERE st.to_canonical = 'showed')             AS showed_at,
             MIN(st.changed_at) FILTER (WHERE st.to_canonical = 'closed_won')          AS won_at
      FROM stage_transitions st
      JOIN cohort ch ON ch.id = st.contact_id
      WHERE st.client_id = ${clientId}
        AND st.changed_at >= ch.lead_at
      GROUP BY st.contact_id
    )
    SELECT
      ch.lead_at AS lead_at,
      CASE WHEN ch.first_call_at >= ch.lead_at
           THEN EXTRACT(EPOCH FROM (ch.first_call_at - ch.lead_at)) END AS seconds_to_call,
      EXTRACT(ISODOW FROM ch.lead_at AT TIME ZONE ${timezone})::int AS arrival_dow,
      EXTRACT(HOUR   FROM ch.lead_at AT TIME ZONE ${timezone})::int AS arrival_hour,
      CASE WHEN ch.first_call_at >= ch.lead_at
           THEN EXTRACT(ISODOW FROM ch.first_call_at AT TIME ZONE ${timezone})::int END AS call_dow,
      CASE WHEN ch.first_call_at >= ch.lead_at
           THEN EXTRACT(HOUR   FROM ch.first_call_at AT TIME ZONE ${timezone})::int END AS call_hour,
      EXTRACT(EPOCH FROM (r.booked_at - ch.lead_at)) / 86400.0 AS booked_days,
      EXTRACT(EPOCH FROM (r.showed_at - ch.lead_at)) / 86400.0 AS showed_days,
      EXTRACT(EPOCH FROM (r.won_at    - ch.lead_at)) / 86400.0 AS won_days
    FROM cohort ch
    LEFT JOIN reached r ON r.contact_id = ch.id
    ORDER BY ch.lead_at
  `);

  const leads: SpeedOutcomeLead[] = resultRows<Row>(res).map((r) => {
    const reached: SpeedOutcomeLead["reached"] = {};
    if (r.booked_days !== null) reached.appointment_booked = Number(r.booked_days);
    if (r.showed_days !== null) reached.showed = Number(r.showed_days);
    if (r.won_days !== null) reached.closed_won = Number(r.won_days);
    return {
      leadAt: new Date(r.lead_at).toISOString(),
      secondsToCall: r.seconds_to_call !== null ? Number(r.seconds_to_call) : null,
      arrivalDow: Number(r.arrival_dow),
      arrivalHour: Number(r.arrival_hour),
      callDow: r.call_dow !== null ? Number(r.call_dow) : null,
      callHour: r.call_hour !== null ? Number(r.call_hour) : null,
      reached,
    };
  });

  const [total] = resultRows<{ n: number }>(
    await db.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM contacts c WHERE ${where}
    `),
  );

  return {
    trackingStartedAt: trackingStart.toISOString(),
    preTracking: Math.max(0, (Number(total?.n) || 0) - leads.length),
    leads,
  };
}

/* ------------------------------------------------------------------ *
 * Channel mix — paid against everything else in the pipeline
 * ------------------------------------------------------------------ */

/**
 * The whole pipeline, split by whether we can attribute a lead to paid.
 *
 * 🔴 **Not built on `contacts.source`.** See `channels.ts` for the live check
 * that ruled it out: 93% null, and the values that exist are calendar and staff
 * names, with paid traffic filed under a calendar. The split therefore uses the
 * same paid-lead definition every other figure on the dashboard divides by, and
 * the other side is "everything else" rather than "organic".
 *
 * 🔴 **`splitDefinable` is false when the client's filter mode is `all`.** That
 * mode says every lead in the pipeline counts as paid, which is a legitimate
 * setting and makes this comparison meaningless rather than lopsided —
 * rendering a 100/0 split would be an artefact of configuration presented as a
 * result.
 *
 * The platform's own monthly lead count comes back alongside, because the gap
 * between it and what the CRM matched is what decides whether the split can be
 * believed at all.
 */
export async function getChannelMix(
  clientId: string,
  months: readonly { monthKey: string; startUtc: Date; endUtc: Date }[],
  timezone: string,
  filter: PaidLeadFilter = DEFAULT_LEAD_FILTER,
  platform: AdPlatform = "meta",
): Promise<{ rows: ChannelMonthRow[]; splitDefinable: boolean }> {
  const empty = { rows: [], splitDefinable: false };
  if (months.length === 0) return empty;

  const paid = platformLeadPredicate(platform, filter);
  if (!paid) return empty;

  const first = months.reduce((a, m) => (m.startUtc < a ? m.startUtc : a), months[0].startUtc);
  const last = months.reduce((a, m) => (m.endUtc > a ? m.endUtc : a), months[0].endUtc);
  const monthOf = (col: SQL) => sql`to_char(${col} AT TIME ZONE ${timezone}, 'YYYY-MM')`;

  const byMonth = new Map<string, ChannelMonthRow>();
  const row = (m: string): ChannelMonthRow => {
    let r = byMonth.get(m);
    if (!r) {
      r = {
        month: m,
        spend: null,
        platformLeads: null,
        paidLeads: 0,
        otherLeads: 0,
        paidAppointments: 0,
        otherAppointments: 0,
        paidWon: 0,
        otherWon: 0,
      };
      byMonth.set(m, r);
    }
    return r;
  };

  const leadRes = await db.execute<{ month: string; is_paid: boolean; n: number }>(sql`
    SELECT ${monthOf(sql`c.ghl_created_at`)} AS month,
           (${paid}) AS is_paid,
           COUNT(*)::int AS n
    FROM contacts c
    WHERE c.client_id = ${clientId}
      AND c.ghl_created_at >= ${first}
      AND c.ghl_created_at <  ${last}
    GROUP BY 1, 2
  `);
  for (const r of resultRows<{ month: string; is_paid: boolean; n: number }>(leadRes)) {
    const t = row(r.month);
    if (r.is_paid) t.paidLeads += Number(r.n) || 0;
    else t.otherLeads += Number(r.n) || 0;
  }

  /*
   * COUNT(DISTINCT opportunity_id), matching `getFunnelCounts` exactly. A lead
   * bounced out of a stage and back would otherwise book twice, and the two
   * panels would disagree about the same month.
   */
  const stageRes = await db.execute<{
    month: string;
    is_paid: boolean;
    stage: string;
    n: number;
  }>(sql`
    SELECT ${monthOf(sql`st.changed_at`)} AS month,
           (${paid}) AS is_paid,
           st.to_canonical AS stage,
           COUNT(DISTINCT st.opportunity_id)::int AS n
    FROM stage_transitions st
    JOIN contacts c ON c.id = st.contact_id
    WHERE st.client_id = ${clientId}
      AND st.changed_at >= ${first}
      AND st.changed_at <  ${last}
      AND st.to_canonical IN ('appointment_booked', 'closed_won')
    GROUP BY 1, 2, 3
  `);
  for (const r of resultRows<{
    month: string;
    is_paid: boolean;
    stage: string;
    n: number;
  }>(stageRes)) {
    const t = row(r.month);
    const n = Number(r.n) || 0;
    if (r.stage === "appointment_booked") {
      if (r.is_paid) t.paidAppointments += n;
      else t.otherAppointments += n;
    } else if (r.is_paid) t.paidWon += n;
    else t.otherWon += n;
  }

  /*
   * Spend and the platform's OWN lead count. Left null where no ad row exists
   * for the month — the gap-versus-zero distinction: "we have no data for
   * March" is not "nothing was spent in March", and the baseline calculation
   * downstream depends on telling them apart.
   */
  const adRes =
    platform === "google"
      ? await db.execute<{ month: string; spend: number; leads: number }>(sql`
          SELECT to_char(date, 'YYYY-MM') AS month,
                 SUM(spend)::float AS spend,
                 SUM(conversions)::float AS leads
          FROM google_daily_metrics
          WHERE client_id = ${clientId} AND date >= ${first} AND date < ${last}
          GROUP BY 1
        `)
      : platform === "tiktok"
      ? await db.execute<{ month: string; spend: number; leads: number }>(sql`
          SELECT to_char(date, 'YYYY-MM') AS month,
                 SUM(spend)::float AS spend,
                 SUM(conversions)::float AS leads
          FROM tiktok_daily_metrics
          WHERE client_id = ${clientId} AND date >= ${first} AND date < ${last}
          GROUP BY 1
        `)
      : await db.execute<{ month: string; spend: number; leads: number }>(sql`
          SELECT to_char(date, 'YYYY-MM') AS month,
                 SUM(spend)::float AS spend,
                 SUM(leads_total)::float AS leads
          FROM fb_daily_metrics
          WHERE client_id = ${clientId}
            AND level = 'campaign'
            AND date >= ${first} AND date < ${last}
          GROUP BY 1
        `);
  for (const r of resultRows<{ month: string; spend: number; leads: number }>(adRes)) {
    const t = row(r.month);
    t.spend = Number(r.spend) || 0;
    t.platformLeads = Math.round(Number(r.leads) || 0);
  }

  // Every requested month appears, including the silent ones — a month absent
  // from the table would look like a month that never happened.
  for (const m of months) row(m.monthKey);

  return { rows: [...byMonth.values()], splitDefinable: true };
}

/* ------------------------------------------------------------------ *
 * Cohort maturation — how a month's conversions fill in over time
 * ------------------------------------------------------------------ */

/**
 * Monthly lead cohorts and every conversion they later produced, by age.
 *
 * Two departures from the rest of the query layer, both deliberate.
 *
 * **The cohort is the arrival month; the outcome is unbounded.** A lead that
 * arrived in June and closed in September belongs to June and is measured at 92
 * days old. Bounding conversions to their own month — which is what every
 * month-on-month table in this product correctly does — would produce exactly
 * the reading this module exists to correct.
 *
 * **One row per conversion, not per lead.** The pure engine needs the age of
 * every conversion, and conversions are an order of magnitude scarcer than
 * leads: GG has 1,700 leads against 131 appointments and 64 closes across its
 * whole history. Aggregating in SQL would move the maturation judgement out of
 * a testable function to save nothing.
 */
export async function getCohortMaturation(
  clientId: string,
  months: readonly { monthKey: string; startUtc: Date; endUtc: Date }[],
  timezone: string,
  filter: PaidLeadFilter = DEFAULT_LEAD_FILTER,
  platform: AdPlatform = "meta",
): Promise<{
  leadsByMonth: Map<string, number>;
  conversions: { month: string; stage: CanonicalStage; days: number }[];
}> {
  const leadsByMonth = new Map<string, number>();
  const conversions: { month: string; stage: CanonicalStage; days: number }[] = [];
  if (months.length === 0) return { leadsByMonth, conversions };

  const paid = platformLeadPredicate(platform, filter);
  const first = months.reduce((a, m) => (m.startUtc < a ? m.startUtc : a), months[0].startUtc);
  const last = months.reduce((a, m) => (m.endUtc > a ? m.endUtc : a), months[0].endUtc);

  const clauses: SQL[] = [
    sql`c.client_id = ${clientId}`,
    sql`c.ghl_created_at >= ${first}`,
    sql`c.ghl_created_at < ${last}`,
  ];
  if (paid) clauses.push(paid);
  const where = sql.join(clauses, sql` AND `);

  // The month a lead belongs to is the month it arrived in the CLIENT's
  // timezone — the same convention `trailingMonths` uses to build the windows,
  // or a lead arriving at 5pm on the 31st lands in the wrong cohort.
  const monthExpr = sql`to_char(c.ghl_created_at AT TIME ZONE ${timezone}, 'YYYY-MM')`;

  const leadRes = await db.execute<{ month: string; n: number }>(sql`
    SELECT ${monthExpr} AS month, COUNT(*)::int AS n
    FROM contacts c
    WHERE ${where}
    GROUP BY 1
  `);
  for (const r of resultRows<{ month: string; n: number }>(leadRes)) {
    leadsByMonth.set(r.month, Number(r.n) || 0);
  }

  const convRes = await db.execute<{ month: string; stage: string; days: number }>(sql`
    WITH cohort AS (
      SELECT c.id, c.ghl_created_at AS lead_at, ${monthExpr} AS month
      FROM contacts c
      WHERE ${where}
    ),
    reached AS (
      -- MIN, so a lead bounced back into a stage is measured to the first time
      -- it got there. No upper bound on changed_at: the cohort is followed
      -- forward, which is the entire point.
      SELECT st.contact_id, st.to_canonical AS stage, MIN(st.changed_at) AS at
      FROM stage_transitions st
      JOIN cohort ch ON ch.id = st.contact_id
      WHERE st.client_id = ${clientId}
        AND st.changed_at >= ch.lead_at
        AND st.to_canonical IN ('appointment_booked', 'showed', 'closed_won')
      GROUP BY st.contact_id, st.to_canonical
    )
    SELECT ch.month AS month,
           r.stage  AS stage,
           EXTRACT(EPOCH FROM (r.at - ch.lead_at)) / 86400.0 AS days
    FROM reached r
    JOIN cohort ch ON ch.id = r.contact_id
  `);
  for (const r of resultRows<{ month: string; stage: string; days: number }>(convRes)) {
    conversions.push({
      month: r.month,
      stage: r.stage as CanonicalStage,
      days: Number(r.days),
    });
  }

  return { leadsByMonth, conversions };
}

/* ------------------------------------------------------------------ *
 * Stage aging — how long leads have been sitting where they are
 * ------------------------------------------------------------------ */

/**
 * Completed stays plus everything sitting right now, for `buildAging`.
 *
 * Current-state, so it takes no date window — like the pipeline distribution it
 * sits beside. "Which leads are rotting" is not a question about last month.
 *
 * 🔴 **Runs of the same canonical stage are collapsed into one stay.** GG's
 * pipeline maps eight different GHL stages to `new_lead` and six to
 * `appointment_booked`, so an opportunity shuffled between two of them produces
 * two ledger rows and never actually left the canonical stage. Measured
 * naively, each shuffle becomes a short completed stay, the 90th percentile
 * collapses toward zero, and the panel flags the entire pipeline as overdue.
 *
 * Backfill rows are kept, and unlike the lead-date case that is correct: the
 * backfill stamps `lastStageChangeAt`, which is by definition when the
 * opportunity entered the stage it is in — exactly the quantity being measured.
 */
export async function getStageAging(
  clientId: string,
  filter: PaidLeadFilter = DEFAULT_LEAD_FILTER,
  platform: AdPlatform = "meta",
): Promise<{ dwells: DwellObservation[]; sitting: SittingOpportunity[] }> {
  const paid = platformLeadPredicate(platform, filter);
  const col = campaignIdColumn(platform);

  const dwellRes = await db.execute<{ stage: string; days: number }>(sql`
    WITH tagged AS (
      SELECT st.opportunity_id,
             st.to_canonical AS stage,
             st.changed_at,
             LAG(st.to_canonical) OVER (
               PARTITION BY st.opportunity_id ORDER BY st.changed_at, st.id
             ) AS prev_stage
      FROM stage_transitions st
      ${paid ? sql`JOIN contacts c ON c.id = st.contact_id` : sql``}
      WHERE st.client_id = ${clientId}
        AND st.to_canonical IS NOT NULL
        ${paid ? sql`AND ${paid}` : sql``}
    ),
    entries AS (
      -- One row per STAY, not per transition: the first row of each run.
      SELECT opportunity_id, stage, changed_at
      FROM tagged
      WHERE prev_stage IS DISTINCT FROM stage
    )
    SELECT stage,
           EXTRACT(EPOCH FROM (
             LEAD(changed_at) OVER (PARTITION BY opportunity_id ORDER BY changed_at)
             - changed_at
           )) / 86400.0 AS days
    FROM entries
  `);

  const dwells: DwellObservation[] = [];
  for (const r of resultRows<{ stage: string; days: number | null }>(dwellRes)) {
    // The last run of every opportunity has no next entry — that is the stay
    // still in progress, and counting it as completed at zero days would drag
    // every threshold to nothing.
    if (r.days === null) continue;
    dwells.push({ stage: r.stage as CanonicalStage, days: Number(r.days) });
  }

  const clauses: SQL[] = [
    sql`o.client_id = ${clientId}`,
    // Null status is treated as open. GHL does not always send one, and the
    // safe direction is showing a lead that turns out to be closed rather than
    // hiding one that is genuinely rotting.
    sql`(o.status IS NULL OR o.status = 'open')`,
  ];
  if (paid) clauses.push(paid);

  type Row = {
    id: string;
    name: string | null;
    canonical: string | null;
    stage_name: string | null;
    days_in_stage: number | null;
    value: number | null;
    campaign_id: string | null;
    campaign_name: string | null;
    ever_called: boolean | null;
  };

  const res = await db.execute<Row>(sql`
    WITH tracking AS (
      SELECT MIN(received_at) AS started
      FROM webhook_events
      WHERE client_id = ${clientId} AND event_type = 'OutboundMessage'
    ),
    last_move AS (
      SELECT opportunity_id, MAX(changed_at) AS at
      FROM stage_transitions
      WHERE client_id = ${clientId}
      GROUP BY opportunity_id
    )
    SELECT o.id::text AS id,
           COALESCE(
             NULLIF(TRIM(o.name), ''),
             NULLIF(TRIM(CONCAT(c.first_name, ' ', c.last_name)), ''),
             c.email,
             c.phone
           ) AS name,
           ps.canonical_stage AS canonical,
           ps.ghl_stage_name  AS stage_name,
           /*
            * last_stage_change_at is authoritative — re-read from the REST API
            * because the webhook carries no event time — but it is nullable,
            * and a null there is not "entered the stage today". The ledger's
            * own last transition is the fallback; with neither, the lead is
            * reported as undatable rather than assigned an age.
            */
           EXTRACT(EPOCH FROM (
             now() - COALESCE(o.last_stage_change_at, lm.at)
           )) / 86400.0 AS days_in_stage,
           o.monetary_value::float AS value,
           ${col} AS campaign_id,
           c.utm_campaign AS campaign_name,
           CASE
             WHEN t.started IS NULL THEN NULL
             WHEN c.ghl_created_at IS NULL OR c.ghl_created_at < t.started THEN NULL
             ELSE (c.first_call_at IS NOT NULL)
           END AS ever_called
    FROM opportunities o
    CROSS JOIN tracking t
    ${paid ? sql`JOIN` : sql`LEFT JOIN`} contacts c ON c.id = o.contact_id
    LEFT JOIN pipeline_stages ps ON ps.id = o.current_stage_id
    LEFT JOIN last_move lm ON lm.opportunity_id = o.id
    WHERE ${sql.join(clauses, sql` AND `)}
  `);

  const sitting: SittingOpportunity[] = resultRows<Row>(res).map((r) => ({
    opportunityId: r.id,
    name: r.name,
    stage: (r.canonical as CanonicalStage | null) ?? null,
    ghlStageName: r.stage_name,
    daysInStage: r.days_in_stage !== null ? Number(r.days_in_stage) : null,
    value: r.value !== null ? Number(r.value) : null,
    campaignId: r.campaign_id,
    campaignName: r.campaign_name,
    everCalled: r.ever_called === null ? null : Boolean(r.ever_called),
  }));

  return { dwells, sitting };
}

/* ------------------------------------------------------------------ *
 * Uncalled leads — the call list
 * ------------------------------------------------------------------ */

/**
 * Every trackable lead with no recorded outbound call, plus what the panel
 * needs to decide which of them is actually a task.
 *
 * Three things here exist only because a live check said they had to.
 *
 * **🔴 Message direction comes from `webhook_events`, not `contacts`.**
 * `first_touch_at` is written by both the Inbound and Outbound message handlers,
 * so it cannot distinguish "we texted them" from "they texted us and nobody
 * replied" — and those two rank at opposite ends of a call list. The raw log
 * kept both, which is the case the log was built for.
 *
 * **🔴 An outbound CALL event also counts as called, even if `first_call_at` is
 * null.** `recordMessageTouch` returns `contactMatched: false` when a call
 * webhook arrives for a contact this database has not seen yet — the column is
 * never written and the lead looks unphoned forever. Rare, and exactly the
 * failure a call list cannot survive, so the predicate below mirrors the
 * processor's own (`messageType = CALL`, `direction = outbound`) against the
 * log. The permanent fix belongs in the processor; this stops the list being
 * wrong in the meantime.
 *
 * **Both sides of the paid-lead filter are returned.** The engine partitions
 * them, so the "and N more outside the filter" line is measured by the same
 * standard as the list rather than a looser count run separately.
 */
export async function getUncalledLeads(
  clientId: string,
  timezone: string,
  filter: PaidLeadFilter = DEFAULT_LEAD_FILTER,
  platform: AdPlatform = "meta",
): Promise<{
  leads: UncalledLead[];
  callWeekdays: CallWeekday[];
  trackingStartedAt: string | null;
  preTracking: number;
  costPerLead: number | null;
}> {
  const paid = platformLeadPredicate(platform, filter);
  const col = campaignIdColumn(platform);
  // Mode `all` makes every lead paid, so there is no "outside the filter" side.
  const isPaid = paid ?? sql`TRUE`;

  const tsRes = await db.execute<{ started: string | Date | null }>(sql`
    SELECT MIN(received_at) AS started
    FROM webhook_events
    WHERE client_id = ${clientId} AND event_type = 'OutboundMessage'
  `);
  const startedRaw = resultRows<{ started: string | Date | null }>(tsRes)[0]?.started;
  const trackingStart: Date | null = startedRaw ? new Date(startedRaw) : null;

  if (!trackingStart) {
    // No call has ever been observed for this client, so nothing is knowable and
    // every paid lead is pre-tracking. Reported as such, never as "never called".
    const [n] = resultRows<{ n: number }>(
      await db.execute<{ n: number }>(sql`
        SELECT COUNT(*)::int AS n
        FROM contacts c
        WHERE c.client_id = ${clientId} ${paid ? sql`AND ${paid}` : sql``}
      `),
    );
    return {
      leads: [],
      callWeekdays: [],
      trackingStartedAt: null,
      preTracking: Number(n?.n) || 0,
      costPerLead: null,
    };
  }

  /*
   * Not paid-filtered, deliberately: the weekdays a team makes calls on is a
   * fact about the team, not about the advertised subset of their pipeline.
   * Filtering would shrink the sample below the measurement floor for no gain.
   */
  const dowRes = await db.execute<{ dow: number; calls: number }>(sql`
    SELECT EXTRACT(ISODOW FROM c.first_call_at AT TIME ZONE ${timezone})::int AS dow,
           COUNT(*)::int AS calls
    FROM contacts c
    WHERE c.client_id = ${clientId} AND c.first_call_at IS NOT NULL
    GROUP BY 1
  `);
  const callWeekdays = resultRows<{ dow: number; calls: number }>(dowRes).map((r) => ({
    dow: Number(r.dow),
    calls: Number(r.calls),
  }));

  /*
   * A contact with no `ghl_created_at` is counted as pre-tracking too. It cannot
   * be dated at all — on this deployment 1,402 of 1,604 contacts arrived by
   * import — and an undatable lead has no clock to judge it by.
   */
  const [pre] = resultRows<{ n: number }>(
    await db.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n
      FROM contacts c
      WHERE c.client_id = ${clientId}
        AND (c.ghl_created_at IS NULL OR c.ghl_created_at < ${trackingStart}::timestamptz)
        ${paid ? sql`AND ${paid}` : sql``}
    `),
  );

  type Row = {
    contact_id: string;
    opportunity_id: string | null;
    name: string | null;
    phone: string | null;
    lead_at: string | Date;
    days_since_date: number;
    lead_dow: number;
    is_paid: boolean;
    canonical: string | null;
    stage_name: string | null;
    no_opportunity: boolean;
    has_inbound: boolean;
    has_outbound: boolean;
    campaign_id: string | null;
    campaign_name: string | null;
    value: number | null;
  };

  const res = await db.execute<Row>(sql`
    WITH msgs AS (
      SELECT payload->>'contactId' AS ghl_id,
             bool_or(event_type = 'InboundMessage')  AS has_inbound,
             bool_or(event_type = 'OutboundMessage') AS has_outbound,
             -- Mirrors recordMessageTouch's own predicate exactly.
             bool_or(
               event_type = 'OutboundMessage'
               AND upper(payload->>'messageType') = 'CALL'
               AND payload->>'direction' = 'outbound'
             ) AS has_call
      FROM webhook_events
      WHERE client_id = ${clientId}
        AND event_type IN ('InboundMessage', 'OutboundMessage')
        AND payload->>'contactId' IS NOT NULL
      GROUP BY 1
    ),
    opp AS (
      /*
       * The FURTHEST-ALONG opportunity, not the most recent. A contact with two
       * opportunities where one is already booked is a handled person, and
       * picking by recency would put them on the call list whenever the stale
       * one was touched last. The depths below exist only to order rows; the
       * engine decides what each stage means.
       */
      SELECT DISTINCT ON (o.contact_id)
             o.contact_id,
             o.id::text AS opportunity_id,
             o.name AS opp_name,
             o.monetary_value::float AS value,
             ps.canonical_stage AS canonical,
             ps.ghl_stage_name  AS stage_name
      FROM opportunities o
      LEFT JOIN pipeline_stages ps ON ps.id = o.current_stage_id
      WHERE o.client_id = ${clientId}
      ORDER BY o.contact_id,
               /*
                * 🔴 Compared as TEXT, not against the enum.
                *
                * Found by running this against the live database: its
                * canonical_stage enum still has seven values because the
                * migration adding disqualified has not been pushed, and
                * naming an absent label makes Postgres reject the whole
                * statement — "invalid input value for enum". Every other query
                * here that mentions disqualified is guarded behind a count
                * that can only be non-zero once the value exists; this one runs
                * on every dashboard load, so it would take the page down for
                * the entire window between deploying code and migrating.
                *
                * A cast costs nothing: this expression only orders rows, and
                * the enum's own ordering is not what it wants anyway.
                */
               CASE ps.canonical_stage::text
                 WHEN 'closed_won' THEN 6 WHEN 'lost' THEN 6 WHEN 'disqualified' THEN 6
                 WHEN 'showed' THEN 5 WHEN 'no_show' THEN 5
                 WHEN 'appointment_booked' THEN 4
                 WHEN 'contacted' THEN 2
                 WHEN 'new_lead' THEN 1
                 ELSE 0
               END DESC,
               o.updated_at DESC NULLS LAST
    )
    SELECT c.id::text AS contact_id,
           opp.opportunity_id,
           COALESCE(
             NULLIF(TRIM(CONCAT(c.first_name, ' ', c.last_name)), ''),
             NULLIF(TRIM(opp.opp_name), ''),
             c.email,
             NULLIF(TRIM(c.phone), '')
           ) AS name,
           NULLIF(TRIM(c.phone), '') AS phone,
           c.ghl_created_at AS lead_at,
           (
             (now() AT TIME ZONE ${timezone})::date
             - (c.ghl_created_at AT TIME ZONE ${timezone})::date
           )::int AS days_since_date,
           EXTRACT(ISODOW FROM c.ghl_created_at AT TIME ZONE ${timezone})::int AS lead_dow,
           (${isPaid}) AS is_paid,
           opp.canonical AS canonical,
           opp.stage_name AS stage_name,
           (opp.contact_id IS NULL) AS no_opportunity,
           COALESCE(msgs.has_inbound, false)  AS has_inbound,
           COALESCE(msgs.has_outbound, false) AS has_outbound,
           ${col} AS campaign_id,
           c.utm_campaign AS campaign_name,
           opp.value AS value
    FROM contacts c
    LEFT JOIN opp  ON opp.contact_id = c.id
    LEFT JOIN msgs ON msgs.ghl_id = c.ghl_contact_id
    WHERE c.client_id = ${clientId}
      AND c.ghl_created_at >= ${trackingStart}::timestamptz
      AND c.first_call_at IS NULL
      AND COALESCE(msgs.has_call, false) = false
  `);

  const leads: UncalledLead[] = resultRows<Row>(res).map((r) => ({
    contactId: r.contact_id,
    opportunityId: r.opportunity_id,
    name: r.name,
    phone: r.phone,
    leadAt: new Date(r.lead_at).toISOString(),
    daysSinceDate: Number(r.days_since_date),
    leadDow: Number(r.lead_dow),
    isPaid: Boolean(r.is_paid),
    stage: (r.canonical as CanonicalStage | null) ?? null,
    ghlStageName: r.stage_name,
    noOpportunity: Boolean(r.no_opportunity),
    hasInbound: Boolean(r.has_inbound),
    hasOutbound: Boolean(r.has_outbound),
    campaignId: r.campaign_id,
    campaignName: r.campaign_name,
    value: r.value !== null ? Number(r.value) : null,
  }));

  /*
   * Cost per lead over the tracking period specifically — NOT the dashboard's
   * selected range. The list is every uncalled lead since call visibility began,
   * so pricing it with a seven-day CPL would multiply one week's rate by several
   * weeks of leads. Null when either side is missing, never zero.
   */
  const sinceKey = toDateKey(trackingStart, timezone);
  const simpleSpend = simpleAdTable(platform);
  const [spendRow] =
    simpleSpend
      ? await db
          .select({ spend: sql<string | null>`SUM(${simpleSpend.table.spend})` })
          .from(simpleSpend.table)
          .where(
            and(
              eq(simpleSpend.table.clientId, clientId),
              gte(simpleSpend.table.date, sinceKey),
            ),
          )
      : await db
          .select({ spend: sql<string | null>`SUM(${fbDailyMetrics.spend})` })
          .from(fbDailyMetrics)
          .where(
            and(
              eq(fbDailyMetrics.clientId, clientId),
              gte(fbDailyMetrics.date, sinceKey),
              // Ad-level rows repeat their campaign's spend; summing both doubles it.
              eq(fbDailyMetrics.level, "campaign"),
            ),
          );

  const [leadRow] = resultRows<{ n: number }>(
    await db.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n
      FROM contacts c
      WHERE c.client_id = ${clientId}
        AND c.ghl_created_at >= ${trackingStart}::timestamptz
        ${paid ? sql`AND ${paid}` : sql``}
    `),
  );

  const spend = spendRow?.spend != null ? Number(spendRow.spend) : null;
  const leadCount = Number(leadRow?.n) || 0;

  return {
    leads,
    callWeekdays,
    trackingStartedAt: trackingStart.toISOString(),
    preTracking: Number(pre?.n) || 0,
    costPerLead: spend !== null && leadCount > 0 ? spend / leadCount : null,
  };
}

/* ------------------------------------------------------------------ *
 * Churn signals — weekly buckets across the whole book
 * ------------------------------------------------------------------ */

/** One client's 7-day bucket, `idx` 0 = oldest. */
export interface ChurnWeekWindow {
  clientId: string;
  idx: number;
  window: DateWindow;
  filter: PaidLeadFilter;
}

export interface ChurnWeekRow {
  clientId: string;
  idx: number;
  spend: number;
  leads: number;
}

/**
 * Spend and paid leads per client per week, plus each client's first and last
 * sign of life.
 *
 * Two queries for the whole book rather than two per client, for the reason
 * `getBookAggregates` gives: a book loaded client-by-client is hundreds of round
 * trips, and one failure among many concurrent queries on the Neon pool takes
 * its neighbours down with the connection.
 *
 * 🔴 **Leads are counted from `contacts.ghl_created_at`, not the ledger.** The
 * roll-up beside this uses `getFunnelCounts`, which counts opportunities
 * entering `new_lead` — correct there, because it is the top of the funnel it
 * also reports the rest of. Here the question is whether lead flow has fallen,
 * and an opportunity is only created when somebody in GHL creates one. A client
 * whose team stopped making opportunity records would read as demand collapsing.
 * Arrival time is the closest thing to a fact about the market.
 */
export async function getChurnWeeks(
  weeks: readonly ChurnWeekWindow[],
): Promise<{
  rows: ChurnWeekRow[];
  firstActivity: Map<string, string>;
  lastWebhook: Map<string, string>;
}> {
  if (weeks.length === 0) {
    return { rows: [], firstActivity: new Map(), lastWebhook: new Map() };
  }

  const values = weeks.map(
    (w) =>
      sql`(${w.clientId}::uuid, ${w.idx}::int, ${w.window.startKey}::date, ${w.window.endKey}::date, ${w.window.startUtc}::timestamptz, ${w.window.endUtc}::timestamptz, ${w.filter.mode}::text, ${w.filter.tag.trim().toLowerCase()}::text)`,
  );
  const wCte = sql`w (client_id, idx, start_key, end_key, start_utc, end_utc, lead_mode, lead_tag) AS (
    VALUES ${sql.join(values, sql`, `)}
  )`;

  type Row = { client_id: string; idx: number; spend: number; leads: number };
  const res = await db.execute<Row>(sql`
    WITH ${wCte},
    parts AS (
      /*
       * UNION ALL, not two joins on one row: joining both metric tables to the
       * same window multiplies them, and a client with 7 Meta days and 7 Google
       * days would report 49 of each. Same trap getBookAggregates documents.
       */
      SELECT w.client_id, w.idx,
             COALESCE(SUM(m.spend), 0)::float AS spend,
             0::int                           AS leads
      FROM w
      LEFT JOIN fb_daily_metrics m
        ON m.client_id = w.client_id
       AND m.level = 'campaign'
       AND m.date >= w.start_key AND m.date <= w.end_key
      GROUP BY w.client_id, w.idx
      UNION ALL
      SELECT w.client_id, w.idx, COALESCE(SUM(g.spend), 0)::float, 0::int
      FROM w
      LEFT JOIN google_daily_metrics g
        ON g.client_id = w.client_id
       AND g.date >= w.start_key AND g.date <= w.end_key
      GROUP BY w.client_id, w.idx
      UNION ALL
      SELECT w.client_id, w.idx, 0::float, COUNT(c.id)::int
      FROM w
      LEFT JOIN contacts c
        ON c.client_id = w.client_id
       AND c.ghl_created_at >= w.start_utc
       AND c.ghl_created_at <  w.end_utc
       AND ${sql`(
             w.lead_mode = 'all'
             OR (w.lead_mode IN ('attributed', 'either') AND c.meta_campaign_id IS NOT NULL)
             OR (w.lead_mode IN ('tagged', 'either') AND c.tags @> ARRAY[w.lead_tag]::text[])
             OR c.google_campaign_id IS NOT NULL
             OR c.gclid IS NOT NULL
           )`}
      GROUP BY w.client_id, w.idx
    )
    SELECT client_id::text AS client_id, idx,
           SUM(spend)::float AS spend,
           SUM(leads)::int   AS leads
    FROM parts
    GROUP BY client_id, idx
  `);

  const ids = [...new Set(weeks.map((w) => w.clientId))];

  /*
   * When did this client first show any sign of life, and when did the CRM last
   * speak? The first is what stops a three-week-old account being reported as
   * one that switched its spend off; the second is what stops a dead webhook
   * being reported as collapsed demand.
   */
  type Life = { client_id: string; first_activity: string | null; last_webhook: string | null };
  const lifeRes = await db.execute<Life>(sql`
    WITH c (id) AS (
      /*
       * The ids arrive as data rather than being read back out of clients.
       * The caller already has them, and every other query in this file is
       * driven the same way — so this one keeps working for a client row that
       * is being created, archived or renamed while the page loads.
       */
      VALUES ${sql.join(ids.map((id) => sql`(${id}::uuid)`), sql`, `)}
    )
    SELECT c.id::text AS client_id,
           /*
            * 🔴 LEAST across BOTH pipes, and it ignores nulls. A client whose
            * CRM was wired months before the ad account would otherwise read as
            * brand new and never be judged at all — the panel going quiet about
            * exactly the accounts that have been running longest.
            */
           LEAST(
             (SELECT MIN(m.date)::timestamptz FROM fb_daily_metrics m WHERE m.client_id = c.id),
             (SELECT MIN(g.date)::timestamptz FROM google_daily_metrics g WHERE g.client_id = c.id),
             (SELECT MIN(e.received_at) FROM webhook_events e WHERE e.client_id = c.id)
           ) AS first_activity,
           (SELECT MAX(e.received_at) FROM webhook_events e WHERE e.client_id = c.id) AS last_webhook
    FROM c
  `);

  const firstActivity = new Map<string, string>();
  const lastWebhook = new Map<string, string>();
  for (const r of resultRows<Life>(lifeRes)) {
    if (r.first_activity) firstActivity.set(r.client_id, new Date(r.first_activity).toISOString());
    if (r.last_webhook) lastWebhook.set(r.client_id, new Date(r.last_webhook).toISOString());
  }

  return {
    rows: resultRows<Row>(res).map((r) => ({
      clientId: r.client_id,
      idx: Number(r.idx),
      spend: Number(r.spend),
      leads: Number(r.leads),
    })),
    firstActivity,
    lastWebhook,
  };
}

export async function getMappedStages(
  clientId: string,
): Promise<Set<CanonicalStage>> {
  const rows = await db.execute<{ canonical_stage: string }>(sql`
    SELECT DISTINCT canonical_stage
    FROM pipeline_stages
    WHERE client_id = ${clientId}
      AND canonical_stage IS NOT NULL
  `);
  return new Set(
    resultRows<{ canonical_stage: string }>(rows).map(
      (r) => r.canonical_stage as CanonicalStage,
    ),
  );
}

/* ------------------------------------------------------------------ *
 * Call timing — §6.19
 * ------------------------------------------------------------------ */

/**
 * Call attempts and lead arrivals, by hour of the client's own day.
 *
 * Two independent counts in one round trip, deliberately UNIONed rather than
 * joined: an hour with arrivals and no calls, and an hour with calls and no
 * arrivals, both have to survive to the engine. A join on hour would drop
 * whichever side was missing, and those are exactly the hours the panel is
 * about.
 *
 * Read from `webhook_events` rather than from `contacts.first_call_at`, for the
 * reason §6.14 needed the raw log: `first_call_at` holds ONE call per contact,
 * and the question here is about every attempt. The log is the only place the
 * later attempts exist.
 */
export async function getCallTiming(
  clientId: string,
  timezone: string,
  window: DateWindow,
): Promise<CallTimingInput[]> {
  type Row = { hr: number; attempts: number; connected: number; arrivals: number };

  const res = await db.execute<Row>(sql`
    WITH calls AS (
      SELECT
        EXTRACT(HOUR FROM (w.received_at AT TIME ZONE ${timezone}))::int AS hr,
        COUNT(*)::int AS attempts,
        /*
         * callStatus is not the signal — on a live account 122 of 123 read
         * 'completed', which says the attempt finished, not that anybody spoke.
         * Duration is. The threshold sits above a voicemail greeting; it is a
         * judgement, and the panel names it rather than implying the phone
         * system reported it.
         */
        COUNT(*) FILTER (
          WHERE (w.payload->>'callDuration') ~ '^[0-9]+$'
            AND (w.payload->>'callDuration')::int >= ${CONNECTED_SECONDS}
        )::int AS connected,
        0 AS arrivals
      FROM webhook_events w
      WHERE w.client_id = ${clientId}
        AND w.event_type = 'OutboundMessage'
        AND upper(w.payload->>'messageType') = 'CALL'
        AND w.payload->>'direction' = 'outbound'
        AND w.received_at >= ${window.startUtc}
        AND w.received_at < ${window.endUtc}
      GROUP BY 1
    ),
    arrivals AS (
      SELECT
        EXTRACT(HOUR FROM (c.ghl_created_at AT TIME ZONE ${timezone}))::int AS hr,
        0 AS attempts,
        0 AS connected,
        COUNT(*)::int AS arrivals
      FROM contacts c
      WHERE c.client_id = ${clientId}
        AND c.ghl_created_at IS NOT NULL
        AND c.ghl_created_at >= ${window.startUtc}
        AND c.ghl_created_at < ${window.endUtc}
      GROUP BY 1
    )
    SELECT hr,
           SUM(attempts)::int  AS attempts,
           SUM(connected)::int AS connected,
           SUM(arrivals)::int  AS arrivals
    FROM (SELECT * FROM calls UNION ALL SELECT * FROM arrivals) u
    GROUP BY hr
    ORDER BY hr
  `);

  return resultRows<Row>(res).map((r) => ({
    hour: Number(r.hr),
    attempts: Number(r.attempts),
    connected: Number(r.connected),
    arrivals: Number(r.arrivals),
  }));
}

/* ------------------------------------------------------------------ *
 * Lead quality cohort — §6.18
 * ------------------------------------------------------------------ */

/**
 * Leads with their arrival attributes and how far each one got.
 *
 * 🔴 **Deliberately NOT `getSpeedToLeadOutcomes`, despite the near-identical
 * shape.** That query restricts the cohort to leads arriving after the first
 * OutboundMessage webhook, because a response time cannot be measured before
 * call tracking existed. Lead quality has no such dependency — a lead from last
 * year still either booked or did not — and inheriting that cutover would have
 * thrown away almost the whole book. On the live account it would have cut the
 * cohort from thousands of opportunities to about two weeks of them, leaving
 * every segment below its volume floor and the panel permanently reporting
 * "not enough evidence" for a reason nobody could see.
 *
 * The arrival window still applies; the tracking cutover does not.
 */
export async function getQualityCohort(
  clientId: string,
  window: DateWindow,
  timezone: string,
  filter: PaidLeadFilter = DEFAULT_LEAD_FILTER,
  platform: AdPlatform = "meta",
): Promise<QualityLead[]> {
  const paid = platformLeadPredicate(platform, filter);
  const clauses: SQL[] = [
    sql`c.client_id = ${clientId}`,
    sql`c.ghl_created_at >= ${window.startUtc}`,
    sql`c.ghl_created_at < ${window.endUtc}`,
  ];
  if (paid) clauses.push(paid);
  const where = sql.join(clauses, sql` AND `);

  type Row = {
    lead_at: string | Date;
    dow: number;
    hour: number;
    campaign_id: string | null;
    booked_days: number | null;
    showed_days: number | null;
    won_days: number | null;
  };

  const res = await db.execute<Row>(sql`
    WITH cohort AS (
      SELECT c.id,
             c.ghl_created_at AS lead_at,
             COALESCE(c.meta_campaign_id, c.google_campaign_id) AS campaign_id
      FROM contacts c
      WHERE ${where}
    ),
    reached AS (
      /*
       * No upper bound on changed_at: the cohort is followed forward out of the
       * range, so a lead that arrived in the window and booked afterwards still
       * counts as booked. The lower guard is against clock skew only — a
       * transition stamped before its own contact existed is not an outcome of
       * it.
       */
      SELECT st.contact_id,
             MIN(st.changed_at) FILTER (WHERE st.to_canonical = 'appointment_booked') AS booked_at,
             MIN(st.changed_at) FILTER (WHERE st.to_canonical = 'showed')             AS showed_at,
             MIN(st.changed_at) FILTER (WHERE st.to_canonical = 'closed_won')         AS won_at
      FROM stage_transitions st
      JOIN cohort ch ON ch.id = st.contact_id
      WHERE st.client_id = ${clientId}
        AND st.changed_at >= ch.lead_at
      GROUP BY st.contact_id
    )
    SELECT
      ch.lead_at AS lead_at,
      EXTRACT(ISODOW FROM ch.lead_at AT TIME ZONE ${timezone})::int AS dow,
      EXTRACT(HOUR   FROM ch.lead_at AT TIME ZONE ${timezone})::int AS hour,
      ch.campaign_id,
      EXTRACT(EPOCH FROM (r.booked_at - ch.lead_at)) / 86400.0 AS booked_days,
      EXTRACT(EPOCH FROM (r.showed_at - ch.lead_at)) / 86400.0 AS showed_days,
      EXTRACT(EPOCH FROM (r.won_at    - ch.lead_at)) / 86400.0 AS won_days
    FROM cohort ch
    LEFT JOIN reached r ON r.contact_id = ch.id
    ORDER BY ch.lead_at
  `);

  return resultRows<Row>(res).map((r) => {
    const reached: QualityLead["reached"] = {};
    if (r.booked_days !== null) reached.appointment_booked = Number(r.booked_days);
    if (r.showed_days !== null) reached.showed = Number(r.showed_days);
    if (r.won_days !== null) reached.closed_won = Number(r.won_days);
    return {
      leadAt: new Date(r.lead_at).toISOString(),
      dow: Number(r.dow),
      hour: Number(r.hour),
      campaignId: r.campaign_id,
      reached,
    };
  });
}

/**
 * Every lead in the window with its stored attribution object and whether it
 * ever booked or closed.
 *
 * ── 🔴 Deliberately NOT paid-filtered, unlike every cost panel above ───
 *
 * `getQualityCohort` right above this one applies `platformLeadPredicate`,
 * because its job is to compare paid segments against each other. This one
 * must not. On the live book only 88 contacts carry a Meta campaign id, so the
 * paid filter would erase the calendar bookings, the manual entries and every
 * organic landing page — which is most of the answer to "where do our leads
 * come from". A panel about lead CAPTURE that silently dropped four leads in
 * five because they were not matched to an ad would be answering a different
 * question than the one its heading asks.
 *
 * The consequence is that this panel's lead total will not equal the KPI row's,
 * and the component says so in as many words rather than leaving a reader to
 * find the discrepancy and distrust both numbers.
 *
 * Outcomes are followed FORWARD out of the window — a lead that arrived inside
 * the range and booked a fortnight later counts as booked — with the same
 * `changed_at >= lead_at` clock-skew guard `getQualityCohort` uses. A
 * transition stamped before its own contact existed is not an outcome of it.
 */
export async function getLeadSourceCohort(
  clientId: string,
  window: DateWindow,
): Promise<LeadSourceInput[]> {
  type Row = {
    raw: unknown;
    appt: boolean | null;
    won: boolean | null;
  };

  const res = await db.execute<Row>(sql`
    WITH cohort AS (
      SELECT c.id, c.ghl_created_at AS lead_at, c.raw_attribution AS raw
      FROM contacts c
      WHERE c.client_id = ${clientId}
        AND c.ghl_created_at >= ${window.startUtc}
        AND c.ghl_created_at <  ${window.endUtc}
    ),
    reached AS (
      SELECT st.contact_id,
             bool_or(st.to_canonical = 'appointment_booked') AS appt,
             bool_or(st.to_canonical = 'closed_won')         AS won
      FROM stage_transitions st
      JOIN cohort ch ON ch.id = st.contact_id
      WHERE st.client_id = ${clientId}
        AND st.changed_at >= ch.lead_at
      GROUP BY st.contact_id
    )
    SELECT ch.raw AS raw, r.appt, r.won
    FROM cohort ch
    LEFT JOIN reached r ON r.contact_id = ch.id
  `);

  return resultRows<Row>(res).map((r) => ({
    raw: r.raw,
    appt: r.appt === true,
    won: r.won === true,
  }));
}

/**
 * Leads that carry something to match on, plus the count of those that do not.
 *
 * ── 🔴 Why this looks further back than the selected range ─────────────
 *
 * A duplicate is a PAIR, and a pair straddles boundaries. Fetching only the
 * selected range would miss every re-submission whose first arrival fell a week
 * before the range started — and those are not edge cases, they are most of
 * them, because a re-submission usually follows within days of the original.
 *
 * So the fetch reaches back `lookbackDays` beyond the window and the engine
 * groups over the whole span; the panel then reports only groups with an
 * arrival inside the range. The lookback also has to be long enough to
 * recognise a RETURNING customer, which is a span of months rather than days —
 * hence a default measured in hundreds of days rather than tens.
 *
 * ── The two counts are both returned, deliberately ────────────────────
 *
 * `total` counts every paid lead in the window; the rows count only those
 * carrying a phone or an email. On the live database those differ by roughly
 * eight to one, and reporting a duplicate count without the denominator states
 * a fact about a small minority of the book as though it were a fact about the
 * book. See `duplicates.ts`.
 */
export async function getDuplicateCandidates(
  clientId: string,
  window: DateWindow,
  filter: PaidLeadFilter = DEFAULT_LEAD_FILTER,
  platform: AdPlatform = "meta",
  lookbackDays = 400,
): Promise<{
  rows: Array<{
    id: string;
    name: string | null;
    phone: string | null;
    email: string | null;
    createdAt: string;
    campaignName: string | null;
    inRange: boolean;
  }>;
  total: number;
}> {
  const paid = platformLeadPredicate(platform, filter);
  const since = new Date(
    window.startUtc.getTime() - lookbackDays * 86_400_000,
  );

  const base: SQL[] = [sql`c.client_id = ${clientId}`];
  if (paid) base.push(paid);

  type Row = {
    id: string;
    name: string | null;
    phone: string | null;
    email: string | null;
    created_at: string | Date;
    campaign_name: string | null;
    in_range: boolean;
  };

  const res = await db.execute<Row>(sql`
    SELECT c.id,
           NULLIF(TRIM(CONCAT_WS(' ', c.first_name, c.last_name)), '') AS name,
           c.phone,
           c.email,
           c.ghl_created_at AS created_at,
           f.campaign_name,
           (c.ghl_created_at >= ${window.startUtc}
            AND c.ghl_created_at < ${window.endUtc}) AS in_range
    FROM contacts c
    LEFT JOIN LATERAL (
      /*
       * Any one row's name for this campaign id. A LATERAL rather than a join
       * on the metrics table directly: fb_daily_metrics holds one row per
       * campaign per DAY, and joining it would multiply each contact by the
       * number of days its campaign ran.
       *
       * (No backticks in this comment: it sits inside a tagged template
       * literal, where one would end the SQL string mid-query.)
       */
      SELECT m.campaign_name
      FROM fb_daily_metrics m
      WHERE m.client_id = c.client_id
        AND m.meta_campaign_id = COALESCE(c.meta_campaign_id, c.google_campaign_id)
      LIMIT 1
    ) f ON TRUE
    WHERE ${sql.join(base, sql` AND `)}
      AND c.ghl_created_at >= ${since}
      AND c.ghl_created_at < ${window.endUtc}
      /*
       * Only rows with something to match on. The overwhelming majority of this
       * book fails this test — see the header — and pulling those rows back
       * only to discard them in JS would move thousands of contacts across the
       * wire to learn nothing.
       */
      AND (NULLIF(TRIM(c.phone), '') IS NOT NULL OR NULLIF(TRIM(c.email), '') IS NOT NULL)
    ORDER BY c.ghl_created_at
    LIMIT 20000
  `);

  const totalRes = await db.execute<{ count: number }>(sql`
    SELECT COUNT(*)::int AS count
    FROM contacts c
    WHERE ${sql.join(base, sql` AND `)}
      AND c.ghl_created_at >= ${window.startUtc}
      AND c.ghl_created_at < ${window.endUtc}
  `);

  return {
    rows: resultRows<Row>(res).map((r) => ({
      id: r.id,
      name: r.name,
      phone: r.phone,
      email: r.email,
      createdAt: new Date(r.created_at).toISOString(),
      campaignName: r.campaign_name,
      inRange: Boolean(r.in_range),
    })),
    total: Number(resultRows<{ count: number }>(totalRes)[0]?.count) || 0,
  };
}
