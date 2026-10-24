import { and, eq, lt, sql, type SQL } from "drizzle-orm";
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
    // One account's failure must not stop the others. A closed location's
    // revoked access used to freeze every healthy account after it, while the
    // health check said only the dead account was missing. Each account now
    // syncs on its own; the run still ends failed (so not reconciled, and
    // retried) when any account failed, so the dead one stays visible.
    const failures: unknown[] = [];
    // Serialised per account — Meta warns that firing several insights queries
    // at once invites throttling.
    for (const account of accounts) {
      try {
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
      } catch (err) {
        failures.push(err);
      }
    }
    if (failures.length > 0) throw failures[0];

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

  const batch: Array<typeof fbDailyMetrics.$inferInsert> = [];
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
    batch.push(values);
  }
  return upsertFbDailyRows(batch);
}

/** Rows per INSERT. A year of ad-level history is tens of thousands of rows; one round trip each would not fit a request. */
const UPSERT_BATCH = 250;

/** `excluded.<column>` for every column a row sets, so a multi-row upsert writes each row's own values. */
function excludedSet(table: Record<string, unknown>, sample: Record<string, unknown>): Record<string, SQL> {
  const set: Record<string, SQL> = {};
  for (const key of Object.keys(sample)) {
    const name = (table[key] as { name?: unknown } | undefined)?.name;
    if (typeof name === "string") set[key] = sql.raw(`excluded."${name}"`);
  }
  return set;
}

/**
 * Upsert daily metric rows in batches.
 *
 * Upsert, not insert — this is what makes re-pulling a restated day correct
 * rather than a duplicate-key error. Rows are de-duplicated on the conflict key
 * first: Postgres refuses a statement that would update one row twice.
 *
 * `raw` is merged, not replaced. If Meta ever refuses the optional results
 * fields, the retry stores a row without them — and that must not erase the
 * results an earlier run stored for the same day.
 */
export async function upsertFbDailyRows(
  rows: ReadonlyArray<typeof fbDailyMetrics.$inferInsert>,
): Promise<number> {
  const byKey = new Map<string, typeof fbDailyMetrics.$inferInsert>();
  for (const r of rows) {
    byKey.set(
      [r.clientId, r.metaAdAccountId, r.date, r.level, r.metaCampaignId, r.metaAdsetId, r.metaAdId].join("|"),
      r,
    );
  }
  const unique = [...byKey.values()];
  for (let i = 0; i < unique.length; i += UPSERT_BATCH) {
    const chunk = unique.slice(i, i + UPSERT_BATCH);
    await db
      .insert(fbDailyMetrics)
      .values(chunk)
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
        set: {
          ...excludedSet(fbDailyMetrics as unknown as Record<string, unknown>, chunk[0] as Record<string, unknown>),
          raw: sql`COALESCE(${fbDailyMetrics.raw}, '{}'::jsonb) || excluded.raw`,
        },
      });
  }
  return unique.length;
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
  opts: { statuses?: readonly string[] } = {},
): Promise<Map<string, { key: string; type: CreativeType }>> {
  const meta = metaClientForAccount(account, client.agencyId);
  const ads = await meta.getAds(account.adAccountId, opts);

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
        /*
         * `raw` merged, not replaced: a listing run without the preview link
         * (Meta refused the field) must not erase the link stored before.
         */
        set: {
          ...values,
          raw: sql`COALESCE(${metaAdCreatives.raw}, '{}'::jsonb) || excluded.raw`,
        },
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
export async function syncAccountPeriodReach(
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

/* ------------------------------------------------------------------ *
 * Ad-level history import
 * ------------------------------------------------------------------ */

/** One calendar month of an import window, clipped to the window. */
export interface ImportMonth {
  /** "YYYY-MM". */
  month: string;
  since: string;
  until: string;
}

/**
 * The window's months, NEWEST first — the months a report reads first are the
 * ones that should land first — and only those before `before` (a day key), so
 * a resumed import picks up where the last request stopped.
 */
export function planMonths(window: { startKey: string; endKey: string }, before?: string): ImportMonth[] {
  const out: ImportMonth[] = [];
  let cursor = window.startKey;
  let guard = 0;
  while (cursor <= window.endKey && guard++ < 60) {
    const [y, m] = cursor.split("-").map(Number);
    const lastOfMonth = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    out.push({
      month: cursor.slice(0, 7),
      since: cursor,
      until: lastOfMonth < window.endKey ? lastOfMonth : window.endKey,
    });
    cursor = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  }
  out.reverse();
  return before ? out.filter((x) => x.since < before) : out;
}

export interface AdLevelImportResult {
  /** Every month of the window is now complete. */
  done: boolean;
  /** Where the next request carries on (months before this day), or null when done. */
  nextBefore: string | null;
  months: Array<{ month: string; status: "imported" | "complete"; rows: number }>;
  rowsWritten: number;
}

/** Meta asking for less, or our own refusal to truncate — both mean "ask for a shorter window". */
function isTooMuchData(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /reduce the amount of data|exceeded [\d,]+ rows/i.test(message);
}

function addDays(key: string, n: number): string {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(since: string, until: string): number {
  return Math.round((Date.parse(`${until}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)) / 86_400_000) + 1;
}

/**
 * Ad-level insights for one window, halving it when Meta says it is too much —
 * a large account's month of ads can exceed one response. Down to a week; a
 * week Meta still refuses is a real failure and is thrown.
 */
async function pullAdLevel(
  client: Client,
  account: MetaAdAccount,
  since: string,
  until: string,
  creatives: Map<string, { key: string; type: CreativeType }>,
): Promise<number> {
  try {
    return await syncAccountMetrics(client, account, since, until, client.timezone, "ad", creatives);
  } catch (err) {
    const days = daysBetween(since, until);
    if (!isTooMuchData(err) || days <= 7) throw err;
    const mid = addDays(since, Math.floor(days / 2) - 1);
    return (
      (await pullAdLevel(client, account, since, mid, creatives)) +
      (await pullAdLevel(client, account, addDays(mid, 1), until, creatives))
    );
  }
}

/** Spend by level for one window: a month whose ad rows already add up to its campaign rows is done. */
async function monthIsComplete(clientId: string, since: string, until: string): Promise<boolean> {
  const res = await db.execute(sql`
    SELECT COALESCE(SUM(spend) FILTER (WHERE level = 'campaign'), 0)::float AS campaign,
           COALESCE(SUM(spend) FILTER (WHERE level = 'ad'), 0)::float AS ad
    FROM fb_daily_metrics
    WHERE client_id = ${clientId} AND date >= ${since} AND date <= ${until}
  `);
  const row = (res as unknown as { rows: Array<{ campaign: number; ad: number }> }).rows[0];
  const campaign = Number(row?.campaign) || 0;
  const ad = Number(row?.ad) || 0;
  return campaign > 0 && Math.abs(ad - campaign) <= campaign * 0.005;
}

/** Ad id → creative identity, from what earlier syncs stored — for a resumed import. */
async function storedCreativeMap(clientId: string): Promise<Map<string, { key: string; type: CreativeType }>> {
  const rows = await db
    .select({
      adId: metaAdCreatives.metaAdId,
      key: metaAdCreatives.creativeKey,
      type: metaAdCreatives.creativeType,
    })
    .from(metaAdCreatives)
    .where(eq(metaAdCreatives.clientId, clientId));
  return new Map(rows.map((r) => [r.adId, { key: r.key ?? "", type: r.type ?? "unknown" }]));
}

/**
 * Import ad-level history — what creative cards, ad tables and every per-ad
 * stat read — for a window the nightly sync never reached.
 *
 * Campaign history is imported by `backfillClientMetrics`; ad rows only ever
 * came from the nightly 28-day reconcile, so before this a report on last
 * quarter's creatives had nothing to show. One request does as many months as
 * fit in `budgetMs` (a route has 300s) and says where to carry on; months whose
 * ad rows already add up to their campaign rows are skipped in a single query,
 * so pressing the button again resumes rather than starting over.
 *
 * The first request refreshes every ad's creative — archived ads included,
 * which Meta's default listing leaves out — so old months name their ads. It
 * writes no `sync_runs` row: an import that fails on a month from last year
 * must not turn the client's Meta pipe red for the sync that is working fine.
 */
export async function importMetaAdLevelHistory(
  client: Client,
  opts: { days: number; before?: string; budgetMs?: number },
): Promise<AdLevelImportResult> {
  const started = Date.now();
  const budget = opts.budgetMs ?? 180_000;
  const accounts = await activeAdAccounts(client.id);
  if (accounts.length === 0) throw new Error("Client has no Meta ad account configured");

  const months = planMonths(trailingWindowInclusive(opts.days, client.timezone), opts.before);

  let creatives: Map<string, { key: string; type: CreativeType }>;
  if (opts.before === undefined) {
    creatives = new Map();
    for (const account of accounts) {
      for (const [k, v] of await syncAccountCreatives(client, account)) creatives.set(k, v);
      try {
        for (const [k, v] of await syncAccountCreatives(client, account, { statuses: ["ARCHIVED"] })) {
          if (!creatives.has(k)) creatives.set(k, v);
        }
      } catch (err) {
        // Best effort: an account with too many archived ads to list still imports, just less named.
        console.warn(`[meta] archived ads not listed for ${account.adAccountId}:`, err instanceof Error ? err.message : err);
      }
    }
  } else {
    creatives = await storedCreativeMap(client.id);
  }

  const done: AdLevelImportResult["months"] = [];
  let rowsWritten = 0;
  for (const m of months) {
    if (Date.now() - started > budget) {
      // The next request starts with this month: every month it covers begins before the day after it.
      return { done: false, nextBefore: addDays(m.until, 1), months: done, rowsWritten };
    }
    if (await monthIsComplete(client.id, m.since, m.until)) {
      done.push({ month: m.month, status: "complete", rows: 0 });
      continue;
    }
    let rows = 0;
    for (const account of accounts) {
      rows += await pullAdLevel(client, account, m.since, m.until, creatives);
    }
    rowsWritten += rows;
    done.push({ month: m.month, status: "imported", rows });
    // Meta warns that firing queries back to back invites throttling.
    await new Promise((r) => setTimeout(r, 300));
  }
  return { done: true, nextBefore: null, months: done, rowsWritten };
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
