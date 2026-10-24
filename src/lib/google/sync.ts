import { eq, max, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  clients,
  googleAdAccounts,
  googleDailyMetrics,
  syncRuns,
  type Client,
  type GoogleAdAccount,
} from "@/db/schema";
import { googleClientForAccount, activeGoogleAccounts } from "./accounts";
import { todayKey, trailingWindowInclusive } from "@/lib/dates";
import { GOOGLE_EXTRA_FAMILIES, type GoogleExtraFamily } from "@/lib/metrics/platform-extras";

/**
 * Google Ads sync — the mirror of `meta/sync.ts`.
 *
 * One difference worth noting: Google does NOT stamp `clients.lastSyncedAt` (that
 * marker belongs to Meta and drives the "Meta data fresh" health check). Google
 * freshness lives on `googleAdAccounts.lastSyncedAt` instead, so the two
 * platforms' liveness never cross-contaminate. The one `clients` column Google
 * does write is `lastGoogleReconciledAt`, its own cron scheduling marker — again
 * separate from Meta's, for the same reason.
 */

/** Trailing window each nightly run re-pulls. Google restates conversions for
 *  weeks as well, so we re-pull the same 28-day window as Meta and upsert — the
 *  point is that ANY calendar range the operator picks matches the Google Ads
 *  UI exactly, not just the last few days. Trivial cost at daily cadence. */
export const GOOGLE_RECONCILE_DAYS = 28;
export const GOOGLE_STALE_AFTER_MS = 15 * 60 * 1000;

export interface GoogleSyncOptions {
  since?: string;
  until?: string;
  /**
   * A FULL trailing-window reconciliation — stamp `clients.lastGoogleReconciledAt`
   * on success. Set only by the cron; the intraday refresh below must not, or a
   * client viewed all day would never be trued up. Separate from the Meta marker
   * so the two crons cannot mark each other's work done.
   */
  isReconcile?: boolean;
  /**
   * Best-effort current-day refresh from a dashboard load — logged under
   * `google_intraday` so it never stands in for a reconciliation in the health
   * checks. See the note on `syncKindEnum`.
   */
  intraday?: boolean;
}

export async function syncClientGoogleMetrics(
  client: Client,
  opts: GoogleSyncOptions = {},
): Promise<{ rowsWritten: number; runId: string }> {
  const [run] = await db
    .insert(syncRuns)
    .values({
      clientId: client.id,
      kind: opts.intraday ? "google_intraday" : "google_daily",
      status: "running",
    })
    .returning({ id: syncRuns.id });

  try {
    const accounts = await activeGoogleAccounts(client.id);
    if (accounts.length === 0) {
      throw new Error("Client has no Google Ads account configured");
    }

    const tz = client.timezone;
    const window = trailingWindowInclusive(GOOGLE_RECONCILE_DAYS, tz);
    const since = opts.since ?? window.startKey;
    const until = opts.until ?? window.endKey;

    let written = 0;
    // One account's failure must not stop the others. A closed location's
    // revoked access used to freeze every healthy account after it, while the
    // health check said only the dead account was missing. Each account now
    // syncs on its own; the run still ends failed (so not reconciled, and
    // retried) when any account failed, so the dead one stays visible.
    const failures: unknown[] = [];
    for (const account of accounts) {
      try {
        written += await syncAccountGoogleMetrics(client, account, since, until);
        await db
          .update(googleAdAccounts)
          .set({ lastSyncedAt: new Date() })
          .where(eq(googleAdAccounts.id, account.id));
      } catch (err) {
        failures.push(err);
      }
    }
    if (failures.length > 0) throw failures[0];

    // Stamped only on success — a failed run must never look reconciled.
    const finishedAt = new Date();
    if (opts.isReconcile) {
      await db
        .update(clients)
        .set({ lastGoogleReconciledAt: finishedAt })
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

async function syncAccountGoogleMetrics(
  client: Client,
  account: GoogleAdAccount,
  since: string,
  until: string,
): Promise<number> {
  const google = googleClientForAccount(account, client.agencyId);
  const rows = await google.getDailyMetrics(account.customerId, since, until);
  // Best-effort by family, inside: a refusal costs those figures, never spend.
  const extras = await google.getDailyExtras(account.customerId, since, until);

  /*
   * A campaign-day can carry extra figures and no delivery — all conversions
   * credited to a day nothing was shown, say. Google leaves such a day out of
   * the delivery query, so it gets a row of its own with zero delivery, or
   * those conversions would be missing from every total.
   */
  const keyOf = (campaignId: string, dateKey: string) => `${campaignId}|${dateKey}`;
  const seen = new Set(rows.map((r) => keyOf(r.campaignId, r.dateKey)));
  const extraOnly = new Set<string>();
  for (const family of Object.values(extras)) {
    for (const [k, figures] of family ?? []) {
      if (!seen.has(k) && Object.values(figures).some((v) => v !== 0)) extraOnly.add(k);
    }
  }
  const all = [
    ...rows,
    ...[...extraOnly].map((k) => {
      const [campaignId, dateKey] = k.split("|");
      return { dateKey, campaignId, campaignName: null, impressions: 0, clicks: 0, spend: 0, conversions: 0 };
    }),
  ];

  let written = 0;
  for (const r of all) {
    if (!r.dateKey) continue;
    const k = keyOf(r.campaignId, r.dateKey);
    /*
     * Each family is written only when its query succeeded, and then for
     * every row — zeros for a day Google had nothing on — so a row without it
     * is one synced before (or without) it, and says so on the Board.
     */
    const families = Object.fromEntries(
      (Object.entries(extras) as Array<[GoogleExtraFamily, Map<string, Record<string, number>> | null]>).flatMap(
        ([family, byDay]) => (byDay ? [[family, byDay.get(k) ?? zeros(family)]] : []),
      ),
    );
    const values = {
      clientId: client.id,
      customerId: account.customerId,
      date: r.dateKey,
      googleCampaignId: r.campaignId,
      campaignName: r.campaignName,
      impressions: r.impressions,
      clicks: r.clicks,
      spend: String(r.spend),
      conversions: String(r.conversions),
      currency: account.currency,
      raw: { ...r, ...families } as unknown as object,
      syncedAt: new Date(),
    };
    await db
      .insert(googleDailyMetrics)
      .values(values)
      .onConflictDoUpdate({
        target: [
          googleDailyMetrics.clientId,
          googleDailyMetrics.customerId,
          googleDailyMetrics.date,
          googleDailyMetrics.googleCampaignId,
        ],
        // Merged, not replaced, so extra figures stored in `raw` by a separate,
        // best-effort query survive a run where that query failed.
        set: {
          ...values,
          // A day with extra figures only has no name to give; keep the stored one.
          campaignName: sql`COALESCE(excluded.campaign_name, ${googleDailyMetrics.campaignName})`,
          raw: sql`COALESCE(${googleDailyMetrics.raw}, '{}'::jsonb) || excluded.raw`,
        },
      });
    written++;
  }
  return written;
}

/** A family's figures for a day it had none: every key, at zero. */
function zeros(family: GoogleExtraFamily): Record<string, number> {
  return Object.fromEntries(Object.keys(GOOGLE_EXTRA_FAMILIES[family]).map((k) => [k, 0]));
}

/** Backfill historical daily metrics, chunked by month (mirror of Meta's). */
export async function backfillClientGoogleMetrics(
  client: Client,
  days = 90,
): Promise<number> {
  const [run] = await db
    .insert(syncRuns)
    .values({ clientId: client.id, kind: "google_backfill", status: "running" })
    .returning({ id: syncRuns.id });

  try {
    const tz = client.timezone;
    const window = trailingWindowInclusive(days, tz);
    let total = 0;
    let cursor = window.startKey;
    let guard = 0;
    while (cursor <= window.endKey && guard++ < 60) {
      const [y, m] = cursor.split("-").map(Number);
      const lastOfMonth = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
      const chunkEnd = lastOfMonth < window.endKey ? lastOfMonth : window.endKey;

      const { rowsWritten } = await syncClientGoogleMetrics(client, {
        since: cursor,
        until: chunkEnd,
      });
      total += rowsWritten;

      const next = new Date(Date.UTC(y, m, 1));
      cursor = next.toISOString().slice(0, 10);
      await new Promise((r) => setTimeout(r, 300));
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
 * Stale-while-revalidate for Google, called on dashboard load alongside Meta's.
 * Uses a DISTINCT advisory lock key so it never blocks the Meta refresh, and
 * reads freshness from the Google accounts (not `clients.lastSyncedAt`).
 */
export async function refreshGoogleIfStale(client: Client): Promise<boolean> {
  const accounts = await activeGoogleAccounts(client.id);
  if (accounts.length === 0) return false;

  const [{ last }] = await db
    .select({ last: max(googleAdAccounts.lastSyncedAt) })
    .from(googleAdAccounts)
    .where(eq(googleAdAccounts.clientId, client.id));
  if (last && Date.now() - last.getTime() < GOOGLE_STALE_AFTER_MS) return false;

  // Transaction-scoped advisory lock — see the Meta refreshIfStale note. A
  // session lock's unlock could run on a different pooled connection and leak.
  const lockKey = hashToInt(`google:${client.id}`);
  try {
    return await db.transaction(async (tx) => {
      const { rows } = (await tx.execute<{ locked: boolean }>(
        sql`SELECT pg_try_advisory_xact_lock(${lockKey}) AS locked`,
      )) as unknown as { rows: Array<{ locked: boolean }> };
      if (!rows[0]?.locked) return false;
      const today = todayKey(client.timezone);
      await syncClientGoogleMetrics(client, {
        since: today,
        until: today,
        intraday: true,
      });
      return true;
    });
  } catch (err) {
    console.error(`[google] refresh failed for ${client.slug}:`, err);
    return false;
  }
}

function hashToInt(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return h;
}
