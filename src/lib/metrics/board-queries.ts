import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import type { DateWindow } from "@/lib/dates";
import type { AdPlatform } from "@/lib/platforms";
import { resultRows } from "./queries";
import {
  GOOGLE_RESULT_TYPE,
  mergeByType,
  metaResultType,
  tiktokResultType,
  type TypedResults,
} from "./results";
import {
  EXTRA_KEY,
  GOOGLE_EXTRA_FAMILIES,
  META_ACTION_FAMILIES,
  META_AD_ROW_EXTRAS,
  SIMPLE_COLUMN_EXTRAS,
  TIKTOK_EXTRAS,
  type MetaActionFamily,
} from "./platform-extras";

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
  /**
   * Every action family in `META_ACTION_FAMILIES` (registrations, contacts …)
   * by key — and, on ad rows, the columns only they carry (`META_AD_ROW_EXTRAS`).
   */
  x: Record<string, number>;
}

const FAMILY_KEYS = Object.keys(META_ACTION_FAMILIES) as MetaActionFamily[];

/**
 * A column alias or jsonb key spliced into SQL. Only ever a key from the
 * constant lists in `platform-extras.ts`, and checked anyway: an alias cannot
 * be a bound parameter.
 */
function safeKey(key: string): string {
  if (!EXTRA_KEY.test(key)) throw new Error(`Not a safe extras key: ${key}`);
  return key;
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
  // Each family the same way: the first of its types present on the row wins.
  const families = FAMILY_KEYS.map(
    (k) =>
      sql`COALESCE(${sql.join(
        META_ACTION_FAMILIES[k].map((t) => sql`MAX(x.v) FILTER (WHERE x.t = ${t})`),
        sql`, `,
      )}, 0) AS ${sql.raw(`f_${safeKey(k)}`)}`,
  );
  return sql`
    LEFT JOIN LATERAL (
      SELECT ${sql.join([...sums, purchase, ...families], sql`, `)}
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

const ACTION_SELECT = sql.join(
  [
    sql`COALESCE(SUM(a.post_reactions), 0)::float AS post_reactions`,
    sql`COALESCE(SUM(a.comments), 0)::float AS comments`,
    sql`COALESCE(SUM(a.shares), 0)::float AS shares`,
    sql`COALESCE(SUM(a.saves), 0)::float AS saves`,
    sql`COALESCE(SUM(a.page_likes), 0)::float AS page_likes`,
    sql`COALESCE(SUM(a.post_engagement), 0)::float AS post_engagement`,
    sql`COALESCE(SUM(a.purchases), 0)::float AS purchases`,
    ...FAMILY_KEYS.map(
      (k) => sql`COALESCE(SUM(a.${sql.raw(`f_${safeKey(k)}`)}), 0)::float AS ${sql.raw(`x_${k}`)}`,
    ),
  ],
  sql`, `,
);

/** The typed columns only ad rows fill, summed — for the ad-level queries only. */
const AD_ROW_SELECT = sql.join(
  Object.entries(META_AD_ROW_EXTRAS).map(
    ([k, col]) => sql`COALESCE(SUM(m.${sql.raw(safeKey(col))}), 0)::float AS ${sql.raw(`ar_${safeKey(k)}`)}`,
  ),
  sql`, `,
);

interface ActionColumns {
  post_reactions: number;
  comments: number;
  shares: number;
  saves: number;
  page_likes: number;
  post_engagement: number;
  purchases: number;
  [family: `x_${string}`]: number;
}

type AdRowColumns = { [extra: `ar_${string}`]: number };

function actionsOf(r: ActionColumns, adRow?: AdRowColumns): MetaActionSums {
  const x: Record<string, number> = {};
  for (const k of FAMILY_KEYS) x[k] = Number(r[`x_${k}`]) || 0;
  if (adRow) for (const k of Object.keys(META_AD_ROW_EXTRAS)) x[k] = Number(adRow[`ar_${k}`]) || 0;
  return {
    postReactions: Number(r.post_reactions) || 0,
    comments: Number(r.comments) || 0,
    shares: Number(r.shares) || 0,
    saves: Number(r.saves) || 0,
    pageLikes: Number(r.page_likes) || 0,
    postEngagement: Number(r.post_engagement) || 0,
    purchases: Number(r.purchases) || 0,
    x,
  };
}

export interface MetaExtrasRow extends MetaActionSums {
  /** Day key, campaign id, or "" for the total. */
  key: string;
  label: string | null;
  landingPageViews: number;
  video3sViews: number;
  /** Meta's Instant Form leads — part of `leads_total`, never added to it. */
  leadsOnsite: number;
  /** Meta's website pixel leads — part of `leads_total`, never added to it. */
  leadsPixel: number;
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
           COALESCE(SUM(m.leads_onsite), 0)::float AS leads_onsite,
           COALESCE(SUM(m.leads_pixel), 0)::float AS leads_pixel,
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
    leads_onsite: number;
    leads_pixel: number;
    rows_without_raw: number;
  };
  return resultRows<Row>(res).map((r) => ({
    key: r.key ?? "",
    label: r.label,
    landingPageViews: Number(r.landing_page_views) || 0,
    video3sViews: Number(r.video_3s_views) || 0,
    leadsOnsite: Number(r.leads_onsite) || 0,
    leadsPixel: Number(r.leads_pixel) || 0,
    rowsWithoutRaw: Number(r.rows_without_raw) || 0,
    ...actionsOf(r),
  }));
}

/** Google's or TikTok's extra figures for one group of daily rows. */
export interface SimpleExtrasRow {
  /** Day key, campaign id, or "" for the total. */
  key: string;
  /** Every extra figure by key, and the platform's own `conversions` column. */
  x: Record<string, number>;
  /**
   * Per figure: rows with delivery that were stored before it was collected —
   * synced before the extras existed, or on a run where the platform refused
   * it. Named in a note; a stat reading it over those days would under-count.
   */
  uncollected: Record<string, number>;
}

/**
 * Google's and TikTok's figures beyond spend and clicks, from their daily rows
 * — what their syncs store in `raw` (`metrics/platform-extras.ts`) — for the
 * whole range, per day, or per campaign.
 */
export async function getSimpleExtras(
  platform: "google" | "tiktok",
  clientId: string,
  window: DateWindow,
  by: "total" | "day" | "campaign",
): Promise<SimpleExtrasRow[]> {
  const google = platform === "google";
  const table = sql.raw(google ? "google_daily_metrics" : "tiktok_daily_metrics");
  const campaign = sql.raw(google ? "m.google_campaign_id" : "m.tiktok_campaign_id");
  const key = by === "day" ? DAY_KEY : by === "campaign" ? campaign : sql`''`;
  const group = by === "total" ? sql`` : sql`GROUP BY 1`;
  // Where each figure lives: the `raw` key of its family, and its own key in it.
  const fields: Array<{ family: string; key: string }> = google
    ? Object.entries(GOOGLE_EXTRA_FAMILIES).flatMap(([family, keys]) =>
        Object.keys(keys).map((key) => ({ family, key })),
      )
    : Object.keys(TIKTOK_EXTRAS).map((key) => ({ family: "x", key }));
  const at = (f: { family: string; key: string }) =>
    sql.raw(`m.raw->'${safeKey(f.family)}'->'${safeKey(f.key)}'`);
  const delivered = sql`(m.spend > 0 OR m.impressions > 0)`;

  const res = await db.execute(sql`
    SELECT ${key} AS key,
           ${sql.join(
             [
               ...fields.flatMap((f) => [
                 sql`COALESCE(SUM(${numericText(sql`${at(f)} #>> '{}'`)}), 0)::float AS ${sql.raw(`x_${f.key}`)}`,
                 sql`COUNT(*) FILTER (WHERE ${delivered} AND ${at(f)} IS NULL)::int AS ${sql.raw(`u_${f.key}`)}`,
               ]),
               ...SIMPLE_COLUMN_EXTRAS.map(
                 (c) => sql`COALESCE(SUM(m.${sql.raw(safeKey(c))}), 0)::float AS ${sql.raw(`x_${c}`)}`,
               ),
             ],
             sql`, `,
           )}
    FROM ${table} m
    WHERE m.client_id = ${clientId}
      AND m.date >= ${window.startKey}
      AND m.date <= ${window.endKey}
    ${group}
  `);

  const keys = [...fields.map((f) => f.key), ...SIMPLE_COLUMN_EXTRAS];
  return resultRows<Record<string, unknown> & { key: string | null }>(res).map((r) => ({
    key: r.key ?? "",
    x: Object.fromEntries(keys.map((k) => [k, Number(r[`x_${k}`]) || 0])),
    uncollected: Object.fromEntries(fields.map((f) => [f.key, Number(r[`u_${f.key}`]) || 0])),
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
  leadsOnsite: number;
  leadsPixel: number;
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
           COALESCE(SUM(m.leads_onsite), 0)::float AS leads_onsite,
           COALESCE(SUM(m.leads_pixel), 0)::float AS leads_pixel,
           COALESCE(SUM(m.landing_page_views), 0)::float AS landing_page_views,
           COALESCE(SUM(m.video_3s_views), 0)::float AS video_3s_views,
           COALESCE(SUM(m.video_plays), 0)::float AS video_plays,
           COALESCE(SUM(m.thru_plays), 0)::float AS thru_plays,
           ${AD_ROW_SELECT},
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

  type Row = ActionColumns & AdRowColumns & {
    key: string | null;
    label: string | null;
    parent: string | null;
    spend: number;
    impressions: number;
    clicks_all: number;
    link_clicks: number;
    fb_leads: number;
    leads_onsite: number;
    leads_pixel: number;
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
    leadsOnsite: Number(r.leads_onsite) || 0,
    leadsPixel: Number(r.leads_pixel) || 0,
    landingPageViews: Number(r.landing_page_views) || 0,
    video3sViews: Number(r.video_3s_views) || 0,
    videoPlays: Number(r.video_plays) || 0,
    thruPlays: Number(r.thru_plays) || 0,
    ...actionsOf(r, r),
  }));
}

/**
 * One ad's delivery under one creative over a window — the unit creative cards
 * are built from. An ad normally has one creative; one whose creative was
 * swapped has a row for each, so grouping by ad and grouping by creative both
 * come from the same rows and add up.
 */
export interface MetaAdPairRow extends MetaActionSums {
  /** The asset (image hash or video id). "" = no single asset: Dynamic Creative, carousels. */
  creativeKey: string;
  creativeType: string | null;
  adId: string;
  adName: string | null;
  campaignId: string;
  campaignName: string | null;
  spend: number;
  impressions: number;
  clicksAll: number;
  linkClicks: number;
  fbLeads: number;
  leadsOnsite: number;
  leadsPixel: number;
  landingPageViews: number;
  video3sViews: number;
  videoPlays: number;
  thruPlays: number;
  /** Meta's most recent judgement, not an average — see `getCreativePerformance`. */
  qualityRanking: string | null;
  engagementRanking: string | null;
  conversionRanking: string | null;
}

export async function getMetaAdCreativePairs(
  clientId: string,
  window: DateWindow,
): Promise<MetaAdPairRow[]> {
  const ranking = (col: string) =>
    sql`(ARRAY_AGG(${sql.raw(`m.${col}`)}::text ORDER BY m.date DESC)
           FILTER (WHERE ${sql.raw(`m.${col}`)} IS NOT NULL AND ${sql.raw(`m.${col}`)} <> 'unknown'))[1]`;
  const res = await db.execute(sql`
    SELECT COALESCE(m.creative_key, '') AS creative_key,
           MAX(m.creative_type::text) AS creative_type,
           m.meta_ad_id AS ad_id,
           ${latest(sql`m.ad_name`)} AS ad_name,
           ${latest(sql`m.meta_campaign_id`)} AS campaign_id,
           ${latest(sql`m.campaign_name`)} AS campaign_name,
           COALESCE(SUM(m.spend), 0)::float AS spend,
           COALESCE(SUM(m.impressions), 0)::float AS impressions,
           COALESCE(SUM(m.clicks_all), 0)::float AS clicks_all,
           COALESCE(SUM(m.link_clicks), 0)::float AS link_clicks,
           COALESCE(SUM(m.leads_total), 0)::float AS fb_leads,
           COALESCE(SUM(m.leads_onsite), 0)::float AS leads_onsite,
           COALESCE(SUM(m.leads_pixel), 0)::float AS leads_pixel,
           COALESCE(SUM(m.landing_page_views), 0)::float AS landing_page_views,
           COALESCE(SUM(m.video_3s_views), 0)::float AS video_3s_views,
           COALESCE(SUM(m.video_plays), 0)::float AS video_plays,
           COALESCE(SUM(m.thru_plays), 0)::float AS thru_plays,
           ${ranking("quality_ranking")} AS quality_ranking,
           ${ranking("engagement_rate_ranking")} AS engagement_ranking,
           ${ranking("conversion_rate_ranking")} AS conversion_ranking,
           ${AD_ROW_SELECT},
           ${ACTION_SELECT}
    FROM fb_daily_metrics m
    ${actionsLateral()}
    WHERE m.client_id = ${clientId}
      AND m.level = 'ad'
      AND m.date >= ${window.startKey}
      AND m.date <= ${window.endKey}
      AND m.meta_ad_id <> ''
    GROUP BY COALESCE(m.creative_key, ''), m.meta_ad_id
  `);

  type Row = ActionColumns & AdRowColumns & {
    creative_key: string;
    creative_type: string | null;
    ad_id: string;
    ad_name: string | null;
    campaign_id: string | null;
    campaign_name: string | null;
    spend: number;
    impressions: number;
    clicks_all: number;
    link_clicks: number;
    fb_leads: number;
    leads_onsite: number;
    leads_pixel: number;
    landing_page_views: number;
    video_3s_views: number;
    video_plays: number;
    thru_plays: number;
    quality_ranking: string | null;
    engagement_ranking: string | null;
    conversion_ranking: string | null;
  };
  return resultRows<Row>(res).map((r) => ({
    creativeKey: r.creative_key ?? "",
    creativeType: r.creative_type,
    adId: r.ad_id,
    adName: r.ad_name,
    campaignId: r.campaign_id ?? "",
    campaignName: r.campaign_name,
    spend: Number(r.spend) || 0,
    impressions: Number(r.impressions) || 0,
    clicksAll: Number(r.clicks_all) || 0,
    linkClicks: Number(r.link_clicks) || 0,
    fbLeads: Number(r.fb_leads) || 0,
    leadsOnsite: Number(r.leads_onsite) || 0,
    leadsPixel: Number(r.leads_pixel) || 0,
    landingPageViews: Number(r.landing_page_views) || 0,
    video3sViews: Number(r.video_3s_views) || 0,
    videoPlays: Number(r.video_plays) || 0,
    thruPlays: Number(r.thru_plays) || 0,
    qualityRanking: r.quality_ranking,
    engagementRanking: r.engagement_ranking,
    conversionRanking: r.conversion_ranking,
    ...actionsOf(r, r),
  }));
}

/** What one ad looks like: its text, its asset, and Facebook's preview link. */
export interface MetaAdIdentity {
  adId: string;
  adName: string | null;
  creativeKey: string;
  creativeType: string | null;
  title: string | null;
  body: string | null;
  hasThumbnail: boolean;
  videoLengthSeconds: number | null;
  status: string | null;
  learningStage: string | null;
  /** `preview_shareable_link` as Meta returned it — validate before showing. */
  previewLink: string | null;
}

/** Ads per statement: one bound parameter each, far below Postgres's limit. */
const IDENTITY_CHUNK = 1000;

export async function getMetaAdIdentity(
  clientId: string,
  adIds: readonly string[],
): Promise<Map<string, MetaAdIdentity>> {
  const out = new Map<string, MetaAdIdentity>();
  const ids = [...new Set(adIds.filter(Boolean))];
  for (let i = 0; i < ids.length; i += IDENTITY_CHUNK) {
    const chunk = ids.slice(i, i + IDENTITY_CHUNK);
    const res = await db.execute(sql`
      SELECT c.meta_ad_id, c.ad_name, COALESCE(c.creative_key, '') AS creative_key,
             c.creative_type::text AS creative_type, c.title, c.body,
             (c.thumbnail_url IS NOT NULL) AS has_thumbnail,
             c.video_length_seconds::float AS video_length_seconds,
             c.status, c.learning_stage,
             CASE WHEN jsonb_typeof(c.raw->'preview_shareable_link') = 'string'
                  THEN c.raw->>'preview_shareable_link' END AS preview_link
      FROM meta_ad_creatives c
      WHERE c.client_id = ${clientId}
        AND c.meta_ad_id IN (${sql.join(chunk.map((id) => sql`${id}`), sql`, `)})
    `);
    for (const r of resultRows<{
      meta_ad_id: string;
      ad_name: string | null;
      creative_key: string;
      creative_type: string | null;
      title: string | null;
      body: string | null;
      has_thumbnail: boolean;
      video_length_seconds: number | null;
      status: string | null;
      learning_stage: string | null;
      preview_link: string | null;
    }>(res)) {
      out.set(r.meta_ad_id, {
        adId: r.meta_ad_id,
        adName: r.ad_name,
        creativeKey: r.creative_key ?? "",
        creativeType: r.creative_type,
        title: r.title,
        body: r.body,
        hasThumbnail: Boolean(r.has_thumbnail),
        videoLengthSeconds: r.video_length_seconds === null ? null : Number(r.video_length_seconds),
        status: r.status,
        learningStage: r.learning_stage,
        previewLink: r.preview_link,
      });
    }
  }
  return out;
}

/** A campaign the creative-cards filter can offer. */
export interface CampaignOption {
  id: string;
  name: string | null;
}

/**
 * Meta campaigns that ran in the last 400 days, most recent first — the list a
 * creative-cards widget can be narrowed to. Campaign rows, because they are
 * backfilled; ad rows may not reach back as far yet.
 */
export async function getMetaCampaignOptions(clientId: string): Promise<CampaignOption[]> {
  const res = await db.execute(sql`
    SELECT m.meta_campaign_id AS id, ${latest(sql`m.campaign_name`)} AS name
    FROM fb_daily_metrics m
    WHERE m.client_id = ${clientId}
      AND m.level = 'campaign'
      AND m.meta_campaign_id <> ''
      AND m.date >= CURRENT_DATE - 400
    GROUP BY m.meta_campaign_id
    ORDER BY MAX(m.date) DESC, SUM(m.spend) DESC
    LIMIT 200
  `);
  return resultRows<{ id: string; name: string | null }>(res).map((r) => ({ id: r.id, name: r.name }));
}

/** TikTok's campaigns for the same filter — the most recently active first. */
export async function getTiktokCampaignOptions(clientId: string): Promise<CampaignOption[]> {
  const res = await db.execute(sql`
    SELECT m.tiktok_campaign_id AS id, ${latest(sql`m.campaign_name`)} AS name
    FROM tiktok_daily_metrics m
    WHERE m.client_id = ${clientId}
      AND m.tiktok_campaign_id <> ''
      AND m.date >= CURRENT_DATE - 400
    GROUP BY m.tiktok_campaign_id
    ORDER BY MAX(m.date) DESC, SUM(m.spend) DESC
    LIMIT 200
  `);
  return resultRows<{ id: string; name: string | null }>(res).map((r) => ({ id: r.id, name: r.name }));
}

/* ------------------------------------------------------------------ *
 * TikTok ad rows
 * ------------------------------------------------------------------ */

/**
 * TikTok's delivery per (ad, asset), from `tiktok_ad_daily_metrics` — the twin
 * of `MetaAdPairRow`, and the one source for TikTok's creative cards and its
 * splits by ad and by creative.
 */
export interface TiktokAdPairRow {
  /** `v:` / `i:` / `p:` asset key. "" = no single asset: carousels, ads not yet resolved. */
  creativeKey: string;
  creativeType: string | null;
  adId: string;
  adName: string | null;
  campaignId: string;
  campaignName: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  /** TikTok's other figures by key (`TIKTOK_EXTRAS`, and its conversions column). */
  x: Record<string, number>;
  /** Per figure: delivered ad-days stored without it. */
  uncollected: Record<string, number>;
}

export async function getTiktokAdPairs(clientId: string, window: DateWindow): Promise<TiktokAdPairRow[]> {
  const keys = Object.keys(TIKTOK_EXTRAS);
  const at = (k: string) => sql.raw(`m.raw->'x'->'${safeKey(k)}'`);
  const delivered = sql`(m.spend > 0 OR m.impressions > 0)`;
  const res = await db.execute(sql`
    SELECT m.creative_key,
           MAX(m.creative_type::text) AS creative_type,
           m.tiktok_ad_id AS ad_id,
           ${latest(sql`m.ad_name`)} AS ad_name,
           ${latest(sql`NULLIF(m.tiktok_campaign_id, '')`)} AS campaign_id,
           ${latest(sql`m.campaign_name`)} AS campaign_name,
           COALESCE(SUM(m.spend), 0)::float AS spend,
           COALESCE(SUM(m.impressions), 0)::float AS impressions,
           COALESCE(SUM(m.clicks), 0)::float AS clicks,
           ${sql.join(
             [
               ...keys.flatMap((k) => [
                 sql`COALESCE(SUM(${numericText(sql`${at(k)} #>> '{}'`)}), 0)::float AS ${sql.raw(`x_${k}`)}`,
                 sql`COUNT(*) FILTER (WHERE ${delivered} AND ${at(k)} IS NULL)::int AS ${sql.raw(`u_${k}`)}`,
               ]),
               ...SIMPLE_COLUMN_EXTRAS.map(
                 (c) => sql`COALESCE(SUM(m.${sql.raw(safeKey(c))}), 0)::float AS ${sql.raw(`x_${c}`)}`,
               ),
             ],
             sql`, `,
           )}
    FROM tiktok_ad_daily_metrics m
    WHERE m.client_id = ${clientId}
      AND m.date >= ${window.startKey}
      AND m.date <= ${window.endKey}
    GROUP BY m.creative_key, m.tiktok_ad_id
  `);
  const all = [...keys, ...SIMPLE_COLUMN_EXTRAS];
  return resultRows<Record<string, unknown> & { creative_key: string; ad_id: string }>(res).map((r) => ({
    creativeKey: r.creative_key ?? "",
    creativeType: (r.creative_type as string | null) ?? null,
    adId: r.ad_id,
    adName: (r.ad_name as string | null) ?? null,
    campaignId: (r.campaign_id as string | null) ?? "",
    campaignName: (r.campaign_name as string | null) ?? null,
    spend: Number(r.spend) || 0,
    impressions: Number(r.impressions) || 0,
    clicks: Number(r.clicks) || 0,
    x: Object.fromEntries(all.map((k) => [k, Number(r[`x_${k}`]) || 0])),
    uncollected: Object.fromEntries(keys.map((k) => [k, Number(r[`u_${k}`]) || 0])),
  }));
}

/** What a TikTok ad shows, for its card. TikTok ads have no headline; the text is the ad's caption. */
export interface TiktokAdIdentity {
  adId: string;
  adName: string | null;
  creativeKey: string;
  creativeType: string | null;
  body: string | null;
  /** The asset whose stored picture stands for the ad — its own, or a carousel's first image. Null with none stored. */
  pictureKey: string | null;
  videoSeconds: number | null;
}

export async function getTiktokAdIdentity(
  clientId: string,
  adIds: readonly string[],
): Promise<Map<string, TiktokAdIdentity>> {
  const out = new Map<string, TiktokAdIdentity>();
  const ids = [...new Set(adIds.filter(Boolean))];
  for (let i = 0; i < ids.length; i += IDENTITY_CHUNK) {
    const chunk = ids.slice(i, i + IDENTITY_CHUNK);
    // Both assets are this client's own: a picture is never looked up by key alone.
    const res = await db.execute(sql`
      SELECT c.tiktok_ad_id, c.ad_name, c.creative_key, c.creative_type::text AS creative_type, c.ad_text,
             CASE WHEN p.thumb IS NOT NULL THEN p.asset_key END AS picture_key,
             v.duration_seconds::float AS video_seconds
      FROM tiktok_ad_creatives c
      LEFT JOIN tiktok_creative_assets p
        ON p.client_id = c.client_id AND p.asset_key = COALESCE(NULLIF(c.thumb_key, ''), NULLIF(c.creative_key, ''))
      LEFT JOIN tiktok_creative_assets v
        ON v.client_id = c.client_id AND v.asset_key = NULLIF(c.creative_key, '')
      WHERE c.client_id = ${clientId}
        AND c.tiktok_ad_id IN (${sql.join(chunk.map((id) => sql`${id}`), sql`, `)})
    `);
    for (const r of resultRows<{
      tiktok_ad_id: string;
      ad_name: string | null;
      creative_key: string;
      creative_type: string | null;
      ad_text: string | null;
      picture_key: string | null;
      video_seconds: number | null;
    }>(res)) {
      out.set(r.tiktok_ad_id, {
        adId: r.tiktok_ad_id,
        adName: r.ad_name,
        creativeKey: r.creative_key ?? "",
        creativeType: r.creative_type,
        body: r.ad_text,
        pictureKey: r.picture_key,
        videoSeconds: r.video_seconds === null ? null : Number(r.video_seconds),
      });
    }
  }
  return out;
}

/** The first day TikTok ad rows exist for this client — they start when ad-level detail was first pulled. */
export async function getTiktokAdCoverage(clientId: string): Promise<{ firstAdDay: string | null }> {
  const res = await db.execute(sql`
    SELECT to_char(MIN(date), 'YYYY-MM-DD') AS first_ad_day
    FROM tiktok_ad_daily_metrics
    WHERE client_id = ${clientId}
  `);
  return { firstAdDay: resultRows<{ first_ad_day: string | null }>(res)[0]?.first_ad_day ?? null };
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

/* ------------------------------------------------------------------ *
 * Platform results — Ads Manager's own "Results"
 * ------------------------------------------------------------------ */

/**
 * `creative` — per asset; `ad_creative` — per (ad, asset) pair, keyed
 * `<ad id>|<creative key>`, which creative cards merge either way. Both read ad
 * rows, so Meta and TikTok only.
 */
export type ResultsBy = "total" | "day" | "campaign" | "adset" | "ad" | "creative" | "ad_creative";

export interface PlatformResultsRow {
  /** Day key, campaign / ad set / ad id, or "" for the total. */
  key: string;
  label: string | null;
  /** The campaign an ad or ad set belongs to. */
  parent: string | null;
  /** Results per type — never summed across types. See `metrics/results.ts`. */
  byType: TypedResults[];
  /** All spend in the group. */
  spend: number;
  /** Spend on rows that optimised for more than one type: no type's cost. */
  mixedSpend: number;
  /** Rows stored before results were requested — named in a coverage note. */
  rowsWithoutResults: number;
}

/** A plain decimal in a jsonb text field, else 0 — the same guard as `actionsLateral`. */
function numericText(expr: SQL): SQL {
  return sql`CASE WHEN (${expr}) ~ '^-?[0-9]+([.][0-9]+)?$' THEN (${expr})::numeric ELSE 0 END`;
}

/**
 * Each platform's own results, per type, for the range — the ONE source behind
 * every Results tile and widget, so the Overview and the Board cannot disagree.
 *
 * Meta: campaign rows (or ad rows for `ad` / `adset`) — `raw.results`, one
 * entry per optimisation type. Google: the stored Conversions column. TikTok:
 * `raw.results` — campaign rows summed from the ad group report by the sync,
 * or its own ad rows by ad and asset.
 *
 * Splits a platform cannot answer (ads on Google, ad sets on Google or TikTok)
 * return nothing rather than a different grouping under the same name.
 */
export async function getPlatformResults(
  platform: AdPlatform,
  clientId: string,
  window: DateWindow,
  by: ResultsBy,
): Promise<PlatformResultsRow[]> {
  if (platform === "meta") return metaResults(clientId, window, by);
  if (by === "adset") return [];
  if (platform === "tiktok") return tiktokResults(clientId, window, by);
  if (by === "ad" || by === "creative" || by === "ad_creative") return [];
  return googleResults(clientId, window, by);
}

const DAY_KEY = sql`to_char(m.date, 'YYYY-MM-DD')`;

/** The most recent non-empty value of a column — names a client recognises. */
function latest(col: SQL): SQL {
  return sql`(ARRAY_AGG(${col} ORDER BY (${col} IS NULL), m.date DESC))[1]`;
}

interface TotalsRow {
  key: string | null;
  label: string | null;
  parent: string | null;
  spend: number;
  mixed_spend: number;
  rows_without_results: number;
}

function assemble(
  totals: TotalsRow[],
  typed: Array<{ key: string; entry: TypedResults }>,
): PlatformResultsRow[] {
  const byKey = new Map<string, TypedResults[]>();
  for (const t of typed) {
    const list = byKey.get(t.key) ?? [];
    list.push(t.entry);
    byKey.set(t.key, list);
  }
  return totals.map((r) => {
    const key = r.key ?? "";
    return {
      key,
      label: r.label,
      parent: r.parent,
      byType: mergeByType(byKey.get(key) ?? []),
      spend: Number(r.spend) || 0,
      mixedSpend: Number(r.mixed_spend) || 0,
      rowsWithoutResults: Number(r.rows_without_results) || 0,
    };
  });
}

async function metaResults(
  clientId: string,
  window: DateWindow,
  by: ResultsBy,
): Promise<PlatformResultsRow[]> {
  const adLevel = by === "ad" || by === "adset" || by === "creative" || by === "ad_creative";
  const key =
    by === "day"
      ? DAY_KEY
      : by === "campaign"
        ? sql`m.meta_campaign_id`
        : by === "ad"
          ? sql`m.meta_ad_id`
          : by === "adset"
            ? sql`m.meta_adset_id`
            : by === "creative"
              ? sql`COALESCE(m.creative_key, '')`
              : by === "ad_creative"
                ? sql`m.meta_ad_id || '|' || COALESCE(m.creative_key, '')`
                : sql`''`;
  const label =
    by === "campaign"
      ? latest(sql`m.campaign_name`)
      : by === "ad"
        ? latest(sql`m.ad_name`)
        : by === "adset"
          ? latest(sql`m.adset_name`)
          : sql`NULL::text`;
  const parent = adLevel ? latest(sql`m.campaign_name`) : sql`NULL::text`;
  const notBlank =
    by === "ad" || by === "ad_creative"
      ? sql`AND m.meta_ad_id <> ''`
      : by === "adset"
        ? sql`AND m.meta_adset_id <> ''`
        : sql``;
  const group = by === "total" ? sql`` : sql`GROUP BY 1`;
  const where = sql`
    WHERE m.client_id = ${clientId}
      AND m.level = ${adLevel ? "ad" : "campaign"}
      AND m.date >= ${window.startKey}
      AND m.date <= ${window.endKey}
      ${notBlank}`;
  // An array, or nothing: a row stored before results were requested has none.
  const results = sql`CASE WHEN jsonb_typeof(m.raw->'results') = 'array' THEN m.raw->'results' ELSE '[]'::jsonb END`;
  const typeCount = sql`jsonb_array_length(${results})`;

  /*
   * Two statements, deliberately. Per-type counts need one row per result
   * entry; spend needs one row per fact row. Doing both in one would multiply
   * spend by the number of types on a mixed row.
   */
  const totalsRes = await db.execute(sql`
    SELECT ${key} AS key,
           ${label} AS label,
           ${parent} AS parent,
           COALESCE(SUM(m.spend), 0)::float AS spend,
           COALESCE(SUM(m.spend) FILTER (WHERE ${typeCount} > 1), 0)::float AS mixed_spend,
           COUNT(*) FILTER (WHERE ${typeCount} = 0)::int AS rows_without_results
    FROM fb_daily_metrics m
    ${where}
    ${group}
  `);
  const typedRes = await db.execute(sql`
    SELECT ${key} AS key,
           e->>'indicator' AS indicator,
           COALESCE(SUM(${numericText(sql`e->'values'->0->>'value'`)}), 0)::float AS count,
           COALESCE(SUM(m.spend) FILTER (WHERE ${typeCount} = 1), 0)::float AS spend,
           COALESCE(SUM(${numericText(sql`e->'values'->0->>'value'`)}) FILTER (WHERE ${typeCount} = 1), 0)::float AS priced
    FROM fb_daily_metrics m
    CROSS JOIN LATERAL jsonb_array_elements(${results}) e
    ${where}
      AND jsonb_typeof(e) = 'object'
      AND COALESCE(e->>'indicator', '') <> ''
    GROUP BY 1, 2
  `);
  const typed = resultRows<{
    key: string | null;
    indicator: string;
    count: number;
    spend: number;
    priced: number;
  }>(typedRes).map((r) => ({
    key: r.key ?? "",
    entry: {
      type: metaResultType(r.indicator),
      count: Number(r.count) || 0,
      spend: Number(r.spend) || 0,
      pricedCount: Number(r.priced) || 0,
    },
  }));
  return assemble(resultRows<TotalsRow>(totalsRes), typed);
}

async function googleResults(
  clientId: string,
  window: DateWindow,
  by: Exclude<ResultsBy, "ad" | "adset" | "creative" | "ad_creative">,
): Promise<PlatformResultsRow[]> {
  const key = by === "day" ? DAY_KEY : by === "campaign" ? sql`m.google_campaign_id` : sql`''`;
  const label = by === "campaign" ? latest(sql`m.campaign_name`) : sql`NULL::text`;
  const group = by === "total" ? sql`` : sql`GROUP BY 1`;
  const res = await db.execute(sql`
    SELECT ${key} AS key,
           ${label} AS label,
           NULL::text AS parent,
           COALESCE(SUM(m.spend), 0)::float AS spend,
           0::float AS mixed_spend,
           0::int AS rows_without_results,
           COALESCE(SUM(m.conversions), 0)::float AS conversions
    FROM google_daily_metrics m
    WHERE m.client_id = ${clientId}
      AND m.date >= ${window.startKey}
      AND m.date <= ${window.endKey}
    ${group}
  `);
  const rows = resultRows<TotalsRow & { conversions: number }>(res);
  return assemble(
    rows,
    rows.map((r) => ({
      key: r.key ?? "",
      entry: {
        type: GOOGLE_RESULT_TYPE,
        count: Number(r.conversions) || 0,
        spend: Number(r.spend) || 0,
        pricedCount: Number(r.conversions) || 0,
      },
    })),
  );
}

/**
 * TikTok's results — from campaign rows, or from ad rows (`tiktok_ad_daily_metrics`)
 * per ad, per asset or per (ad, asset) pair, keyed as Meta's are.
 */
async function tiktokResults(
  clientId: string,
  window: DateWindow,
  by: Exclude<ResultsBy, "adset">,
): Promise<PlatformResultsRow[]> {
  const adLevel = by === "ad" || by === "creative" || by === "ad_creative";
  const table = sql.raw(adLevel ? "tiktok_ad_daily_metrics" : "tiktok_daily_metrics");
  const key =
    by === "day"
      ? DAY_KEY
      : by === "campaign"
        ? sql`m.tiktok_campaign_id`
        : by === "ad"
          ? sql`m.tiktok_ad_id`
          : by === "creative"
            ? sql`m.creative_key`
            : by === "ad_creative"
              ? sql`m.tiktok_ad_id || '|' || m.creative_key`
              : sql`''`;
  const label =
    by === "campaign" ? latest(sql`m.campaign_name`) : by === "ad" ? latest(sql`m.ad_name`) : sql`NULL::text`;
  const parent = adLevel ? latest(sql`m.campaign_name`) : sql`NULL::text`;
  const group = by === "total" ? sql`` : sql`GROUP BY 1`;
  const where = sql`
    WHERE m.client_id = ${clientId}
      AND m.date >= ${window.startKey}
      AND m.date <= ${window.endKey}`;
  const has = sql`jsonb_typeof(m.raw->'results') = 'object'`;
  const totalsRes = await db.execute(sql`
    SELECT ${key} AS key,
           ${label} AS label,
           ${parent} AS parent,
           COALESCE(SUM(m.spend), 0)::float AS spend,
           0::float AS mixed_spend,
           COUNT(*) FILTER (WHERE NOT COALESCE(${has}, false))::int AS rows_without_results
    FROM ${table} m
    ${where}
    ${group}
  `);
  // One objective per campaign (and so per ad), so a TikTok row is never mixed.
  const typedRes = await db.execute(sql`
    SELECT ${key} AS key,
           COALESCE(m.raw->'results'->>'objective', m.raw->'metrics'->>'objective_type') AS objective,
           COALESCE(SUM(${numericText(sql`m.raw->'results'->>'value'`)}), 0)::float AS count,
           COALESCE(SUM(m.spend), 0)::float AS spend
    FROM ${table} m
    ${where}
      AND ${has}
    GROUP BY 1, 2
  `);
  const typed = resultRows<{ key: string | null; objective: string | null; count: number; spend: number }>(
    typedRes,
  ).map((r) => ({
    key: r.key ?? "",
    entry: {
      type: tiktokResultType(r.objective),
      count: Number(r.count) || 0,
      spend: Number(r.spend) || 0,
      // One objective per campaign: every TikTok row is single-type.
      pricedCount: Number(r.count) || 0,
    },
  }));
  return assemble(resultRows<TotalsRow>(totalsRes), typed);
}
