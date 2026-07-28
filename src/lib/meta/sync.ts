import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  clients,
  fbDailyMetrics,
  fbPeriodReach,
  metaAdAccounts,
  syncRuns,
  type Client,
  type MetaAdAccount,
} from "@/db/schema";
import { parseInsightRow } from "./client";
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
    .values({ clientId: client.id, kind: "meta_daily", status: "running" })
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
    // Serialised per account — Meta warns that firing several insights queries
    // at once invites throttling.
    for (const account of accounts) {
      written += await syncAccountMetrics(client, account, since, until, tz);
      if (opts.includeReach) {
        await syncAccountPeriodReach(client, account, since, until);
      }
      await db
        .update(metaAdAccounts)
        .set({ lastSyncedAt: new Date() })
        .where(eq(metaAdAccounts.id, account.id));
    }

    await db
      .update(clients)
      .set({ lastSyncedAt: new Date() })
      .where(eq(clients.id, client.id));

    await db
      .update(syncRuns)
      .set({
        status: "success",
        finishedAt: new Date(),
        rowsWritten: written,
        meta: { since, until, accounts: accounts.length },
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

/** Daily insights for one account of a client. */
async function syncAccountMetrics(
  client: Client,
  account: MetaAdAccount,
  since: string,
  until: string,
  tz: string,
): Promise<number> {
  const meta = metaClientForAccount(account);
  const rows = await meta.getDailyInsights(
    account.adAccountId,
    since,
    until,
    "campaign",
  );

  let written = 0;
  for (const raw of rows) {
    const parsed = parseInsightRow(raw);
    const values = {
      clientId: client.id,
      metaAdAccountId: account.adAccountId,
      date: parsed.dateKey,
      level: "campaign" as const,
      metaCampaignId: parsed.campaignId,
      campaignName: parsed.campaignName,
      reach: parsed.reach,
      impressions: parsed.impressions,
      clicksAll: parsed.clicksAll,
      linkClicks: parsed.linkClicks,
      inlineLinkClicks: parsed.inlineLinkClicks,
      spend: String(parsed.spend),
      leadsTotal: parsed.leadsTotal,
      leadsPixel: parsed.leadsPixel,
      leadsOnsite: parsed.leadsOnsite,
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
        ],
        set: values,
      });
    written++;
  }
  return written;
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
  const meta = metaClientForAccount(account);
  const rows = await meta.getPeriodReach(account.adAccountId, since, until);

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

  // Advisory lock keyed on the client uuid; non-blocking.
  const lockKey = hashToInt(client.id);
  const [{ locked }] = await db.execute<{ locked: boolean }>(
    sql`SELECT pg_try_advisory_lock(${lockKey}) AS locked`,
  ).then((r) => (r as unknown as { rows: Array<{ locked: boolean }> }).rows);

  if (!locked) return false;

  try {
    const today = todayKey(client.timezone);
    await syncClientMetrics(client, { since: today, until: today });
    return true;
  } catch (err) {
    console.error(`[meta] refresh failed for ${client.slug}:`, err);
    return false;
  } finally {
    await db.execute(sql`SELECT pg_advisory_unlock(${lockKey})`);
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
 * Which clients are due for their nightly reconciliation?
 *
 * Meta buckets days in the ad account's timezone, so "just after midnight"
 * differs per client. We run the cron hourly and each run picks up only the
 * clients whose local hour matches — a single global 11:59pm run would cut some
 * clients' days short and start others' before they began.
 */
export function isDueForNightlySync(
  client: Client,
  targetHour = 2,
  now: Date = new Date(),
): boolean {
  const localHour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: client.timezone,
      hour: "numeric",
      hour12: false,
    }).format(now),
  );
  return localHour === targetHour;
}
