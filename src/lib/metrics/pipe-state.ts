import type { AdPlatform } from "./queries";

/**
 * Why an empty panel is empty — the pure half, deliberately free of any database
 * import so the state machine can be unit-tested without a connection string.
 * `pipe-status.ts` does the fetching and calls in here.
 *
 * The spreadsheet this product replaces failed by rendering every kind of
 * nothing identically: `SHOWN` sat at 0 for its entire history and nobody could
 * tell that from a genuine zero. So a blank region here has to name its own
 * cause, and the causes are not interchangeable:
 *
 * - `not_connected` — nothing was ever wired up. Not a fault.
 * - `backfilling`   — wired up, and the first pull is HAPPENING RIGHT NOW.
 * - `never_synced`  — wired up, no data pulled, nothing running. Wait, or start it.
 * - `unreachable`   — the platform rejected us. The figures are MISSING, and
 *                     reading them as zero is the specific error to prevent.
 * - `stale`         — we reached it, but not recently. Partial data.
 * - `live`          — the pipe works. Any emptiness is real.
 *
 * Only `live` licenses "no spend in this period — ads are paused".
 *
 * ── Why `backfilling` is its own state ────────────────────────────────
 *
 * It splits what used to be one `never_synced` into the two situations a person
 * actually faces after connecting an account, which want opposite responses:
 * *something is happening, wait* versus *nothing is scheduled, start it*.
 *
 * That moment is the one this product handled worst. Connecting an ad account
 * succeeded into silence — the nightly reconciliation might be hours away, so
 * the dashboard rendered an empty state and the operator could not tell whether
 * they had done something wrong. Every other kind of nothing on this screen
 * names its own cause; this one did not, and it is the first thing a new user
 * sees.
 */
export type AdPipeState =
  | "not_connected"
  | "backfilling"
  | "never_synced"
  | "unreachable"
  | "stale"
  | "live";

export interface AdPipeStatus {
  platform: AdPlatform;
  state: AdPipeState;
  /** Active ad accounts attached for this platform. */
  accounts: number;
  /** Last successful FULL reconciliation, ISO. */
  lastSuccessAt: string | null;
  /** Error text from the most recent failed reconciliation, staff-only copy. */
  lastError: string | null;
  /** Hours since the last successful reconciliation, null if there never was one. */
  hoursSinceSuccess: number | null;
  /**
   * Minutes the in-flight first pull has been running, when state is
   * `backfilling`. Null otherwise.
   *
   * Carried so the copy can stop promising "a couple of minutes" once that has
   * plainly stopped being true. A progress message that keeps insisting on a
   * duration it has already blown past reads as a frozen screen.
   */
  runningForMinutes: number | null;
}

/**
 * How long a `running` row is believed before it is treated as dead.
 *
 * Matches `reapAbandonedSyncRuns`'s default, and duplicating the number is
 * deliberate rather than sloppy: the reaper only fires at the top of a cron
 * run, so on a nightly schedule a killed process can sit `running` for hours
 * before anything rewrites it. If this state machine trusted the row it would
 * show "fetching your data" all night over a job that died at 02:04. The bound
 * has to live on the read side, where it is evaluated every render.
 */
export const SYNC_ASSUMED_DEAD_MINUTES = 30;

/**
 * How long a client may go without a successful reconciliation before its data
 * is treated as partial.
 *
 * The crons run nightly, so 24h is the expected cadence and 36h allows one
 * missed run plus timezone drift before crying wolf. Shared with the health
 * checklist so the dashboard and the checklist can never disagree about whether
 * a client is behind.
 */
export const RECONCILE_SLA_HOURS = 36;

/** One `sync_runs` row, reduced to what the state machine reads. */
export interface SyncRunSummary {
  status: "running" | "success" | "failed";
  startedAt: Date;
  error: string | null;
}

/**
 * The ad-pipe state machine. Pure. `runs` must be ordered newest first, and must
 * contain only FULL-sync rows — never the intraday refresh, which fires on any
 * page view and would let a page load stand in for a reconciliation.
 */
export function deriveAdPipeState(
  platform: AdPlatform,
  accountCount: number,
  runs: SyncRunSummary[],
  now: number = Date.now(),
): AdPipeStatus {
  const lastSuccess = runs.find((r) => r.status === "success") ?? null;
  const hoursSinceSuccess = lastSuccess
    ? (now - lastSuccess.startedAt.getTime()) / 3_600_000
    : null;

  const base = {
    platform,
    accounts: accountCount,
    lastSuccessAt: lastSuccess?.startedAt.toISOString() ?? null,
    hoursSinceSuccess,
    runningForMinutes: null as number | null,
  };

  // No account beats every other signal: without one there is nothing to be
  // broken, and reporting an old failure from a since-removed account as
  // "unreachable" would send someone looking for a fault that no longer exists.
  if (accountCount === 0) {
    return { ...base, state: "not_connected", lastError: null };
  }

  const newest = runs[0];

  // A run still `running` is not a failure — the reaper resolves genuinely dead
  // ones after 30 minutes, and until then the honest reading is the last
  // TERMINAL state, not "broken". Without this, every dashboard opened while the
  // nightly cron happened to be mid-run would flash red.
  const lastTerminal = runs.find((r) => r.status !== "running") ?? null;
  const successIsCurrent =
    hoursSinceSuccess !== null && hoursSinceSuccess <= RECONCILE_SLA_HOURS;

  /*
   * A failure only makes the data untrustworthy if nothing has succeeded since
   * the data would otherwise have gone stale.
   *
   * This qualifier is not defensive coding — it is what the production log
   * actually looks like. `gg-ads` shows successes and reaped-abandoned failures
   * interleaved hour by hour, because a killed run and an unreachable platform
   * both land as `status = 'failed'`. Reporting "Meta data is missing, not zero"
   * in critical red over a chart whose figures synced successfully ninety
   * minutes earlier would be a false alarm on the loudest surface in the app,
   * and false alarms are how a real one gets ignored.
   *
   * The operational fact — runs are failing — is not lost: it stays red on the
   * health checklist, where the audience can act on it. This state answers only
   * "can I trust the numbers on screen", and a current success answers yes.
   */
  if (lastTerminal?.status === "failed" && !successIsCurrent) {
    return {
      ...base,
      state: "unreachable",
      lastError: lastTerminal.error ?? null,
    };
  }

  /*
   * The first pull, in flight.
   *
   * 🔴 Placed BELOW the `unreachable` check, and that order is the whole
   * judgement. A run that is running right now, after a previous attempt died
   * on a rate limit, is a RETRY — and "Fetching your history, usually two or
   * three minutes" over a pipe whose last completed attempt failed is a hopeful
   * spinner hiding a real failure. By the time control reaches here, a terminal
   * failure has already returned `unreachable`, so `lastTerminal` can only be
   * null: no run has ever finished, which is precisely a fresh connect. The
   * assertion is kept explicit rather than left to the ordering, because the
   * ordering is easy to disturb and the failure would be silent.
   *
   * 🔴 `runs[0]`, not `runs.some(...)`. Runs arrive newest first and the
   * question is whether something is happening NOW; a row stuck further down
   * the list is the thing the reaper exists to clean up, not progress.
   *
   * Bounded by `SYNC_ASSUMED_DEAD_MINUTES` for the reason given on that
   * constant. Past the bound this falls through to `never_synced` — "connected,
   * nothing pulled yet, start it" — which is what the reaper will eventually
   * make official anyway.
   */
  if (!lastTerminal && newest?.status === "running") {
    const runningForMinutes = (now - newest.startedAt.getTime()) / 60_000;
    if (runningForMinutes < SYNC_ASSUMED_DEAD_MINUTES) {
      return { ...base, state: "backfilling", lastError: null, runningForMinutes };
    }
  }

  if (!lastSuccess) return { ...base, state: "never_synced", lastError: null };

  if (!successIsCurrent) {
    return { ...base, state: "stale", lastError: null };
  }

  return { ...base, state: "live", lastError: null };
}

/**
 * The CRM side of the same question.
 *
 * `silent` deserves care: a quiet fortnight is normal for a small clinic, so the
 * threshold is deliberately generous and the state is only ever surfaced NEXT TO
 * an empty panel, where it answers "is this zero real?" rather than raising an
 * alarm on its own.
 */
export type CrmPipeState = "never_connected" | "silent" | "live";

export interface CrmPipeStatus {
  state: CrmPipeState;
  firstWebhookAt: string | null;
  lastWebhookAt: string | null;
  daysSinceEvent: number | null;
}

export const CRM_SILENT_AFTER_DAYS = 14;

export function deriveCrmPipeState(
  first: Date | null,
  last: Date | null,
  now: number = Date.now(),
): CrmPipeStatus {
  const daysSinceEvent = last ? (now - last.getTime()) / 86_400_000 : null;

  const state: CrmPipeState = !first
    ? "never_connected"
    : (daysSinceEvent ?? Infinity) > CRM_SILENT_AFTER_DAYS
      ? "silent"
      : "live";

  return {
    state,
    firstWebhookAt: first?.toISOString() ?? null,
    lastWebhookAt: last?.toISOString() ?? null,
    daysSinceEvent,
  };
}
