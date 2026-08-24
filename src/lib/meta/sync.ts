import { and, eq, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  clients,
  fbBreakdownMetrics,
  fbDailyMetrics,
  fbPeriodReach,
  metaAdAccounts,
  metaAdCreatives,
  syncRuns,
  type Client,
  type DeliveryRanking,
  type MetaAdAccount,
} from "@/db/schema";
import { META_BREAKDOWNS, parseInsightRow, segmentLabel } from "./client";
import { resolveCreative, type CreativeType } from "./creative";
import { activeAdAccounts, metaClientForAccount } from "./accounts";
import {
  META_PROVISIONAL_DAYS,
  isProvisional,
  todayKey,
  trailingWindowInclusive,
} from "@/lib/dates";

/**
 * How far back each nightly run re-pulls.
 *
 * Meta restates spend and conversions for up to 28 days as attribution windows
 * fill, so a write-once-and-never-revisit sync drifts permanently out of
 * agreement with Ads Manager. We re-pull the ENTIRE restatement window every
 * night and upsert, so every day still eligible to change keeps being trued up
 * until Meta finalises it — which is what makes an arbitrary calendar range
 * match Ads Manager exactly, not merely the last few days. Coupled to
 * META_PROVISIONAL_DAYS so the "still changing" and "still re-pulled" windows
 * can never silently drift apart. (Earlier this was 7, which left days 8–28
 * frozen at stale values.)
 */
export const RECONCILE_DAYS = META_PROVISIONAL_DAYS;

/** Dashboards older than this trigger a background refresh on load. */
export const STALE_AFTER_MS = 15 * 60 * 1000;

export interface SyncOptions {
  /** `YYYY-MM-DD` in the client's timezone. Defaults to a trailing window. */
  since?: string;
  until?: string;
  /** Also refresh cached period-reach rows. Skipped on fast intraday syncs. */
  includeReach?: boolean;
  /**
   * This is a FULL trailing-window reconciliation, so stamp
   * `clients.lastReconciledAt` on success.
   *
   * Set only by the cron routes. The intraday stale-while-revalidate path calls
   * this same function with `since = until = today`, and if that also counted as
   * a reconcile, a dashboard someone keeps open would look permanently up to
   * date while never being trued up against Meta's 28-day restatements.
   */
  isReconcile?: boolean;
  /**
   * This is the best-effort current-day refresh fired by a dashboard load, so
   * log it under `meta_intraday` rather than `meta_daily`.
   *
   * Health reads only the full-sync kind. An intraday run races the page
   * response and can be killed with the invocation; letting it write the same
   * kind meant a page view could either mask a dead cron ("synced 2m ago") or
   * fake a red ("last sync failed") for a pipe that was never broken.
   */
  intraday?: boolean;
  /**
   * Also run the ad-level pass: resolve every ad's creative, then pull insights
   * at `level=ad` and stamp the creative key onto each row.
   *
   * Off by default because it is materially more work — a second insights query
   * over the same window at a much higher row count, plus an ads listing and
   * one video-length lookup per new asset. The intraday refresh runs on every
   * dashboard load and must stay cheap; the nightly reconciliation turns this
   * on, which is the right cadence for creative reporting anyway.
   */
  includeAdLevel?: boolean;
  /**
   * Also pull the audience breakdowns (age, gender, region, placement, device).
   *
   * Five extra insights requests per account, so it shares the ad-level cadence:
   * on the nightly reconciliation and a manual sync, never on the intraday
   * refresh that fires on every dashboard load.
   */
  includeBreakdowns?: boolean;
}

/**
 * Pull Meta insights for one client and upsert them.
 *
 * Iterates EVERY active ad account attached to the client and tags each row
 * with its `metaAdAccountId`, so a multi-account client's spend accumulates
 * rather than one account overwriting another. The read side then sums across
 * accounts automatically, since every row shares the client id.
 *
 * Returns the number of daily rows written across all accounts. Throws on a
 * hard API failure so the caller can record it — a sync that silently no-ops is
 * exactly the failure mode that left six blocks of the old spreadsheet empty.
 */
export async function syncClientMetrics(
  client: Client,
  opts: SyncOptions = {},
): Promise<{ rowsWritten: number; runId: string }> {
  const [run] = await db
    .insert(syncRuns)
    .values({
      clientId: client.id,
      kind: opts.intraday ? "meta_intraday" : "meta_daily",
      status: "running",
    })
    .returning({ id: syncRuns.id });

  try {
    const accounts = await activeAdAccounts(client.id);
    if (accounts.length === 0) {
      throw new Error("Client has no Meta ad account configured");
    }

    const tz = client.timezone;
    const window = trailingWindowInclusive(RECONCILE_DAYS, tz);
    const since = opts.since ?? window.startKey;
    const until = opts.until ?? window.endKey;

    let written = 0;
    /*
     * Breakdowns that Meta refused, collected rather than thrown.
     *
     * One rejected breakdown must not fail a sync that pulled spend, leads and
     * creatives correctly — but it must not vanish either, or that panel
     * silently serves stale data forever. Recorded on the sync_run, so the
     * failure is visible without being fatal.
     */
    const breakdownFailures: string[] = [];
    // Serialised per account — Meta warns that firing several insights queries
    // at once invites throttling.
    for (const account of accounts) {
      written += await syncAccountMetrics(client, account, since, until, tz);

      /*
       * The ad-level pass. Creatives are resolved FIRST because the metrics
       * rows carry the creative key — running insights before the mapping
       * exists would write a window of ad rows with empty creative keys that
       * only the next night's run would repair, and any leaderboard read in
       * between would silently omit them.
       */
      if (opts.includeAdLevel) {
        const creatives = await syncAccountCreatives(client, account);
        written += await syncAccountMetrics(
          client,
          account,
          since,
          until,
          tz,
          "ad",
          creatives,
        );
      }

      if (opts.includeBreakdowns) {
        const b = await syncAccountBreakdowns(client, account, since, until);
        written += b.rowsWritten;
        breakdownFailures.push(...b.failures);
      }

      if (opts.includeReach) {
        await syncAccountPeriodReach(client, account, since, until);
      }
      await db
        .update(metaAdAccounts)
        .set({ lastSyncedAt: new Date() })
        .where(eq(metaAdAccounts.id, account.id));
    }

    // Stamped only on success — a failed run must never look reconciled, or the
    // overdue gate would skip the client until tomorrow.
    const finishedAt = new Date();
    await db
      .update(clients)
      .set({
        lastSyncedAt: finishedAt,
        ...(opts.isReconcile ? { lastMetaReconciledAt: finishedAt } : {}),
      })
      .where(eq(clients.id, client.id));

    await db
      .update(syncRuns)
      .set({
        status: "success",
        finishedAt,
        rowsWritten: written,
        meta: {
          since,
          until,
          accounts: accounts.length,
          ...(breakdownFailures.length ? { breakdownFailures } : {}),
        },
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

/**
 * Daily insights for one account of a client, at one level.
 *
 * Campaign level is the dashboard's spine and always runs. Ad level is a second
 * pass over the same window with a wider field set, and it is what makes
 * creative reporting possible — the plan called this "a sync change, not a
 * migration", and it is: `fb_daily_metrics.level` was always an enum column,
 * only ever written with one value.
 *
 * `creatives` maps ad id → creative identity, resolved separately (insights
 * carries none). It is denormalised onto each ad row so the creative
 * leaderboard is one indexed GROUP BY rather than a join.
 */
async function syncAccountMetrics(
  client: Client,
  account: MetaAdAccount,
  since: string,
  until: string,
  tz: string,
  level: "campaign" | "ad" = "campaign",
  creatives?: Map<string, { key: string; type: CreativeType }>,
): Promise<number> {
  const meta = metaClientForAccount(account, client.agencyId);
  const rows = await meta.getDailyInsights(
    account.adAccountId,
    since,
    until,
    level,
  );

  let written = 0;
  for (const raw of rows) {
    const parsed = parseInsightRow(raw);
    const isAd = level === "ad";
    const creative = isAd ? creatives?.get(parsed.adId) : undefined;

    const values = {
      clientId: client.id,
      metaAdAccountId: account.adAccountId,
      date: parsed.dateKey,
      level,
      metaCampaignId: parsed.campaignId,
      campaignName: parsed.campaignName,
      // Empty strings above ad level keep campaign rows on their own unique key.
      metaAdsetId: isAd ? parsed.adsetId : "",
      adsetName: isAd ? parsed.adsetName : null,
      metaAdId: isAd ? parsed.adId : "",
      adName: isAd ? parsed.adName : null,
      creativeKey: creative?.key ?? "",
      creativeType: creative?.type ?? ("unknown" as const),

      reach: parsed.reach,
      impressions: parsed.impressions,
      clicksAll: parsed.clicksAll,
      linkClicks: parsed.linkClicks,
      inlineLinkClicks: parsed.inlineLinkClicks,
      spend: String(parsed.spend),
      leadsTotal: parsed.leadsTotal,
      leadsPixel: parsed.leadsPixel,
      leadsOnsite: parsed.leadsOnsite,

      video3sViews: parsed.video3sViews,
      videoPlays: parsed.videoPlays,
      thruPlays: parsed.thruPlays,
      videoP25: parsed.videoP25,
      videoP50: parsed.videoP50,
      videoP75: parsed.videoP75,
      videoP95: parsed.videoP95,
      videoP100: parsed.videoP100,
      landingPageViews: parsed.landingPageViews,
      outboundClicks: parsed.outboundClicks,

      // Rankings exist only at ad level; storing Meta's "unknown" above it would
      // read as a real diagnostic rather than a question that does not apply.
      qualityRanking: isAd
        ? (parsed.qualityRanking as DeliveryRanking | null)
        : null,
      engagementRateRanking: isAd
        ? (parsed.engagementRateRanking as DeliveryRanking | null)
        : null,
      conversionRateRanking: isAd
        ? (parsed.conversionRateRanking as DeliveryRanking | null)
        : null,

      currency: parsed.currency ?? account.currency,
      isProvisional: isProvisional(parsed.dateKey, tz),
      raw: raw as object,
      syncedAt: new Date(),
    };

    await db
      .insert(fbDailyMetrics)
      .values(values)
      // Upsert, not insert — this is what makes re-pulling a restated day
      // correct rather than a duplicate-key error.
      .onConflictDoUpdate({
        target: [
          fbDailyMetrics.clientId,
          fbDailyMetrics.metaAdAccountId,
          fbDailyMetrics.date,
          fbDailyMetrics.level,
          fbDailyMetrics.metaCampaignId,
          fbDailyMetrics.metaAdsetId,
          fbDailyMetrics.metaAdId,
        ],
        set: values,
      });
    written++;
  }
  return written;
}

/**
 * Audience breakdowns for one account: age, gender, region, placement, device.
 *
 * Five independent requests, because Meta permits only a documented subset of
 * breakdown permutations and `age`/`gender` appear in none alongside
 * `publisher_platform` / `platform_position` / `impression_device`.
 *
 * Each is caught individually. A breakdown Meta rejects — a combination it
 * withdraws in a later version, a field an account is not entitled to — must not
 * discard the four that worked, and must not fail a sync whose spend and leads
 * are correct. The failure is returned and lands on the `sync_run`, so it is
 * visible rather than silent.
 */
async function syncAccountBreakdowns(
  client: Client,
  account: MetaAdAccount,
  since: string,
  until: string,
): Promise<{ rowsWritten: number; failures: string[] }> {
  const meta = metaClientForAccount(account, client.agencyId);
  const tz = client.timezone;
  let rowsWritten = 0;
  const failures: string[] = [];

  for (const spec of META_BREAKDOWNS) {
    try {
      const rows = await meta.getBreakdownInsights(
        account.adAccountId,
        since,
        until,
        spec,
      );

      for (const raw of rows) {
        const parsed = parseInsightRow(raw);
        const values = {
          clientId: client.id,
          metaAdAccountId: account.adAccountId,
          // Daily granularity: start == end. Any date range aggregates from
          // these; period-only rows would leave the date picker inert here.
          dateStart: parsed.dateKey,
          dateEnd: parsed.dateKey,
          level: "account" as const,
          metaCampaignId: "",
          breakdownKey: spec.key,
          segmentValue: segmentLabel(spec, raw),

          impressions: parsed.impressions,
          clicksAll: parsed.clicksAll,
          linkClicks: parsed.linkClicks,
          spend: String(parsed.spend),
          leadsTotal: parsed.leadsTotal,
          // Valid for THIS segment on THIS day only. The read side refuses to
          // sum it, exactly as it refuses to sum daily reach.
          reach: parsed.reach,

          isProvisional: isProvisional(parsed.dateKey, tz),
          syncedAt: new Date(),
        };

        await db
          .insert(fbBreakdownMetrics)
          .values(values)
          .onConflictDoUpdate({
            target: [
              fbBreakdownMetrics.clientId,
              fbBreakdownMetrics.metaAdAccountId,
              fbBreakdownMetrics.dateStart,
              fbBreakdownMetrics.dateEnd,
              fbBreakdownMetrics.level,
              fbBreakdownMetrics.metaCampaignId,
              fbBreakdownMetrics.breakdownKey,
              fbBreakdownMetrics.segmentValue,
            ],
            set: values,
          });
        rowsWritten++;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[meta] ${spec.key} breakdown failed`, message);
      failures.push(`${spec.key}: ${message.slice(0, 200)}`);
    }
  }

  return { rowsWritten, failures };
}

/**
 * Resolve every ad in the account to the creative it shows, and store it.
 *
 * Returns ad id → creative identity so the ad-level insights pass can stamp it
 * onto each metrics row.
 *
 * Video durations are fetched for the videos we have not already measured —
 * they never change, so re-reading them nightly would be pure API budget spent
 * on a constant. They exist solely to keep hold rate honest: ThruPlay changes
 * definition at 15 seconds, so a benchmark without a length is a benchmark
 * against the wrong thing.
 */
async function syncAccountCreatives(
  client: Client,
  account: MetaAdAccount,
): Promise<Map<string, { key: string; type: CreativeType }>> {
  const meta = metaClientForAccount(account, client.agencyId);
  const ads = await meta.getAds(account.adAccountId);

  const resolved = ads.map((ad) => ({ ad, creative: resolveCreative(ad.creative) }));

  // Durations we already hold — a video's length is immutable, so this is a
  // one-time cost per asset rather than a nightly one.
  const known = await db
    .select({
      videoId: metaAdCreatives.videoId,
      len: metaAdCreatives.videoLengthSeconds,
    })
    .from(metaAdCreatives)
    .where(eq(metaAdCreatives.clientId, client.id));
  const haveLength = new Set(
    known.filter((k) => k.videoId && k.len !== null).map((k) => k.videoId as string),
  );

  const missing = resolved
    .map((r) => r.creative.videoId)
    .filter((v): v is string => typeof v === "string" && v !== "" && !haveLength.has(v));
  const lengths = missing.length > 0 ? await meta.getVideoLengths(missing) : new Map();
  const knownLen = new Map(
    known
      .filter((k) => k.videoId && k.len !== null)
      .map((k) => [k.videoId as string, Number(k.len)]),
  );

  const out = new Map<string, { key: string; type: CreativeType }>();

  for (const { ad, creative } of resolved) {
    const videoLength = creative.videoId
      ? (lengths.get(creative.videoId) ?? knownLen.get(creative.videoId) ?? null)
      : null;

    const values = {
      clientId: client.id,
      metaAdAccountId: account.adAccountId,
      metaAdId: ad.id,
      adName: ad.name ?? null,
      metaAdsetId: ad.adset_id ?? null,
      metaCampaignId: ad.campaign_id ?? null,
      metaCreativeId:
        typeof ad.creative?.id === "string" ? (ad.creative.id as string) : null,
      creativeKey: creative.key,
      creativeType: creative.type,
      imageHash: creative.imageHash,
      videoId: creative.videoId,
      videoLengthSeconds: videoLength === null ? null : String(videoLength),
      title: creative.title,
      body: creative.body,
      callToActionType: creative.callToActionType,
      linkUrl: creative.linkUrl,
      thumbnailUrl: creative.thumbnailUrl,
      status: ad.status ?? null,
      /*
       * Learning state, from the ad set. A correctness input for keep/kill
       * rather than a decoration: an ad set still in LEARNING has not reached
       * its steady-state cost per result, so recommending a kill on its current
       * numbers is exactly the wrong call.
       */
      learningStage: ad.adset?.learning_stage_info?.status ?? null,
      raw: ad as object,
      syncedAt: new Date(),
    };

    await db
      .insert(metaAdCreatives)
      .values(values)
      .onConflictDoUpdate({
        target: [metaAdCreatives.clientId, metaAdCreatives.metaAdId],
        set: values,
      });

    out.set(ad.id, { key: creative.key, type: creative.type });
  }

  return out;
}

/**
 * Cache reach for one account over one period, as a single query.
 *
 * Kept separate from the daily sync precisely because reach cannot be derived
 * from daily rows — see the note on `fbPeriodReach`. Note reach also cannot be
 * summed ACROSS accounts (one person reached by two accounts is one person), so
 * it is stored per account and the dashboard treats a multi-account total as
 * unavailable rather than adding them.
 */
async function syncAccountPeriodReach(
  client: Client,
  account: MetaAdAccount,
  since: string,
  until: string,
): Promise<number> {
  const meta = metaClientForAccount(account, client.agencyId);
  // ACCOUNT-level, not campaign-level: reach is deduplicated people and cannot be
  // summed across campaigns, so we store the one true account total (campaign id
  // "") that the read side can trust. A per-campaign pull produced rows the reader
  // could only pick from arbitrarily, understating reach.
  const rows = await meta.getPeriodReach(account.adAccountId, since, until, "account");

  let written = 0;
  for (const r of rows) {
    const values = {
      clientId: client.id,
      metaAdAccountId: account.adAccountId,
      periodStart: since,
      periodEnd: until,
      metaCampaignId: r.campaignId,
      reach: r.reach,
      frequency: String(r.frequency),
      syncedAt: new Date(),
    };
    await db
      .insert(fbPeriodReach)
      .values(values)
      .onConflictDoUpdate({
        target: [
          fbPeriodReach.clientId,
          fbPeriodReach.metaAdAccountId,
          fbPeriodReach.periodStart,
          fbPeriodReach.periodEnd,
          fbPeriodReach.metaCampaignId,
        ],
        set: values,
      });
    written++;
  }
  return written;
}

/**
 * Backfill historical daily metrics, chunked by month.
 *
 * Chunked rather than one big call to stay under Meta's row limits and so a
 * throttle mid-way loses only the current chunk. Meta retains at most 37 months.
 */
export async function backfillClientMetrics(
  client: Client,
  days = 90,
): Promise<number> {
  const [run] = await db
    .insert(syncRuns)
    .values({ clientId: client.id, kind: "meta_backfill", status: "running" })
    .returning({ id: syncRuns.id });

  try {
    const tz = client.timezone;
    const window = trailingWindowInclusive(days, tz);
    let total = 0;

    // Walk month-sized chunks from the start of the window to today.
    let cursor = window.startKey;
    let guard = 0;
    while (cursor <= window.endKey && guard++ < 60) {
      const [y, m] = cursor.split("-").map(Number);
      const lastOfMonth = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
      const chunkEnd = lastOfMonth < window.endKey ? lastOfMonth : window.endKey;

      const { rowsWritten } = await syncClientMetrics(client, {
        since: cursor,
        until: chunkEnd,
      });
      total += rowsWritten;

      const next = new Date(Date.UTC(y, m, 1));
      cursor = next.toISOString().slice(0, 10);
      // Meta warns that firing several queries at once invites throttling.
      await new Promise((r) => setTimeout(r, 500));
    }

    await db
      .update(syncRuns)
      .set({ status: "success", finishedAt: new Date(), rowsWritten: total })
      .where(eq(syncRuns.id, run.id));
    return total;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(syncRuns)
      .set({ status: "failed", finishedAt: new Date(), error: message })
      .where(eq(syncRuns.id, run.id));
    throw err;
  }
}

/**
 * Stale-while-revalidate entry point, called on dashboard load.
 *
 * Returns immediately if data is fresh. Otherwise takes a Postgres advisory
 * lock and syncs TODAY only — a fast single-day pull, not the full window — so
 * the page never blocks. The lock means ten people opening the same dashboard
 * trigger one sync, not ten.
 */
export async function refreshIfStale(client: Client): Promise<boolean> {
  const fresh =
    client.lastSyncedAt &&
    Date.now() - client.lastSyncedAt.getTime() < STALE_AFTER_MS;
  if (fresh) return false;

  // Nothing to refresh if the client has no ad accounts yet.
  const accounts = await activeAdAccounts(client.id);
  if (accounts.length === 0) return false;

  // A TRANSACTION-scoped advisory lock, not a session-scoped one. The old
  // pg_try_advisory_lock + pg_advisory_unlock ran as two separate statements on
  // a connection pool, so the unlock could land on a different connection than
  // the one holding the lock — silently failing and wedging this client's
  // intraday refresh until the idle connection closed. pg_advisory_xact_lock is
  // bound to the transaction and released automatically (same connection) when it
  // ends, so it cannot leak.
  const lockKey = hashToInt(client.id);
  try {
    return await db.transaction(async (tx) => {
      const { rows } = (await tx.execute<{ locked: boolean }>(
        sql`SELECT pg_try_advisory_xact_lock(${lockKey}) AS locked`,
      )) as unknown as { rows: Array<{ locked: boolean }> };
      if (!rows[0]?.locked) return false;
      const today = todayKey(client.timezone);
      await syncClientMetrics(client, {
        since: today,
        until: today,
        intraday: true,
      });
      return true;
    });
  } catch (err) {
    console.error(`[meta] refresh failed for ${client.slug}:`, err);
    return false;
  }
}

/** Stable 32-bit key from a uuid, for pg advisory locks. */
function hashToInt(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return h;
}

/**
 * Mark abandoned `sync_runs` rows as failed.
 *
 * A run can only end three ways: success, a caught error, or the process being
 * killed. The third writes no terminal status — `syncClientMetrics` updates the
 * row inside `try`/`catch`, and a hard timeout at the route's `maxDuration` runs
 * neither branch. The row then sits in `running` forever, and the health
 * checklist reads a stale "in progress" instead of the failure it was.
 *
 * Nothing can legitimately outlive the route's own 300s ceiling, so anything
 * older than this cutoff was killed. Called at the top of each cron run.
 */
export async function reapAbandonedSyncRuns(
  olderThanMinutes = 30,
): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);
  const reaped = await db
    .update(syncRuns)
    .set({
      status: "failed",
      finishedAt: new Date(),
      error: `abandoned — no terminal status recorded within ${olderThanMinutes}m (process killed mid-run)`,
    })
    .where(and(eq(syncRuns.status, "running"), lt(syncRuns.startedAt, cutoff)))
    .returning({ id: syncRuns.id });
  return reaped.length;
}
