import { and, eq, gte, lte, sql, inArray, type SQL } from "drizzle-orm";
import { db } from "@/db";
import {
  fbDailyMetrics,
  fbPeriodReach,
  googleAdAccounts,
  googleDailyMetrics,
} from "@/db/schema";
import type { CanonicalStage } from "@/db/schema";
import {
  EMPTY_ADS,
  EMPTY_FUNNEL,
  derive,
  type AdTotals,
  type DerivedMetrics,
  type FunnelCounts,
} from "./compute";
import type { DateWindow } from "@/lib/dates";

export interface PeriodMetrics {
  label: string;
  window: DateWindow;
  funnel: FunnelCounts;
  ads: AdTotals;
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

/** Which ad platform a dashboard view is scoped to. */
export type AdPlatform = "meta" | "google";

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
  return paidLeadPredicate(filter);
}

/** The contacts column carrying each platform's campaign id. */
function campaignIdColumn(platform: AdPlatform): SQL {
  return platform === "google"
    ? sql`c.google_campaign_id`
    : sql`c.meta_campaign_id`;
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
  return out;
}

/** Both drivers return `.rows`; this keeps the cast in one place. */
function resultRows<T>(result: unknown): T[] {
  return ((result as { rows?: T[] })?.rows ?? []) as T[];
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
  if (platform === "google") {
    const g = await getGoogleTotals(clientId, window);
    return {
      spend: g.spend,
      impressions: g.impressions,
      clicksAll: g.clicks,
      linkClicks: g.clicks,
      fbLeads: 0,
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

/** Summed Google spend/impressions/clicks for a window. Zeroes if none. */
async function getGoogleTotals(
  clientId: string,
  window: DateWindow,
): Promise<{ spend: number; impressions: number; clicks: number }> {
  const [row] = await db
    .select({
      spend: sql<string>`COALESCE(SUM(${googleDailyMetrics.spend}), 0)`,
      impressions: sql<string>`COALESCE(SUM(${googleDailyMetrics.impressions}), 0)`,
      clicks: sql<string>`COALESCE(SUM(${googleDailyMetrics.clicks}), 0)`,
    })
    .from(googleDailyMetrics)
    .where(
      and(
        eq(googleDailyMetrics.clientId, clientId),
        gte(googleDailyMetrics.date, window.startKey),
        lte(googleDailyMetrics.date, window.endKey),
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
      ),
    );
  if (rows.length === 0) return null;
  // Campaign-level reach rows also cannot be summed into an account total —
  // the same person reached by two campaigns is one person overall. Only an
  // account-level row (campaign id "") is a valid total.
  const accountRow = rows.find((r) => r.reach !== null);
  return accountRow ? Number(accountRow.reach) : null;
}

/** Everything needed to render one period row. */
export async function getPeriodMetrics(
  clientId: string,
  window: DateWindow,
  label: string,
  campaignIds?: string[],
  filter: PaidLeadFilter = DEFAULT_LEAD_FILTER,
  platform: AdPlatform = "meta",
): Promise<PeriodMetrics> {
  const [funnel, ads] = await Promise.all([
    getFunnelCounts(clientId, window, campaignIds, filter, platform),
    getAdTotals(clientId, window, campaignIds, platform),
  ]);
  return { label, window, funnel, ads, derived: derive(funnel, ads) };
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
   * Per-day ad spend for the selected platform only. The two dashboards are
   * separate views — Google spend never blends into the Facebook trend and vice
   * versa. Google has no link-click split, so its clicks feed both fields.
   */
  const adsByDate = new Map<string, AdTotals>();
  const loadAds = async () => {
    if (platform === "google") {
      const gRows = await db
        .select({
          dateKey: googleDailyMetrics.date,
          spend: sql<string>`COALESCE(SUM(${googleDailyMetrics.spend}), 0)`,
          impressions: sql<string>`COALESCE(SUM(${googleDailyMetrics.impressions}), 0)`,
          clicks: sql<string>`COALESCE(SUM(${googleDailyMetrics.clicks}), 0)`,
        })
        .from(googleDailyMetrics)
        .where(
          and(
            eq(googleDailyMetrics.clientId, clientId),
            gte(googleDailyMetrics.date, window.startKey),
            lte(googleDailyMetrics.date, window.endKey),
          ),
        )
        .groupBy(googleDailyMetrics.date);
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
  if (platform === "google") {
    const gRows = await db
      .select({
        campaignId: googleDailyMetrics.googleCampaignId,
        campaignName: sql<string>`MAX(${googleDailyMetrics.campaignName})`,
        spend: sql<string>`COALESCE(SUM(${googleDailyMetrics.spend}), 0)`,
        impressions: sql<string>`COALESCE(SUM(${googleDailyMetrics.impressions}), 0)`,
        clicks: sql<string>`COALESCE(SUM(${googleDailyMetrics.clicks}), 0)`,
      })
      .from(googleDailyMetrics)
      .where(
        and(
          eq(googleDailyMetrics.clientId, clientId),
          gte(googleDailyMetrics.date, window.startKey),
          lte(googleDailyMetrics.date, window.endKey),
        ),
      )
      .groupBy(googleDailyMetrics.googleCampaignId);

    return gRows.map((r) => {
      const clicks = Number(r.clicks) || 0;
      return {
        campaignId: r.campaignId,
        campaignName: r.campaignName ?? null,
        platform: "google" as const,
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

export type { CanonicalStage };
