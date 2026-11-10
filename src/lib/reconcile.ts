import { lastLocalHourBoundary } from "./dates";

/**
 * When is a client due for its nightly reconciliation?
 *
 * Meta buckets days in the ad account's timezone, so "the day just closed, true
 * it up" is a different instant for every client. Clients are NOT all in one
 * region, so a single global run cannot be right for all of them.
 *
 * The gate is deliberately "has this client been reconciled since its local
 * target hour" rather than the obvious "is it that hour for them right now".
 * The difference matters because the trigger is a free, best-effort scheduler:
 *
 *   - An exact-hour match forces an HOURLY trigger, and a run delayed past the
 *     hour boundary silently skips every client at that offset for the night.
 *     Silent skips are the failure class this whole dashboard exists to remove.
 *   - An overdue check works on ANY cadence, tolerates late or missed runs, and
 *     catches up automatically once the trigger resumes — a multi-day outage
 *     costs nothing beyond latency.
 *
 * It is also idempotent, which is what lets several triggers coexist (Vercel's
 * daily cron slots plus a 3-hourly GitHub schedule): whichever fires first does
 * the work, the others find nothing to do.
 */

/**
 * Local hour at which a client's day is considered closed and reconcilable.
 *
 * 3, not 2: local 2am does not exist on spring-forward day in the US, EU or
 * Australia, so an hour-2 target would skip those clients once a year.
 */
export const DEFAULT_RECONCILE_HOUR = 3;

/**
 * Has this client's local reconcile hour passed without a reconcile since?
 *
 * Takes the timestamp explicitly rather than a client object, because each
 * platform keeps its own marker (`lastMetaReconciledAt` /
 * `lastGoogleReconciledAt`) and the caller must choose. A null timestamp reads
 * as overdue, which is correct: a client that has never been reconciled should
 * be picked up by the very next run.
 */
/** Latest point a cron run should still be working: 20 s inside its 300 s `maxDuration`. */
export const RUN_FINISH_BY_MS = 280_000;

/** Assumed length of a client's run when it has no recent success to go by. */
export const DEFAULT_CLIENT_RUN_MS = 60_000;

/**
 * Can a client still be synced in this run, given how long it usually takes?
 *
 * A client started too late is killed at `maxDuration` with nothing to show:
 * its run is reaped as abandoned, and the whole cron call reads as failed. That
 * was King LASIK, about 95 s, started with 60–95 s left on 30 Oct–1 Nov 2026.
 * A quarter is added for a slow night. The caller always starts a run's first
 * client whatever this says: nothing else could use the time, and refusing it
 * would refuse it every night.
 */
export function fitsBeforeDeadline(
  elapsedMs: number,
  usualMs: number | undefined,
  finishByMs: number = RUN_FINISH_BY_MS,
): boolean {
  return elapsedMs + (usualMs ?? DEFAULT_CLIENT_RUN_MS) * 1.25 <= finishByMs;
}

export function isReconcileOverdue(
  timezone: string,
  lastReconciledAt: Date | null,
  targetHour: number = DEFAULT_RECONCILE_HOUR,
  now: Date = new Date(),
): boolean {
  if (!lastReconciledAt) return true;
  const boundary = lastLocalHourBoundary(targetHour, timezone, now);
  return lastReconciledAt.getTime() < boundary.getTime();
}

/** How one client fared in a reconcile run. */
export type ReconcileStatus = "synced" | "skipped" | "deferred" | "failed";

export interface DispatchResult<T> {
  item: T;
  status: ReconcileStatus;
  rows?: number;
  error?: string;
}

/**
 * Work through a run's overdue clients, up to `concurrency` at a time.
 *
 * One at a time, a Meta run got through about seven clients before its
 * dispatch budget ran out. GitHub's scheduler skipped most of the runs meant to
 * share the load, so fewer clients were reconciled each day than fell due, and
 * the backlog showed on dashboards as recent days with part of their spend
 * missing (Nov 2026). A client's reconcile is nearly all waiting on the ad
 * platform, and the platforms' rate limits are per ad account, so separate
 * clients overlap without competing for one quota.
 *
 * Every rule of the one-at-a-time loop still holds for each start: queue order
 * (longest waiting first), the dispatch budget, `fitsBeforeDeadline`, and the
 * run's first client always starting. `busy` is asked before a client is
 * started, so one that another run is already reconciling is left to that run
 * rather than pulled twice at once; a failed `busy` check counts as not busy.
 */
export async function dispatchReconciles<T extends { id: string }>(
  queue: readonly T[],
  opts: {
    concurrency: number;
    budgetMs: number;
    usualMs: ReadonlyMap<string, number>;
    startedAt: number;
    busy: (item: T) => Promise<boolean>;
    sync: (item: T) => Promise<number>;
    now?: () => number;
  },
): Promise<DispatchResult<T>[]> {
  const now = opts.now ?? Date.now;
  const results: DispatchResult<T>[] = [];
  let next = 0;
  let started = 0;

  async function worker() {
    while (next < queue.length) {
      const item = queue[next++];
      // Out of time entirely: no need to ask whether anyone else has it.
      if (now() - opts.startedAt > opts.budgetMs) {
        results.push({ item, status: "deferred" });
        continue;
      }
      if (await opts.busy(item).catch(() => false)) {
        results.push({ item, status: "skipped" });
        continue;
      }
      // Checked and counted with no await in between, so two workers cannot
      // both take the first-client exemption.
      const elapsed = now() - opts.startedAt;
      if (
        elapsed > opts.budgetMs ||
        (started > 0 && !fitsBeforeDeadline(elapsed, opts.usualMs.get(item.id)))
      ) {
        results.push({ item, status: "deferred" });
        continue;
      }
      started++;
      try {
        results.push({ item, status: "synced", rows: await opts.sync(item) });
      } catch (err) {
        // One client's bad token must not abort the whole run.
        results.push({
          item,
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, worker));
  return results;
}
