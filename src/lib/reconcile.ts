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
 * It is also idempotent, which is what lets several triggers coexist (a
 * 3-hourly external schedule plus Vercel's once-daily cron as a backstop):
 * whichever fires first does the work, the other finds nothing to do.
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
