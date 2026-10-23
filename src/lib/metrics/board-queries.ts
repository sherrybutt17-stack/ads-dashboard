import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import type { DateWindow } from "@/lib/dates";
import { resultRows } from "./queries";

/**
 * The three things a board needs that no existing query provides.
 *
 * Everything else a board shows comes from the dashboard's own queries
 * (`getPeriodMetrics`, `getDailySeries`, `getCampaignBreakdown`, …) so the two
 * cannot disagree. These fill the gaps:
 *
 *  1. Meta's `actions` array — reactions, comments, shares, saves, page likes,
 *     purchases — which the sync has always stored whole in `raw` and nothing
 *     has ever read.
 *  2. Ad-level rows, grouped by ad, ad set, day or total. Only ad rows carry
 *     ThruPlays and video plays (Meta is asked for them below campaign level).
 *  3. How far back each kind of row goes, so a widget can say "ad-level data
 *     starts 3 Oct" instead of quietly under-counting an older range.
 */

/** Action types summed per row. Never added across types — they overlap. */
export const META_ACTION_TYPES = {
  postReactions: "post_reaction",
  comments: "comment",
  shares: "post",
  saves: "onsite_conversion.post_save",
  pageLikes: "like",
  postEngagement: "post_engagement",
} as const;

/**
 * Purchases are reported under several overlapping types. Per row, the first
 * one present wins and the others are ignored: adding them would count one
 * purchase two or three times — the same trap as Meta's lead types.
 */
export const PURCHASE_PRECEDENCE = [
  "omni_purchase",
  "purchase",
  "offsite_conversion.fb_pixel_purchase",
] as const;

export interface MetaActionSums {
  postReactions: number;
  comments: number;
  shares: number;
  saves: number;
  pageLikes: number;
  postEngagement: number;
  purchases: number;
}

/**
 * One row's action sums, as a lateral subquery that aggregates back to exactly
 * one row per fact row — so a join on it can never multiply the row's other
 * columns.
 *
 * Two guards, because `raw` is whatever Meta sent:
 *  - `jsonb_typeof(...) = 'array'` — a missing or malformed `actions` key reads
 *    as no actions rather than an error;
 *  - the value cast only runs on something that looks like a number. Meta sends
 *    numbers as strings, and one odd value must never fail the query: on the
 *    Neon pool a failed statement can take its neighbours down with it.
 */
function actionsLateral(): SQL {
  const sums = Object.entries(META_ACTION_TYPES).map(
    ([alias, type]) =>
      sql`COALESCE(SUM(x.v) FILTER (WHERE x.t = ${type}), 0) AS ${sql.raw(snake(alias))}`,
  );
  const purchase = sql`COALESCE(${sql.join(
    PURCHASE_PRECEDENCE.map((t) => sql`MAX(x.v) FILTER (WHERE x.t = ${t})`),
    sql`, `,
  )}, 0) AS purchases`;
  return sql`
    LEFT JOIN LATERAL (
      SELECT ${sql.join([...sums, purchase], sql`, `)}
      FROM (
        SELECT e->>'action_type' AS t,
               CASE WHEN (e->>'value') ~ '^-?[0-9]+([.][0-9]+)?$'
                    THEN (e->>'value')::numeric ELSE 0 END AS v
        FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(m.raw->'actions') = 'array'
               THEN m.raw->'actions' ELSE '[]'::jsonb END
        ) e
      ) x
    ) a ON true`;
}

function snake(alias: string): string {
  return alias.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

const ACTION_SELECT = sql`
  COALESCE(SUM(a.post_reactions), 0)::float AS post_reactions,
  COALESCE(SUM(a.comments), 0)::float AS comments,
  COALESCE(SUM(a.shares), 0)::float AS shares,
  COALESCE(SUM(a.saves), 0)::float AS saves,
  COALESCE(SUM(a.page_likes), 0)::float AS page_likes,
  COALESCE(SUM(a.post_engagement), 0)::float AS post_engagement,
  COALESCE(SUM(a.purchases), 0)::float AS purchases`;

interface ActionColumns {
  post_reactions: number;
  comments: number;
  shares: number;
  saves: number;
  page_likes: number;
  post_engagement: number;
  purchases: number;
}

function actionsOf(r: ActionColumns): MetaActionSums {
  return {
    postReactions: Number(r.post_reactions) || 0,
    comments: Number(r.comments) || 0,
    shares: Number(r.shares) || 0,
    saves: Number(r.saves) || 0,
    pageLikes: Number(r.page_likes) || 0,
    postEngagement: Number(r.post_engagement) || 0,
    purchases: Number(r.purchases) || 0,
  };
}

export interface MetaExtrasRow extends MetaActionSums {
  /** Day key, campaign id, or "" for the total. */
  key: string;
  label: string | null;
  landingPageViews: number;
  video3sViews: number;
  /** Rows in the group with no stored `raw` at all — named in a note. */
  rowsWithoutRaw: number;
}

/**
 * Campaign-row figures outside `AdTotals`: the action sums, landing-page views
 * and 3-second plays, for the whole range, per day, or per campaign.
 *
 * Campaign rows only. Ad rows describe the same delivery a second time, so
 * mixing the two levels double-counts — every query here names its level.
 */
export async function getMetaCampaignExtras(
  clientId: string,
  window: DateWindow,
  by: "total" | "day" | "campaign",
): Promise<MetaExtrasRow[]> {
  const key =
    by === "day"
      ? sql`to_char(m.date, 'YYYY-MM-DD')`
      : by === "campaign"
        ? sql`m.meta_campaign_id`
        : sql`''`;
  const label = by === "campaign" ? sql`MAX(m.campaign_name)` : sql`NULL::text`;
  const group = by === "total" ? sql`` : sql`GROUP BY 1`;

  const res = await db.execute(sql`
    SELECT ${key} AS key,
           ${label} AS label,
           COALESCE(SUM(m.landing_page_views), 0)::float AS landing_page_views,
           COALESCE(SUM(m.video_3s_views), 0)::float AS video_3s_views,
           COUNT(*) FILTER (WHERE m.raw IS NULL)::int AS rows_without_raw,
           ${ACTION_SELECT}
    FROM fb_daily_metrics m
    ${actionsLateral()}
    WHERE m.client_id = ${clientId}
      AND m.level = 'campaign'
      AND m.date >= ${window.startKey}
      AND m.date <= ${window.endKey}
    ${group}
  `);

  type Row = ActionColumns & {
    key: string | null;
    label: string | null;
    landing_page_views: number;
    video_3s_views: number;
    rows_without_raw: number;
  };
  return resultRows<Row>(res).map((r) => ({
    key: r.key ?? "",
    label: r.label,
    landingPageViews: Number(r.landing_page_views) || 0,
    video3sViews: Number(r.video_3s_views) || 0,
    rowsWithoutRaw: Number(r.rows_without_raw) || 0,
    ...actionsOf(r),
  }));
}

export interface MetaAdLevelRow extends MetaActionSums {
  key: string;
  label: string | null;
  /** The campaign an ad or ad set belongs to. */
  parent: string | null;
  spend: number;
  impressions: number;
  clicksAll: number;
  linkClicks: number;
  fbLeads: number;
  landingPageViews: number;
  video3sViews: number;
  videoPlays: number;
  thruPlays: number;
}

/**
 * Ad-level rows grouped by ad, ad set, day or for the whole range.
 *
 * Labels take the most recent non-empty name: ads get renamed, and the name a
 * client recognises is the current one.
 */
export async function getMetaAdLevel(
  clientId: string,
  window: DateWindow,
  by: "ad" | "adset" | "day" | "total",
): Promise<MetaAdLevelRow[]> {
  const key =
    by === "ad"
      ? sql`m.meta_ad_id`
      : by === "adset"
        ? sql`m.meta_adset_id`
        : by === "day"
          ? sql`to_char(m.date, 'YYYY-MM-DD')`
          : sql`''`;
  const nameCol = by === "adset" ? sql`m.adset_name` : sql`m.ad_name`;
  const label =
    by === "ad" || by === "adset"
      ? sql`(ARRAY_AGG(${nameCol} ORDER BY (${nameCol} IS NULL), m.date DESC))[1]`
      : sql`NULL::text`;
  const parent =
    by === "ad" || by === "adset"
      ? sql`(ARRAY_AGG(m.campaign_name ORDER BY (m.campaign_name IS NULL), m.date DESC))[1]`
      : sql`NULL::text`;
  const notBlank =
    by === "ad"
      ? sql`AND m.meta_ad_id <> ''`
      : by === "adset"
        ? sql`AND m.meta_adset_id <> ''`
        : sql``;
  const group = by === "total" ? sql`` : sql`GROUP BY 1`;

  const res = await db.execute(sql`
    SELECT ${key} AS key,
           ${label} AS label,
           ${parent} AS parent,
           COALESCE(SUM(m.spend), 0)::float AS spend,
           COALESCE(SUM(m.impressions), 0)::float AS impressions,
           COALESCE(SUM(m.clicks_all), 0)::float AS clicks_all,
           COALESCE(SUM(m.link_clicks), 0)::float AS link_clicks,
           COALESCE(SUM(m.leads_total), 0)::float AS fb_leads,
           COALESCE(SUM(m.landing_page_views), 0)::float AS landing_page_views,
           COALESCE(SUM(m.video_3s_views), 0)::float AS video_3s_views,
           COALESCE(SUM(m.video_plays), 0)::float AS video_plays,
           COALESCE(SUM(m.thru_plays), 0)::float AS thru_plays,
           ${ACTION_SELECT}
    FROM fb_daily_metrics m
    ${actionsLateral()}
    WHERE m.client_id = ${clientId}
      AND m.level = 'ad'
      AND m.date >= ${window.startKey}
      AND m.date <= ${window.endKey}
      ${notBlank}
    ${group}
  `);

  type Row = ActionColumns & {
    key: string | null;
    label: string | null;
    parent: string | null;
    spend: number;
    impressions: number;
    clicks_all: number;
    link_clicks: number;
    fb_leads: number;
    landing_page_views: number;
    video_3s_views: number;
    video_plays: number;
    thru_plays: number;
  };
  return resultRows<Row>(res).map((r) => ({
    key: r.key ?? "",
    label: r.label,
    parent: r.parent,
    spend: Number(r.spend) || 0,
    impressions: Number(r.impressions) || 0,
    clicksAll: Number(r.clicks_all) || 0,
    linkClicks: Number(r.link_clicks) || 0,
    fbLeads: Number(r.fb_leads) || 0,
    landingPageViews: Number(r.landing_page_views) || 0,
    video3sViews: Number(r.video_3s_views) || 0,
    videoPlays: Number(r.video_plays) || 0,
    thruPlays: Number(r.thru_plays) || 0,
    ...actionsOf(r),
  }));
}

export interface MetaCoverage {
  firstCampaignDay: string | null;
  firstAdDay: string | null;
  firstBreakdownDay: string | null;
}

/**
 * The first day each kind of Meta row exists for this client.
 *
 * Campaign rows are backfilled; ad rows and audience splits only start when the
 * nightly sync began collecting them. A widget reading either over an older
 * range under-counts, and has to say so.
 */
export async function getMetaCoverage(clientId: string): Promise<MetaCoverage> {
  const res = await db.execute(sql`
    SELECT
      (SELECT to_char(MIN(date), 'YYYY-MM-DD') FROM fb_daily_metrics
         WHERE client_id = ${clientId} AND level = 'campaign') AS first_campaign_day,
      (SELECT to_char(MIN(date), 'YYYY-MM-DD') FROM fb_daily_metrics
         WHERE client_id = ${clientId} AND level = 'ad') AS first_ad_day,
      (SELECT to_char(MIN(date_start), 'YYYY-MM-DD') FROM fb_breakdown_metrics
         WHERE client_id = ${clientId}) AS first_breakdown_day
  `);
  const [r] = resultRows<{
    first_campaign_day: string | null;
    first_ad_day: string | null;
    first_breakdown_day: string | null;
  }>(res);
  return {
    firstCampaignDay: r?.first_campaign_day ?? null,
    firstAdDay: r?.first_ad_day ?? null,
    firstBreakdownDay: r?.first_breakdown_day ?? null,
  };
}

/**
 * Cached reach and frequency for EXACTLY this window, account level.
 *
 * `"multiple"` when more than one ad account has a row: one person reached by
 * two accounts is one person, so the rows cannot be added and there is no
 * honest single figure.
 */
export async function getPeriodReachRow(
  clientId: string,
  window: DateWindow,
): Promise<{ reach: number | null; frequency: number | null } | "multiple" | null> {
  const res = await db.execute(sql`
    SELECT reach, frequency::float AS frequency
    FROM fb_period_reach
    WHERE client_id = ${clientId}
      AND period_start = ${window.startKey}
      AND period_end = ${window.endKey}
      AND meta_campaign_id = ''
  `);
  const rows = resultRows<{ reach: number | string | null; frequency: number | null }>(res);
  if (rows.length === 0) return null;
  if (rows.length > 1) return "multiple";
  const r = rows[0];
  return {
    reach: r.reach === null ? null : Number(r.reach),
    frequency: r.frequency === null ? null : Number(r.frequency),
  };
}
