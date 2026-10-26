import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import type { CreativeType } from "@/db/schema";
import type { DateWindow } from "@/lib/dates";
import { tiktokPictureRef } from "@/lib/tiktok/thumbs";
import { TIKTOK_EXTRAS, type TiktokExtra } from "./platform-extras";
import { resultRows } from "./queries";
import { resultsHeadline, tiktokResultType, type ResultType, type TypedResults } from "./results";

/**
 * TikTok per creative, for the Creatives tab — the twin of Meta's
 * `getCreativePerformance`, read from `tiktok_ad_daily_metrics`.
 *
 * 🔴 Grouped by `creative_key`, never by ad id: the same video in five ad
 * groups is one card, or its spend splits five ways and each part looks like a
 * cheap performer. The empty-key bucket (carousels, ads with no single asset)
 * is kept as a row so the cards still add up to the account's spend.
 *
 * Results are TikTok's own — its Results column, counted against each ad
 * group's optimisation goal — not the CRM's: GoHighLevel receives no TikTok ad
 * id, so a lead cannot be traced to the video that brought it. Each card counts
 * its main result type (most spend), never a sum across types.
 */

export type TiktokCreativeTotals = {
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
} & Record<TiktokExtra, number>;

export interface TiktokCreativeRow {
  /** `v:<video_id>` / `i:<image_id>` / `p:<item_id>`. Empty string = the unresolved bucket. */
  creativeKey: string;
  creativeType: CreativeType;
  /** A representative ad name — the same asset runs under several. */
  adName: string | null;
  adText: string | null;
  callToAction: string | null;
  videoSeconds: number | null;
  /** The thumb route's `tt.` ref, when a picture is stored; null shows the typed placeholder. */
  pictureRef: string | null;
  adCount: number;
  adgroupCount: number;
  campaignNames: string[];
  totals: TiktokCreativeTotals;
  /** Delivered ad-days synced before the engagement figures were collected. */
  uncollectedDays: number;
  /** TikTok's Results for this asset — its main type, count and cost — or null with none. */
  results: { type: ResultType; count: number; costPer: number | null; otherTypes: number } | null;
}

const EXTRA_KEYS = Object.keys(TIKTOK_EXTRAS) as TiktokExtra[];

/** A plain decimal in a jsonb text field, else 0 — the guard every stored-figure read uses. */
function numericText(expr: SQL): SQL {
  return sql`CASE WHEN (${expr}) ~ '^-?[0-9]+([.][0-9]+)?$' THEN (${expr})::numeric ELSE 0 END`;
}

export async function getTiktokCreativePerformance(
  clientId: string,
  window: DateWindow,
): Promise<TiktokCreativeRow[]> {
  const inRange = sql`m.client_id = ${clientId} AND m.date >= ${window.startKey} AND m.date <= ${window.endKey}`;
  const delivered = sql`(m.spend > 0 OR m.impressions > 0)`;

  const [totalsRes, resultsRes, identityRes, assetsRes] = await Promise.all([
    db.execute(sql`
      SELECT m.creative_key AS key,
             (ARRAY_AGG(m.creative_type::text ORDER BY m.spend DESC))[1] AS type,
             (ARRAY_AGG(m.ad_name ORDER BY (m.ad_name IS NULL), m.spend DESC))[1] AS ad_name,
             COALESCE(SUM(m.spend), 0)::float AS spend,
             COALESCE(SUM(m.impressions), 0)::float AS impressions,
             COALESCE(SUM(m.clicks), 0)::float AS clicks,
             COALESCE(SUM(m.conversions), 0)::float AS conversions,
             ${sql.join(
               EXTRA_KEYS.map(
                 (k) => sql`COALESCE(SUM(${numericText(sql.raw(`m.raw->'x'->>'${k}'`))}), 0)::float AS ${sql.raw(`x_${k}`)}`,
               ),
               sql`, `,
             )},
             COUNT(*) FILTER (WHERE ${delivered} AND m.raw->'x' IS NULL)::int AS uncollected,
             COUNT(DISTINCT m.tiktok_ad_id)::int AS ads,
             COUNT(DISTINCT NULLIF(m.tiktok_adgroup_id, ''))::int AS adgroups,
             ARRAY_REMOVE(ARRAY_AGG(DISTINCT m.campaign_name), NULL) AS campaigns
      FROM tiktok_ad_daily_metrics m
      WHERE ${inRange}
      GROUP BY m.creative_key
    `),
    db.execute(sql`
      SELECT m.creative_key AS key,
             m.raw->'results'->>'objective' AS objective,
             COALESCE(SUM(${numericText(sql`m.raw->'results'->>'value'`)}), 0)::float AS results,
             COALESCE(SUM(m.spend), 0)::float AS spend
      FROM tiktok_ad_daily_metrics m
      WHERE ${inRange} AND m.raw ? 'results'
      GROUP BY 1, 2
    `),
    /*
     * A representative identity per asset, preferring the most recently synced
     * ad that actually has each field — a newer ad with a blank text must not
     * blank out the card.
     */
    db.execute(sql`
      SELECT c.creative_key AS key,
             (ARRAY_AGG(c.ad_name ORDER BY (c.ad_name IS NULL), c.synced_at DESC))[1] AS ad_name,
             (ARRAY_AGG(c.ad_text ORDER BY (c.ad_text IS NULL), c.synced_at DESC))[1] AS ad_text,
             (ARRAY_AGG(c.call_to_action ORDER BY (c.call_to_action IS NULL), c.synced_at DESC))[1] AS cta,
             (ARRAY_AGG(c.thumb_key ORDER BY (c.thumb_key = ''), c.synced_at DESC))[1] AS thumb_key
      FROM tiktok_ad_creatives c
      WHERE c.client_id = ${clientId} AND c.creative_key <> ''
      GROUP BY c.creative_key
    `),
    db.execute(sql`
      SELECT a.asset_key AS key, a.duration_seconds::float AS duration, (a.thumb IS NOT NULL) AS pictured
      FROM tiktok_creative_assets a
      WHERE a.client_id = ${clientId}
    `),
  ]);

  const results = new Map<string, TypedResults[]>();
  for (const r of resultRows<{ key: string; objective: string | null; results: number; spend: number }>(resultsRes)) {
    const list = results.get(r.key) ?? [];
    list.push({
      type: tiktokResultType(r.objective),
      count: Number(r.results) || 0,
      spend: Number(r.spend) || 0,
      // One objective per ad row, so every row's spend is single-type.
      pricedCount: Number(r.results) || 0,
    });
    results.set(r.key, list);
  }
  const identity = new Map(
    resultRows<{ key: string; ad_name: string | null; ad_text: string | null; cta: string | null; thumb_key: string | null }>(
      identityRes,
    ).map((r) => [r.key, r]),
  );
  const assets = new Map(
    resultRows<{ key: string; duration: number | null; pictured: boolean }>(assetsRes).map((a) => [a.key, a]),
  );

  return resultRows<Record<string, unknown> & { key: string }>(totalsRes).map((r) => {
    const id = identity.get(r.key);
    const thumbKey = id?.thumb_key || r.key;
    const headline = resultsHeadline(results.get(r.key) ?? []);
    const totals = {
      spend: Number(r.spend) || 0,
      impressions: Number(r.impressions) || 0,
      clicks: Number(r.clicks) || 0,
      conversions: Number(r.conversions) || 0,
      ...Object.fromEntries(EXTRA_KEYS.map((k) => [k, Number(r[`x_${k}`]) || 0])),
    } as TiktokCreativeTotals;
    return {
      creativeKey: r.key,
      creativeType: (r.type as CreativeType) ?? "unknown",
      adName: id?.ad_name ?? (r.ad_name as string | null) ?? null,
      adText: id?.ad_text ?? null,
      callToAction: id?.cta ?? null,
      videoSeconds: assets.get(r.key)?.duration ?? null,
      pictureRef: thumbKey && assets.get(thumbKey)?.pictured ? tiktokPictureRef(thumbKey) : null,
      adCount: Number(r.ads) || 0,
      adgroupCount: Number(r.adgroups) || 0,
      campaignNames: Array.isArray(r.campaigns) ? (r.campaigns as string[]) : [],
      totals,
      uncollectedDays: Number(r.uncollected) || 0,
      results: headline.type
        ? { type: headline.type, count: headline.count, costPer: headline.costPer, otherTypes: headline.others.length }
        : null,
    };
  });
}

/** Whether any TikTok ad-level row exists for this client — "not imported yet" versus "nothing ran". */
export async function hasTiktokAdLevelData(clientId: string): Promise<boolean> {
  const res = await db.execute(sql`
    SELECT EXISTS (SELECT 1 FROM tiktok_ad_daily_metrics WHERE client_id = ${clientId}) AS any
  `);
  return Boolean(resultRows<{ any: boolean }>(res)[0]?.any);
}
