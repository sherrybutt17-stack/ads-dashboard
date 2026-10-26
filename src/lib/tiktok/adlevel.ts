import { and, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import {
  syncRuns,
  tiktokAdCreatives,
  tiktokAdDailyMetrics,
  tiktokCreativeAssets,
  type Client,
  type CreativeType,
  type TiktokAdAccount,
} from "@/db/schema";
import { decryptNullable } from "@/lib/crypto";
import { trailingWindowInclusive } from "@/lib/dates";
import { planMonths } from "@/lib/meta/sync";
import { TIKTOK_EXTRAS, storedFigure } from "@/lib/metrics/platform-extras";
import { TiktokClient, dayOf, num, type TiktokAd, type TiktokInsightRow } from "./client";
import { parseAssetKey, resolveTiktokCreative } from "./creative";
import { activeTiktokAccounts } from "./accounts";
import { fetchTiktokPicture } from "./thumbs";

/**
 * TikTok per ad: the rows creative reporting reads, what each ad shows, and
 * each asset's picture.
 *
 * ── 🔴 Never the spend pipe ────────────────────────────────────────────
 *
 * Writes only the three ad-level tables. It never touches
 * `tiktok_daily_metrics`, an account's `last_synced_at` / `last_error`, or the
 * client's reconcile marker, and records its own run kind (`tiktok_adlevel`)
 * that health and pipe status do not read. So a failure here costs creative
 * reporting a night and can never turn TikTok spend red, stale or wrong.
 *
 * ── Order within a window ─────────────────────────────────────────────
 *
 * The report first, then the identity of exactly the ads in it (by id, deleted
 * ones included), then the rows — each stamped with its creative before it is
 * written, as Meta's are. Pictures last and best-effort: a slow CDN or a
 * refused asset costs a picture, never the rows. Rows written with no creative
 * (identity unavailable that night) are named later by `rekeyUnnamedAdRows`.
 */

/** Pictures fetched per run: enough for an account's live creatives, bounded for the cron's clock. */
const PICTURES_PER_RUN = 40;
/** Pictures fetched at once. */
const PICTURE_CONCURRENCY = 4;
/** Rows per INSERT. */
const UPSERT_BATCH = 250;

interface Identity {
  key: string;
  type: CreativeType;
  thumbKey: string;
}

/** One run's shared state: what was asked already, what went wrong, when to stop. */
export interface AdLevelContext {
  /** Epoch ms. Pictures stop being fetched past it; the rows never wait on them. */
  deadline: number;
  /** Ads whose identity this run has already asked TikTok for. */
  asked: Set<string>;
  /** Assets whose info (and picture) this run has already asked for — one that failed waits for the next run. */
  assetsAsked: Set<string>;
  /** Pictures this run may still fetch. */
  picturesLeft: number;
  /** What went wrong without failing the run — identity, assets, pictures. */
  failures: string[];
}

export function adLevelContext(deadline: number): AdLevelContext {
  return { deadline, asked: new Set(), assetsAsked: new Set(), picturesLeft: PICTURES_PER_RUN, failures: [] };
}

/**
 * One advertiser's ad rows for one window: report, identities, rows, pictures.
 * Throws when the report itself fails — the rows ARE the window.
 */
export async function pullTiktokAdWindow(
  client: Client,
  account: TiktokAdAccount,
  tiktok: TiktokClient,
  since: string,
  until: string,
  ctx: AdLevelContext,
): Promise<number> {
  const { rows, fields } = await tiktok.getAdDailyReport(account.advertiserId, since, until);
  const adIds = [...new Set(rows.map((r) => String(r.dimensions.ad_id ?? "")).filter((id) => /^\d{1,25}$/.test(id)))];
  const identity = await resolveIdentities(client, account, tiktok, adIds, ctx);
  const written = await writeAdRows(client, account, rows, fields, identity);

  // Pictures for the assets that spent in the window, biggest spender first.
  const spend = new Map<string, number>();
  for (const r of rows) {
    const thumbKey = identity.get(String(r.dimensions.ad_id ?? ""))?.thumbKey;
    if (thumbKey) spend.set(thumbKey, (spend.get(thumbKey) ?? 0) + num(r.metrics.spend));
  }
  const wanted = [...spend].filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  await refreshAssets(client, account, tiktok, wanted, ctx);
  return written;
}

/**
 * The creative of each ad: asked of TikTok once per run, stored, then read back
 * with whatever earlier runs stored for the ones TikTok did not return.
 */
async function resolveIdentities(
  client: Client,
  account: TiktokAdAccount,
  tiktok: TiktokClient,
  adIds: string[],
  ctx: AdLevelContext,
): Promise<Map<string, Identity>> {
  const ask = adIds.filter((id) => !ctx.asked.has(id));
  if (ask.length > 0) {
    try {
      await upsertAdIdentities(client, account, await tiktok.getAdsByIds(account.advertiserId, ask));
      for (const id of ask) ctx.asked.add(id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[tiktok] ad identities not read for ${account.advertiserId}:`, message);
      ctx.failures.push(`ads: ${message.slice(0, 200)}`);
    }
  }
  if (adIds.length === 0) return new Map();
  const stored = await db
    .select({
      adId: tiktokAdCreatives.tiktokAdId,
      key: tiktokAdCreatives.creativeKey,
      type: tiktokAdCreatives.creativeType,
      thumbKey: tiktokAdCreatives.thumbKey,
    })
    .from(tiktokAdCreatives)
    .where(and(eq(tiktokAdCreatives.clientId, client.id), inArray(tiktokAdCreatives.tiktokAdId, adIds)));
  return new Map(stored.map((s) => [s.adId, { key: s.key, type: s.type, thumbKey: s.thumbKey }]));
}

async function upsertAdIdentities(client: Client, account: TiktokAdAccount, ads: TiktokAd[]): Promise<void> {
  const values = ads.map((ad) => {
    const creative = resolveTiktokCreative(ad);
    return {
      clientId: client.id,
      advertiserId: account.advertiserId,
      tiktokAdId: ad.ad_id,
      adName: text(ad.ad_name),
      tiktokAdgroupId: text(ad.adgroup_id),
      tiktokCampaignId: text(ad.campaign_id),
      creativeKey: creative.key,
      creativeType: creative.type,
      thumbKey: creative.thumbKey,
      videoId: text(ad.video_id),
      imageIds: Array.isArray(ad.image_ids) ? ad.image_ids.map(String) : null,
      tiktokItemId: text(ad.tiktok_item_id),
      adFormat: text(ad.ad_format),
      adText: text(ad.ad_text),
      callToAction: text(ad.call_to_action),
      displayName: text(ad.display_name),
      landingPageUrl: text(ad.landing_page_url),
      operationStatus: text(ad.operation_status),
      secondaryStatus: text(ad.secondary_status),
      raw: ad as object,
      syncedAt: new Date(),
    };
  });
  for (let i = 0; i < values.length; i += UPSERT_BATCH) {
    const chunk = values.slice(i, i + UPSERT_BATCH);
    await db
      .insert(tiktokAdCreatives)
      .values(chunk)
      .onConflictDoUpdate({
        target: [tiktokAdCreatives.clientId, tiktokAdCreatives.tiktokAdId],
        set: {
          ...excluded(tiktokAdCreatives, chunk[0]),
          // Merged: a field refused on a later read must not erase what an earlier one stored.
          raw: sql`COALESCE(${tiktokAdCreatives.raw}, '{}'::jsonb) || excluded.raw`,
        },
      });
  }
}

/** The window's ad rows, each stamped with its creative, upserted in batches. */
async function writeAdRows(
  client: Client,
  account: TiktokAdAccount,
  rows: TiktokInsightRow[],
  fields: string[],
  identity: Map<string, Identity>,
): Promise<number> {
  // A field TikTok refused is left out of every row, so it reads as not collected, not as 0.
  const accepted = (Object.entries(TIKTOK_EXTRAS) as Array<[string, string]>).filter(([, f]) => fields.includes(f));
  const withResults = fields.includes("result");

  const byKey = new Map<string, typeof tiktokAdDailyMetrics.$inferInsert>();
  for (const row of rows) {
    const date = dayOf(row.dimensions.stat_time_day);
    const adId = String(row.dimensions.ad_id ?? "");
    // A row we cannot date or place cannot be stored against a day and an ad.
    if (!date || !/^\d{1,25}$/.test(adId)) continue;
    const m = row.metrics;
    const objective = typeof m.objective_type === "string" && m.objective_type ? m.objective_type : null;
    const id = identity.get(adId);
    const raw = {
      ...row,
      ...(withResults ? { results: { value: storedFigure(num(m.result)), objective } } : {}),
      ...(accepted.length > 0 ? { x: Object.fromEntries(accepted.map(([key, f]) => [key, storedFigure(num(m[f]))])) } : {}),
    };
    byKey.set(`${date}|${adId}`, {
      clientId: client.id,
      advertiserId: account.advertiserId,
      date,
      tiktokCampaignId: text(m.campaign_id) ?? "",
      campaignName: text(m.campaign_name),
      tiktokAdgroupId: text(m.adgroup_id) ?? "",
      adgroupName: text(m.adgroup_name),
      tiktokAdId: adId,
      adName: text(m.ad_name),
      creativeKey: id?.key ?? "",
      creativeType: id?.type ?? "unknown",
      impressions: num(m.impressions),
      clicks: num(m.clicks),
      spend: String(num(m.spend)),
      conversions: String(num(m.conversion)),
      currency: account.currency,
      raw,
      syncedAt: new Date(),
    });
  }

  const values = [...byKey.values()];
  for (let i = 0; i < values.length; i += UPSERT_BATCH) {
    const chunk = values.slice(i, i + UPSERT_BATCH);
    const t = tiktokAdDailyMetrics;
    await db
      .insert(t)
      .values(chunk)
      .onConflictDoUpdate({
        target: [t.clientId, t.advertiserId, t.date, t.tiktokAdId],
        set: {
          ...excluded(t, chunk[0]),
          campaignName: sql`COALESCE(excluded.campaign_name, ${t.campaignName})`,
          adgroupName: sql`COALESCE(excluded.adgroup_name, ${t.adgroupName})`,
          adName: sql`COALESCE(excluded.ad_name, ${t.adName})`,
          /*
           * An ad its identity could not be read for tonight keeps the creative
           * an earlier run named it by, rather than falling out of its card.
           */
          creativeKey: sql`CASE WHEN excluded.creative_key = '' AND excluded.creative_type = 'unknown' THEN ${t.creativeKey} ELSE excluded.creative_key END`,
          creativeType: sql`CASE WHEN excluded.creative_key = '' AND excluded.creative_type = 'unknown' THEN ${t.creativeType} ELSE excluded.creative_type END`,
          // Merged: a run whose results or extras were refused must not erase stored ones.
          raw: sql`COALESCE(${t.raw}, '{}'::jsonb) || excluded.raw`,
        },
      });
  }
  return values.length;
}

/**
 * Duration, size and picture for the assets that spent, where not yet stored.
 * Best-effort throughout, and bounded by the run's picture budget and clock.
 */
async function refreshAssets(
  client: Client,
  account: TiktokAdAccount,
  tiktok: TiktokClient,
  assetKeys: string[],
  ctx: AdLevelContext,
): Promise<void> {
  if (assetKeys.length === 0 || Date.now() > ctx.deadline) return;
  const have = await db
    .select({ key: tiktokCreativeAssets.assetKey })
    .from(tiktokCreativeAssets)
    .where(
      and(
        eq(tiktokCreativeAssets.clientId, client.id),
        inArray(tiktokCreativeAssets.assetKey, assetKeys),
        isNotNull(tiktokCreativeAssets.thumb),
      ),
    );
  const pictured = new Set(have.map((h) => h.key));
  const need = assetKeys
    .filter((k) => !pictured.has(k) && !ctx.assetsAsked.has(k))
    .map((k) => ({ key: k, asset: parseAssetKey(k) }));
  for (const n of need) ctx.assetsAsked.add(n.key);

  const videos = need.filter((n) => n.asset?.kind === "video").map((n) => n.asset!.id);
  const images = need.filter((n) => n.asset?.kind === "image").map((n) => n.asset!.id);
  // Spark posts: no read-only cover source without the creator's authorisation — they keep the placeholder.

  const found: Array<{ key: string; kind: string; videoId?: string; imageId?: string; info: Record<string, unknown>; url: string | null }> = [];
  try {
    if (videos.length) {
      for (const v of await tiktok.getVideoInfo(account.advertiserId, videos)) {
        found.push({ key: `v:${v.video_id}`, kind: "video", videoId: v.video_id, info: v, url: text(v.video_cover_url) });
      }
    }
    if (images.length) {
      for (const i of await tiktok.getImageInfo(account.advertiserId, images)) {
        found.push({ key: `i:${i.image_id}`, kind: "image", imageId: i.image_id, info: i, url: text(i.image_url) });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[tiktok] asset info not read for ${account.advertiserId}:`, message);
    ctx.failures.push(`assets: ${message.slice(0, 200)}`);
  }

  // Biggest spender first: `assetKeys` arrives in that order.
  const order = new Map(assetKeys.map((k, i) => [k, i]));
  found.sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));

  let missed = 0;
  for (let i = 0; i < found.length; i += PICTURE_CONCURRENCY) {
    await Promise.all(
      found.slice(i, i + PICTURE_CONCURRENCY).map(async (f) => {
        const take = f.url !== null && ctx.picturesLeft > 0 && Date.now() < ctx.deadline;
        if (take) ctx.picturesLeft--;
        const picture = take ? await fetchTiktokPicture(f.url!) : null;
        if (take && !picture) missed++;
        await upsertAsset(client, account, f, picture);
      }),
    );
  }
  if (missed > 0) ctx.failures.push(`pictures: ${missed} could not be fetched`);
}

/**
 * Pictures still missing for this advertiser's ads, the most spent-on first.
 *
 * A window refreshes only the assets of the ads in it, so an ad that has
 * stopped running — or whose picture failed when it last ran — would never get
 * one, and an import of months already complete reaches no ad at all. Within
 * the run's picture budget; a post has no cover to fetch. Never fails the run.
 */
async function fillMissingPictures(
  client: Client,
  account: TiktokAdAccount,
  tiktok: TiktokClient,
  ctx: AdLevelContext,
): Promise<void> {
  if (ctx.picturesLeft <= 0 || Date.now() > ctx.deadline) return;
  try {
    const res = await db.execute(sql`
      SELECT k.key
      FROM (
        SELECT COALESCE(NULLIF(c.thumb_key, ''), c.creative_key) AS key
        FROM tiktok_ad_creatives c
        WHERE c.client_id = ${client.id} AND c.advertiser_id = ${account.advertiserId}
        GROUP BY 1
      ) k
      LEFT JOIN tiktok_creative_assets a ON a.client_id = ${client.id} AND a.asset_key = k.key
      LEFT JOIN (
        SELECT creative_key, SUM(spend) AS spend FROM tiktok_ad_daily_metrics
        WHERE client_id = ${client.id}
        GROUP BY creative_key
      ) s ON s.creative_key = k.key
      WHERE (k.key LIKE 'v:%' OR k.key LIKE 'i:%') AND a.thumb IS NULL
      ORDER BY s.spend DESC NULLS LAST, k.key
      LIMIT ${ctx.picturesLeft + ctx.assetsAsked.size}
    `);
    // Not one this run already tried: its picture just failed, and asking again now fails again.
    const keys = (res as unknown as { rows: Array<{ key: string }> }).rows
      .map((r) => r.key)
      .filter((k) => !ctx.assetsAsked.has(k))
      .slice(0, ctx.picturesLeft);
    await refreshAssets(client, account, tiktok, keys, ctx);
  } catch (err) {
    ctx.failures.push(`missing pictures: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`);
  }
}

async function upsertAsset(
  client: Client,
  account: TiktokAdAccount,
  f: { key: string; kind: string; videoId?: string; imageId?: string; info: Record<string, unknown> },
  picture: { bytes: Buffer; contentType: string } | null,
): Promise<void> {
  const duration = Number(f.info.duration);
  const width = Number(f.info.width);
  const height = Number(f.info.height);
  const values = {
    clientId: client.id,
    advertiserId: account.advertiserId,
    assetKey: f.key,
    kind: f.kind,
    videoId: f.videoId ?? null,
    imageId: f.imageId ?? null,
    durationSeconds: Number.isFinite(duration) && duration > 0 ? String(duration) : null,
    width: Number.isInteger(width) && width > 0 ? width : null,
    height: Number.isInteger(height) && height > 0 ? height : null,
    raw: withoutUrls(f.info),
    syncedAt: new Date(),
    ...(picture ? { thumb: picture.bytes, thumbContentType: picture.contentType, thumbFetchedAt: new Date() } : {}),
  };
  await db
    .insert(tiktokCreativeAssets)
    .values(values)
    .onConflictDoUpdate({
      target: [tiktokCreativeAssets.clientId, tiktokCreativeAssets.assetKey],
      // A run that could not fetch the picture keeps the one already stored.
      set: excluded(tiktokCreativeAssets, values),
    });
}

/**
 * Give unnamed ad rows the creative their ad is now known by — rows written on
 * a night TikTok would not describe the ad. Only rows empty for want of an
 * answer (`unknown`): a carousel's empty key is the right one, and stays.
 */
export async function rekeyUnnamedAdRows(clientId: string): Promise<void> {
  await db.execute(sql`
    UPDATE tiktok_ad_daily_metrics AS m
    SET creative_key = c.creative_key, creative_type = c.creative_type
    FROM tiktok_ad_creatives AS c
    WHERE m.client_id = ${clientId}
      AND c.client_id = m.client_id
      AND c.tiktok_ad_id = m.tiktok_ad_id
      AND m.creative_key = ''
      AND m.creative_type = 'unknown'
      AND c.creative_key <> ''
  `);
}

/**
 * The nightly pass for one client: its advertisers' ads over the trailing
 * window the campaign reconcile re-pulls, as `tiktok_adlevel`.
 *
 * The run fails only when an advertiser's ad report failed — then that
 * window's rows are not there. Identities, assets and pictures that could not
 * be read go on the run's `meta.failures` and are asked for again next run.
 */
export async function syncClientTiktokAdLevel(
  client: Client,
  opts: { since?: string; until?: string; days: number; deadline: number },
): Promise<{ rowsWritten: number; runId: string }> {
  const [run] = await db
    .insert(syncRuns)
    .values({ clientId: client.id, kind: "tiktok_adlevel", status: "running" })
    .returning({ id: syncRuns.id });
  try {
    const accounts = await activeTiktokAccounts(client.id);
    if (accounts.length === 0) throw new Error("Client has no TikTok advertiser configured");
    const window = trailingWindowInclusive(opts.days, client.timezone);
    const since = opts.since ?? window.startKey;
    const until = opts.until ?? window.endKey;
    const ctx = adLevelContext(opts.deadline);

    let written = 0;
    const failures: unknown[] = [];
    for (const account of accounts) {
      const token = decryptNullable(account.accessTokenEncrypted);
      if (!token) {
        failures.push(new Error(`No access token for advertiser ${account.advertiserId} — re-authorise it.`));
        continue;
      }
      try {
        const tiktok = new TiktokClient(token);
        written += await pullTiktokAdWindow(client, account, tiktok, since, until, ctx);
        // Then whatever picture budget is left, on ads this window did not reach.
        await fillMissingPictures(client, account, tiktok, ctx);
      } catch (err) {
        failures.push(err);
      }
    }
    await rekeyUnnamedAdRows(client.id);
    if (failures.length > 0) throw failures[0];

    await db
      .update(syncRuns)
      .set({
        status: "success",
        finishedAt: new Date(),
        rowsWritten: written,
        meta: { since, until, accounts: accounts.length, ...(ctx.failures.length ? { failures: ctx.failures } : {}) },
      })
      .where(eq(syncRuns.id, run.id));
    return { rowsWritten: written, runId: run.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(syncRuns)
      .set({ status: "failed", finishedAt: new Date(), error: message })
      .where(eq(syncRuns.id, run.id));
    throw err;
  }
}

export interface TiktokAdLevelImportResult {
  /** Every month of the window is now complete. */
  done: boolean;
  /** Where the next request carries on (months before this day), or null when done. */
  nextBefore: string | null;
  months: Array<{ month: string; status: "imported" | "complete"; rows: number }>;
  rowsWritten: number;
}

/** Spend by table for one window: a month whose ad rows add up to its campaign rows is done. */
async function monthIsComplete(clientId: string, since: string, until: string): Promise<boolean> {
  const res = await db.execute(sql`
    SELECT
      (SELECT COALESCE(SUM(spend), 0)::float FROM tiktok_daily_metrics
        WHERE client_id = ${clientId} AND date >= ${since} AND date <= ${until}) AS campaign,
      (SELECT COALESCE(SUM(spend), 0)::float FROM tiktok_ad_daily_metrics
        WHERE client_id = ${clientId} AND date >= ${since} AND date <= ${until}) AS ad
  `);
  const row = (res as unknown as { rows: Array<{ campaign: number; ad: number }> }).rows[0];
  const campaign = Number(row?.campaign) || 0;
  const ad = Number(row?.ad) || 0;
  return campaign > 0 && Math.abs(ad - campaign) <= campaign * 0.005;
}

/**
 * Import ad-level history — what TikTok creative cards and ad tables read — for
 * a window the nightly pass never reached.
 *
 * Meta's `importMetaAdLevelHistory`, in TikTok's terms: one request does as many
 * months as fit in `budgetMs` (a route has 300 s), newest first, and says where
 * to carry on; a month whose ad rows already add up to its campaign rows is
 * skipped in one query, so pressing the button again resumes rather than
 * restarting. Calendar months fit TikTok's 30-day span rule (31 inclusive days
 * are accepted; 32 are refused).
 *
 * 🔴 Re-pull TikTok's campaign history first. Both levels now include deleted
 * campaigns; campaign rows synced before that do not, so their months never
 * add up and are imported again on every press until they are re-pulled.
 *
 * Writes no `sync_runs` row: a month from last year that fails must not mark
 * the nightly pass, or anything else, as broken.
 */
export async function importTiktokAdLevelHistory(
  client: Client,
  opts: { days: number; before?: string; budgetMs?: number },
): Promise<TiktokAdLevelImportResult> {
  const started = Date.now();
  const budget = opts.budgetMs ?? 180_000;
  const accounts = await activeTiktokAccounts(client.id);
  if (accounts.length === 0) throw new Error("Client has no TikTok advertiser configured");
  const clientsByAccount = accounts.map((account) => {
    const token = decryptNullable(account.accessTokenEncrypted);
    if (!token) throw new Error(`No access token for advertiser ${account.advertiserId} — re-authorise it.`);
    return { account, tiktok: new TiktokClient(token) };
  });

  const months = planMonths(trailingWindowInclusive(opts.days, client.timezone), opts.before);
  // Pictures stop at the budget too; the next request picks up what is left.
  const ctx = adLevelContext(started + budget);
  const done: TiktokAdLevelImportResult["months"] = [];
  let rowsWritten = 0;
  const finish = async (result: TiktokAdLevelImportResult) => {
    await rekeyUnnamedAdRows(client.id).catch((err: unknown) => {
      console.warn(`[tiktok] unnamed ad rows not re-keyed for ${client.slug}:`, err instanceof Error ? err.message : err);
    });
    return result;
  };

  // First the pictures earlier runs left missing: the months below may all be complete and reach no ad.
  for (const { account, tiktok } of clientsByAccount) await fillMissingPictures(client, account, tiktok, ctx);

  for (const m of months) {
    if (Date.now() - started > budget) {
      // The next request starts with this month: every month it covers begins before the day after it.
      return finish({ done: false, nextBefore: addDays(m.until, 1), months: done, rowsWritten });
    }
    if (await monthIsComplete(client.id, m.since, m.until)) {
      done.push({ month: m.month, status: "complete", rows: 0 });
      continue;
    }
    let rows = 0;
    for (const { account, tiktok } of clientsByAccount) {
      rows += await pullTiktokAdWindow(client, account, tiktok, m.since, m.until, ctx);
    }
    rowsWritten += rows;
    done.push({ month: m.month, status: "imported", rows });
    // TikTok throttles per advertiser; month-sized reports back to back invite it.
    await new Promise((r) => setTimeout(r, 300));
  }
  return finish({ done: true, nextBefore: null, months: done, rowsWritten });
}

function addDays(key: string, n: number): string {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** When this client's ad-level pass last succeeded, or null — the nightly gate. */
export async function lastTiktokAdLevelSuccess(clientId: string): Promise<Date | null> {
  const res = await db.execute(sql`
    SELECT max(started_at) AS at FROM sync_runs
    WHERE client_id = ${clientId}::uuid AND kind = 'tiktok_adlevel' AND status = 'success'
  `);
  const at = (res as unknown as { rows: Array<{ at: string | Date | null }> }).rows[0]?.at;
  return at ? new Date(at) : null;
}

/** `excluded.<column>` for every column a row sets, so a multi-row upsert writes each row's own values. */
function excluded(table: unknown, sample: Record<string, unknown>): Record<string, SQL> {
  const set: Record<string, SQL> = {};
  for (const key of Object.keys(sample)) {
    const name = ((table as Record<string, unknown>)[key] as { name?: unknown } | undefined)?.name;
    if (typeof name === "string") set[key] = sql.raw(`excluded."${name}"`);
  }
  return set;
}

/** A string field, or null — TikTok sends ids as numbers on some endpoints. */
function text(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return typeof v === "string" && v.trim() ? v : null;
}

/** The info object with every URL removed: signed, short-lived, and not ours to keep. */
function withoutUrls(info: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(info).filter(([k, v]) => !/url/i.test(k) && !(typeof v === "string" && /^https?:\/\//i.test(v))),
  );
}
