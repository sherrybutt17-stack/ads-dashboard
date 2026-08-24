import { sql } from "drizzle-orm";
import { db } from "@/db";
import type { Client } from "@/db/schema";
import { activeAdAccounts } from "@/lib/meta/accounts";
import { activeGoogleAccounts } from "@/lib/google/accounts";
import { activeTiktokAccounts } from "@/lib/tiktok/accounts";
import { deriveAdPipeState, deriveCrmPipeState } from "./pipe-state";
import type { AdPipeStatus, CrmPipeStatus, SyncRunSummary } from "./pipe-state";
import { AD_PLATFORMS, type AdPlatform } from "@/lib/platforms";

/**
 * The I/O half of pipe status. The state machine itself lives in `pipe-state.ts`
 * and is pure — see that file for what each state means and why they must not be
 * conflated.
 */
export * from "./pipe-state";

/**
 * Which `sync_runs.kind` values count as a full pull, per platform.
 *
 * 🔴 One map, exported, because this used to be a `=== "google"` ternary
 * written out twice — here and in `health.ts` — and TikTok fell through both
 * else-branches into Meta's. The dashboard's TikTok tab and the TikTok
 * freshness check therefore both reported **Meta's** sync runs, so a healthy
 * Facebook cron rendered as a healthy TikTok pipe over a table with no rows in
 * it. A green light on a dead pipe is the specific failure this product exists
 * to replace, so the answer lives in exactly one place now.
 *
 * ── Why backfills are included and intraday runs are not ──────────────
 *
 * The rule is "did we genuinely reach the platform and pull a window", and a
 * 90-day backfill satisfies it more completely than a nightly 7-day
 * reconciliation does. Leaving it out had two costs: a client whose only sync
 * was a successful backfill read as `never_synced` while holding 90 days of
 * data, and — the reason this changed — a backfill in flight was invisible, so
 * the post-connect `backfilling` state could never be reached at all.
 *
 * The intraday refresh stays excluded, and that exclusion is not symmetrical
 * with this one: it fires on any page view and can be killed with the
 * invocation that spawned it, so counting it would let opening a page stand in
 * for a reconciliation that never ran.
 *
 * `as const satisfies` is doing real work: the literals stay narrow enough for
 * Drizzle's enum column, while the compiler refuses a fourth platform that has
 * not been given its kinds.
 */
export const FULL_SYNC_KINDS = {
  meta: ["meta_daily", "meta_backfill"],
  google: ["google_daily", "google_backfill"],
  tiktok: ["tiktok_daily", "tiktok_backfill"],
} as const satisfies Record<AdPlatform, readonly string[]>;

/**
 * Resolve the ad-platform pipe for one client.
 *
 * Two indexed queries, issued in parallel and cheap enough to sit on the
 * critical path: an account count and the last few `sync_runs` rows.
 *
 * Reads only the kinds in `FULL_SYNC_KINDS` — nightly reconciliations and
 * backfills — never the intraday refresh. See that constant for why the line is
 * drawn there.
 */
export async function getAdPipeStatus(
  client: Client,
  platform: AdPlatform,
  /*
   * Injectable clock, matching `getBookPipeStates`. Not decoration: these two
   * answer the same question by different routes, and the only way to assert
   * they agree is to ask both at the same instant. Without it the comparison
   * silently drifts by however long the fixture takes to run.
   */
  now: number = Date.now(),
): Promise<AdPipeStatus> {
  /*
   * 🔴 An exhaustive record, not `platform === "google" ? … : …`.
   *
   * That ternary is what this function used to have, and TikTok fell through
   * its else-branch into Meta's — so the TikTok tab read **Meta's** ad accounts
   * and rendered them as TikTok's. A client whose TikTok had never synced
   * showed "Synced 4m ago", green, because Facebook had. A plausible wrong
   * answer over a dead pipe is strictly worse than an empty state: an empty tab
   * prompts a question and a green one does not.
   *
   * Same failure `lib/platforms.ts` was written to end, one layer down. See
   * `FULL_SYNC_KINDS` above for the other half of it.
   */
  const accountsFor: Record<AdPlatform, (id: string) => Promise<unknown[]>> = {
    meta: activeAdAccounts,
    google: activeGoogleAccounts,
    tiktok: activeTiktokAccounts,
  };

  const kinds = sql.join(
    FULL_SYNC_KINDS[platform].map((k) => sql`${k}`),
    sql`, `,
  );

  /*
   * 🔴 The three rows the state machine reads, each fetched on its own terms.
   *
   * This was `ORDER BY started_at DESC LIMIT 10`, on the reasoning that a short
   * window covers both "are we broken now" and "how far behind are we". It does
   * not. `deriveAdPipeState` looks for the most recent SUCCESS anywhere in the
   * list, so ten newer failures push it off the end and `lastSuccessAt` comes
   * back null for a pipe that succeeded last week.
   *
   * That is not a cosmetic timestamp. `kickFirstSync` guards on exactly this
   * field, so after ten failed nightly runs, re-attaching an account fired a
   * fresh 90-day backfill over data we already held — against a rate limit
   * shared with the cron, on a pipe that was failing anyway. The guard's own
   * comment forbids precisely that.
   *
   * Three `LIMIT 1` reads against the same index cost less than the ten-row
   * scan did, and none of them can be crowded out. Duplicates are possible (the
   * newest run is often also the newest terminal one) and harmless — the
   * machine uses `.find()`, and the outer sort keeps `runs[0]` honest.
   */
  const runsQuery = sql`
    SELECT status, started_at, error FROM (
        (SELECT status, started_at, error FROM sync_runs
          WHERE client_id = ${client.id}::uuid AND kind IN (${kinds})
          ORDER BY started_at DESC LIMIT 1)
      UNION ALL
        (SELECT status, started_at, error FROM sync_runs
          WHERE client_id = ${client.id}::uuid AND kind IN (${kinds})
            AND status <> 'running'
          ORDER BY started_at DESC LIMIT 1)
      UNION ALL
        (SELECT status, started_at, error FROM sync_runs
          WHERE client_id = ${client.id}::uuid AND kind IN (${kinds})
            AND status = 'success'
          ORDER BY started_at DESC LIMIT 1)
    ) t ORDER BY started_at DESC
  `;

  const [accounts, runRows] = await Promise.all([
    accountsFor[platform](client.id),
    db.execute<{ status: string; started_at: string; error: string | null }>(
      runsQuery,
    ),
  ]);

  const runs: SyncRunSummary[] = (runRows.rows ?? []).map((r) => ({
    status: r.status as SyncRunSummary["status"],
    startedAt: new Date(r.started_at),
    error: r.error,
  }));

  return deriveAdPipeState(platform, accounts.length, runs, now);
}

/** CRM liveness, straight off the client row — no query, so every lead-shaped
 *  panel can ask for it freely. */
export function getCrmPipeStatus(client: Client): CrmPipeStatus {
  return deriveCrmPipeState(
    client.firstWebhookAt ?? null,
    client.lastWebhookAt ?? null,
  );
}

/**
 * Pipe states for many clients at once, in two queries.
 *
 * 🔴 Why this exists rather than a loop over `getAdPipeStatus`: the book panel
 * scores every client's spend against their budget, and spend that was never
 * fetched reads as an underspend. So the book needs the same trust check the
 * client page makes — but per-client it is two queries each, which turns a
 * five-query panel into thirty for a book of twelve.
 *
 * Returns a map keyed `clientId:platform`. A client/platform pair with no entry
 * has no accounts, which `deriveAdPipeState` already reads as `not_connected`.
 */
export async function getBookPipeStates(
  clientIds: readonly string[],
  now: number = Date.now(),
): Promise<Map<string, AdPipeStatus>> {
  const out = new Map<string, AdPipeStatus>();
  if (clientIds.length === 0) return out;

  /*
   * The status literals differ per table and are matched as each module's own
   * `active*` reader does: Meta and Google keep an explicit `active`, TikTok
   * counts anything not `removed`. Copying those rules rather than assuming one
   * is what stops a paused TikTok advertiser from reading as disconnected.
   *
   * That claim was false when written — `activeTiktokAccounts` tested
   * `=== "active"` — and `tiktok/accounts.ts` has been corrected to match. It
   * is true now, and `tiktok/accounts.test.ts` asserts the three readers agree
   * rather than leaving it to this comment.
   */
  /*
   * Bound one value at a time with an explicit `::uuid` cast, matching
   * `bookWindows` — an array parameter reaches the driver untyped and the query
   * fails outright rather than returning something wrong. (It did: this whole
   * function was written with `= ANY($1)` and never ran until a test called it.)
   */
  const idList = sql.join(
    clientIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

  const [accountRows, runRows] = await Promise.all([
    db.execute<{ client_id: string; platform: string; n: number }>(sql`
      SELECT client_id, 'meta' AS platform, COUNT(*)::int AS n
        FROM meta_ad_accounts
       WHERE client_id IN (${idList}) AND status = 'active'
       GROUP BY client_id
      UNION ALL
      SELECT client_id, 'google' AS platform, COUNT(*)::int AS n
        FROM google_ad_accounts
       WHERE client_id IN (${idList}) AND status = 'active'
       GROUP BY client_id
      UNION ALL
      SELECT client_id, 'tiktok' AS platform, COUNT(*)::int AS n
        FROM tiktok_ad_accounts
       WHERE client_id IN (${idList}) AND status <> 'removed'
       GROUP BY client_id
    `),
    /*
     * 🔴 The same three rows `getAdPipeStatus` reads, per client and kind.
     *
     * This was `started_at > now() - interval '14 days'`, on the reasoning that
     * fourteen days is longer than any freshness threshold so anything older is
     * stale regardless. True of freshness, false of everything else: with no
     * rows at all `deriveAdPipeState` finds no success and answers
     * `never_synced` — "wired up, nothing pulled, start it" — about a client
     * sitting on ninety days of data whose own dashboard says `stale`.
     *
     * Measured, same client and moment:
     *
     *     client page ->  stale         lastSuccessAt: 2026-07-31
     *     book panel  ->  never_synced  lastSuccessAt: null
     *
     * `spendTrusted` in `book-pacing-load.ts` accepts `live` and `stale`, so the
     * pacing verdict was withheld for exactly the clients that needed one, with
     * the panel giving a reason that was not true. Reachable whenever the cron
     * stops for a fortnight — which it has, twice, by deliberate commit.
     *
     * `DISTINCT ON` gives the newest row per (client, kind) without a lateral
     * join; three arms give newest, newest terminal, and newest success. Rows
     * are few — three per client per kind — so the outer sort is trivial.
     */
    db.execute<{
      client_id: string;
      kind: string;
      status: string;
      started_at: string;
      error: string | null;
    }>(sql`
      SELECT client_id, kind, status, started_at, error FROM (
          (SELECT DISTINCT ON (client_id, kind)
                  client_id, kind, status, started_at, error
             FROM sync_runs WHERE client_id IN (${idList})
            ORDER BY client_id, kind, started_at DESC)
        UNION ALL
          (SELECT DISTINCT ON (client_id, kind)
                  client_id, kind, status, started_at, error
             FROM sync_runs WHERE client_id IN (${idList}) AND status <> 'running'
            ORDER BY client_id, kind, started_at DESC)
        UNION ALL
          (SELECT DISTINCT ON (client_id, kind)
                  client_id, kind, status, started_at, error
             FROM sync_runs WHERE client_id IN (${idList}) AND status = 'success'
            ORDER BY client_id, kind, started_at DESC)
      ) t ORDER BY started_at DESC
    `),
  ]);

  const counts = new Map<string, number>();
  for (const r of accountRows.rows ?? []) {
    counts.set(`${r.client_id}:${r.platform}`, Number(r.n) || 0);
  }

  const runsByKey = new Map<string, SyncRunSummary[]>();
  for (const r of runRows.rows ?? []) {
    for (const platform of AD_PLATFORMS) {
      if (!(FULL_SYNC_KINDS[platform] as readonly string[]).includes(r.kind)) continue;
      const key = `${r.client_id}:${platform}`;
      const list = runsByKey.get(key) ?? [];
      // Already ordered newest-first by the query; `deriveAdPipeState` relies on
      // that to find the most recent run and the most recent success.
      list.push({
        status: r.status as SyncRunSummary["status"],
        startedAt: new Date(r.started_at),
        error: r.error,
      });
      runsByKey.set(key, list);
    }
  }

  for (const clientId of clientIds) {
    for (const platform of AD_PLATFORMS) {
      const key = `${clientId}:${platform}`;
      out.set(
        key,
        deriveAdPipeState(
          platform,
          counts.get(key) ?? 0,
          runsByKey.get(key) ?? [],
          now,
        ),
      );
    }
  }

  return out;
}
