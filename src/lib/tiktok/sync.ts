import { eq, max, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  clients,
  syncRuns,
  tiktokAdAccounts,
  tiktokDailyMetrics,
  type Client,
  type TiktokAdAccount,
} from "@/db/schema";
import { decryptNullable } from "@/lib/crypto";
import { todayKey, trailingWindowInclusive } from "@/lib/dates";
import { TiktokClient, dayOf, num } from "./client";
import { activeTiktokAccounts } from "./accounts";

/**
 * Pulling TikTok spend.
 *
 * Deliberately the same shape as the Google sync — trailing re-pull, upsert,
 * one `sync_runs` row per invocation, a distinct `intraday` kind so a
 * best-effort dashboard refresh can never stand in for a reconciliation in the
 * health checks.
 *
 * ── 🔴 The date TikTok gives back is not a date ───────────────────────
 *
 * `stat_time_day` arrives as `"2026-07-01 00:00:00"`, not `"2026-07-01"`.
 * Truncated once, on ingest, by `dayOf`.
 *
 * ⚠️ Not for the reason this comment used to give. It claimed the two spellings
 * would produce two rows for one day — they do not: the column is `date`, and
 * Postgres coerces the timestamp form BEFORE evaluating the unique index, so
 * the upsert converges either way (verified against the real engine, and pinned
 * in `sync.test.ts`).
 *
 * What `dayOf` actually buys is the malformed case. An unvalidated value goes
 * to the driver and comes back as `invalid input syntax for type date`, which
 * throws out of the insert loop — so ONE bad row discards every row after it in
 * the batch and fails the whole run. Returning null instead skips that row and
 * lets the rest land. It also keeps the value a plain `YYYY-MM-DD` in JS, which
 * matters the moment anything keys off it.
 *
 * ── Days are bucketed in the ADVERTISER's timezone ────────────────────
 *
 * Same constraint as Meta, and it is why `tiktok_ad_accounts.timezone` exists.
 * We store what TikTok reports without shifting it, so a client whose dashboard
 * timezone disagrees with their advertiser timezone sees the same off-by-one
 * day boundaries they would see in TikTok's own reporting — which is the
 * behaviour to prefer, since the client reconciles against that.
 */

/**
 * Trailing window each nightly run re-pulls.
 *
 * 28, matching Meta and Google, and raised from 7 when the nightly cron was
 * added. 7 was only ever safe because nothing re-pulled at all: TikTok's
 * click-through attribution window reaches 28 days, so a conversion credited to
 * a click on day 1 can land on day 27 and restate that day's figures. A 7-day
 * window would have frozen every day older than a week at whatever was true
 * when it scrolled out — the drift this dashboard exists to remove.
 */
export const TIKTOK_RECONCILE_DAYS = 28;
export const TIKTOK_STALE_AFTER_MS = 15 * 60 * 1000;

export interface TiktokSyncOptions {
  since?: string;
  until?: string;
  /**
   * A FULL trailing-window reconciliation — stamp `clients.lastTiktokReconciledAt`
   * on success. Set only by the cron; the intraday refresh below must not, or a
   * client whose dashboard is open all day would look reconciled while only ever
   * having had today re-pulled. Separate from the Meta and Google markers so the
   * three crons cannot mark each other's work done.
   */
  isReconcile?: boolean;
  intraday?: boolean;
}

// Moved to `./accounts` so `pipe-status.ts` can read it without importing this
// whole module. Re-exported for the callers that already import it from here.
export { activeTiktokAccounts };

export async function syncClientTiktokMetrics(
  client: Client,
  opts: TiktokSyncOptions = {},
): Promise<{ rowsWritten: number; runId: string }> {
  const [run] = await db
    .insert(syncRuns)
    .values({
      clientId: client.id,
      kind: opts.intraday ? "tiktok_intraday" : "tiktok_daily",
      status: "running",
    })
    .returning({ id: syncRuns.id });

  try {
    const accounts = await activeTiktokAccounts(client.id);
    if (accounts.length === 0) {
      throw new Error("Client has no TikTok advertiser configured");
    }

    const window = trailingWindowInclusive(TIKTOK_RECONCILE_DAYS, client.timezone);
    const since = opts.since ?? window.startKey;
    const until = opts.until ?? window.endKey;

    let written = 0;
    for (const account of accounts) {
      written += await syncAccount(client, account, since, until);
    }

    // Stamped only on success — a failed run must never look reconciled.
    const finishedAt = new Date();
    if (opts.isReconcile) {
      await db
        .update(clients)
        .set({ lastTiktokReconciledAt: finishedAt })
        .where(eq(clients.id, client.id));
    }

    await db
      .update(syncRuns)
      .set({
        status: "success",
        finishedAt,
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

async function syncAccount(
  client: Client,
  account: TiktokAdAccount,
  since: string,
  until: string,
): Promise<number> {
  const token = decryptNullable(account.accessTokenEncrypted);
  if (!token) {
    /*
     * A null token is a normal end state, not a bug: TikTok invalidates a token
     * when the authorising user loses access. Recorded on the account so the
     * health check can say "re-authorise" rather than reporting zero spend.
     */
    await db
      .update(tiktokAdAccounts)
      .set({ lastError: "No access token — re-authorise this advertiser." })
      .where(eq(tiktokAdAccounts.id, account.id));
    return 0;
  }

  const tiktok = new TiktokClient(token);
  let rows;
  try {
    rows = await tiktok.getDailyInsights(account.advertiserId, since, until);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(tiktokAdAccounts)
      .set({ lastError: message })
      .where(eq(tiktokAdAccounts.id, account.id));
    throw err;
  }

  let written = 0;
  for (const row of rows) {
    const date = dayOf(row.dimensions.stat_time_day);
    // A row we cannot date cannot be stored against a day, and guessing today
    // would put yesterday's spend on the wrong side of a month boundary.
    if (!date) continue;

    const campaignId = row.dimensions.campaign_id ?? "";
    const name = row.metrics.campaign_name;

    await db
      .insert(tiktokDailyMetrics)
      .values({
        clientId: client.id,
        advertiserId: account.advertiserId,
        date,
        tiktokCampaignId: campaignId,
        campaignName: typeof name === "string" ? name : null,
        impressions: num(row.metrics.impressions),
        clicks: num(row.metrics.clicks),
        spend: String(num(row.metrics.spend)),
        conversions: String(num(row.metrics.conversion)),
        currency: account.currency,
        raw: row,
        syncedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          tiktokDailyMetrics.clientId,
          tiktokDailyMetrics.advertiserId,
          tiktokDailyMetrics.date,
          tiktokDailyMetrics.tiktokCampaignId,
        ],
        // Upsert, so the trailing re-pull corrects restated figures rather than
        // duplicating them — the same self-healing property the Meta sync has.
        set: {
          campaignName: typeof name === "string" ? name : null,
          impressions: num(row.metrics.impressions),
          clicks: num(row.metrics.clicks),
          spend: String(num(row.metrics.spend)),
          conversions: String(num(row.metrics.conversion)),
          raw: row,
          syncedAt: new Date(),
        },
      });
    written++;
  }

  await db
    .update(tiktokAdAccounts)
    .set({ lastSyncedAt: new Date(), lastError: null })
    .where(eq(tiktokAdAccounts.id, account.id));

  return written;
}

/**
 * Stale-while-revalidate for TikTok, called on dashboard load alongside Meta's
 * and Google's.
 *
 * 🔴 This was once the ONLY caller of `syncClientTiktokMetrics`: the sync
 * existed, the query layer supported the platform, and the toggle rendered it,
 * but nothing ever ran it, so connecting a TikTok advertiser produced a
 * permanently empty tab with a green health check.
 *
 * It is no longer alone — `/api/cron/tiktok-sync` now reconciles the trailing
 * window nightly — but the two are not interchangeable and neither is
 * redundant. This path keeps TODAY warm between nightly runs and only ever
 * re-pulls today; the cron is what corrects the previous 28 days as TikTok
 * restates them. Note that it lives on the free GitHub Actions schedule rather
 * than in `vercel.json`, whose two Hobby cron slots are spent on Meta and
 * Google.
 *
 * A DISTINCT advisory lock key, so it never blocks the Meta or Google refresh.
 * Freshness is read from the TikTok accounts, not `clients.lastSyncedAt`, which
 * belongs to Meta.
 */
export async function refreshTiktokIfStale(client: Client): Promise<boolean> {
  const accounts = await activeTiktokAccounts(client.id);
  if (accounts.length === 0) return false;

  const [{ last }] = await db
    .select({ last: max(tiktokAdAccounts.lastSyncedAt) })
    .from(tiktokAdAccounts)
    .where(eq(tiktokAdAccounts.clientId, client.id));
  if (last && Date.now() - last.getTime() < TIKTOK_STALE_AFTER_MS) return false;

  /*
   * Transaction-scoped advisory lock, matching the other two. A session-scoped
   * lock's unlock can run on a different pooled connection and leak the lock
   * for the life of that backend.
   */
  const lockKey = hashToInt(`tiktok:${client.id}`);
  try {
    return await db.transaction(async (tx) => {
      const { rows } = (await tx.execute<{ locked: boolean }>(
        sql`SELECT pg_try_advisory_xact_lock(${lockKey}) AS locked`,
      )) as unknown as { rows: Array<{ locked: boolean }> };
      if (!rows[0]?.locked) return false;
      const today = todayKey(client.timezone);
      await syncClientTiktokMetrics(client, {
        since: today,
        until: today,
        intraday: true,
      });
      return true;
    });
  } catch (err) {
    console.error(`[tiktok] refresh failed for ${client.slug}:`, err);
    return false;
  }
}

/** Stable 32-bit key for `pg_try_advisory_xact_lock`. */
function hashToInt(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}
