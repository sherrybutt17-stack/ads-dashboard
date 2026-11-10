import { NextRequest, NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { clients, type Client } from "@/db/schema";
import {
  syncClientMetrics,
  reapAbandonedSyncRuns,
  metaReconcileInProgress,
  usualMetaRunMs,
  RECONCILE_DAYS,
} from "@/lib/meta/sync";
import { activeAdAccounts } from "@/lib/meta/accounts";
import { trailingWindowInclusive } from "@/lib/dates";
import {
  isReconcileOverdue,
  dispatchReconciles,
  DEFAULT_RECONCILE_HOUR,
  type ReconcileStatus,
} from "@/lib/reconcile";
import { safeEqual } from "@/lib/crypto";

/**
 * Nightly reconciliation.
 *
 * Re-pulls a trailing window and upserts, which is what keeps the dashboard in
 * agreement with Ads Manager as Meta restates spend and conversions over the
 * following weeks.
 *
 * Safe to call at ANY cadence. Each client is picked up only once its local
 * reconcile hour has passed without a reconcile since (see `@/lib/reconcile`),
 * so this is idempotent and several triggers can coexist: Vercel's daily cron
 * slots (vercel.json, one per hour that clients' local reconcile hour falls in)
 * plus the GitHub schedule. Whichever fires first does the work; the others
 * find nothing to do, and a client one run is reconciling is left to it.
 *
 * Query params:
 *   ?force=1  — ignore the overdue gate and reconcile every active client.
 *   ?hour=N   — override the local reconcile hour (default 3).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Stop dispatching new clients past this point, leaving headroom to return a
 * response. Clients not reached stay overdue and are picked up by the next run —
 * an explicit, self-correcting deferral rather than a silent mid-loop
 * truncation at `maxDuration`.
 */
const DISPATCH_BUDGET_MS = 240_000;

/**
 * Clients reconciled at once. Three, not more: separate ad accounts do not share
 * a rate limit, but Meta also meters the app as a whole, and the client already
 * eases off as that climbs — three roughly triples a run without leaning on it.
 */
const CONCURRENCY = 3;

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.replace(/^Bearer\s+/i, "");
  const secret = process.env.CRON_SECRET;

  // Vercel Cron sends the CRON_SECRET as a bearer token.
  if (!secret || !safeEqual(bearer, secret)) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    );
  }

  const startedAt = Date.now();
  const force = req.nextUrl.searchParams.get("force") === "1";
  // `?? NaN` matters: Number(null) is 0, and 0 is a valid hour, so an ABSENT
  // param would silently override the default with midnight.
  const hourRaw = req.nextUrl.searchParams.get("hour");
  const hourParam = Number(hourRaw ?? NaN);
  const targetHour =
    Number.isInteger(hourParam) && hourParam >= 0 && hourParam <= 23
      ? hourParam
      : DEFAULT_RECONCILE_HOUR;

  // Clear rows left behind by a previously killed run, so "running" always means
  // running and the health checklist stays honest.
  const reaped = await reapAbandonedSyncRuns();

  // Longest-waiting first, so a client deferred or killed last run leads this one.
  const active = await db
    .select()
    .from(clients)
    .where(eq(clients.status, "active"))
    .orderBy(sql`${clients.lastMetaReconciledAt} ASC NULLS FIRST`);
  const usualMs = await usualMetaRunMs();

  const results: Array<{
    slug: string;
    status: ReconcileStatus;
    rows?: number;
    error?: string;
  }> = [];

  const due: Client[] = [];
  for (const client of active) {
    const accounts = await activeAdAccounts(client.id);
    if (
      accounts.length === 0 ||
      (!force &&
        !isReconcileOverdue(
          client.timezone,
          client.lastMetaReconciledAt,
          targetHour,
        ))
    ) {
      results.push({ slug: client.slug, status: "skipped" });
      continue;
    }
    due.push(client);
  }

  // Out of time for a client → "deferred": said rather than appearing to have
  // covered everyone, and it leads the next run's queue.
  const dispatched = await dispatchReconciles(due, {
    concurrency: CONCURRENCY,
    budgetMs: DISPATCH_BUDGET_MS,
    usualMs,
    startedAt,
    busy: (client) => metaReconcileInProgress(client.id),
    sync: async (client) => {
      const window = trailingWindowInclusive(RECONCILE_DAYS, client.timezone);
      const { rowsWritten } = await syncClientMetrics(client, {
        since: window.startKey,
        until: window.endKey,
        includeReach: true,
        isReconcile: true,
        // Creative reporting and audience breakdowns ride the nightly
        // reconciliation, not the intraday refresh: together they are a second
        // insights pass, an ads listing and five segmented queries, and the
        // on-load path has to stay cheap enough to fire on every page view.
        includeAdLevel: true,
        includeBreakdowns: true,
      });
      return rowsWritten;
    },
  });
  for (const r of dispatched) {
    results.push({ slug: r.item.slug, status: r.status, rows: r.rows, error: r.error });
  }

  const deferred = results.filter((r) => r.status === "deferred").length;
  return NextResponse.json({
    ok: true,
    targetHour,
    reaped,
    deferred,
    elapsedMs: Date.now() - startedAt,
    results,
  });
}
