import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { clients, type Client } from "@/db/schema";
import { reapAbandonedSyncRuns } from "@/lib/meta/sync";
import {
  syncClientTiktokMetrics,
  TIKTOK_RECONCILE_DAYS,
} from "@/lib/tiktok/sync";
import { activeTiktokAccounts } from "@/lib/tiktok/accounts";
import { lastTiktokAdLevelSuccess, syncClientTiktokAdLevel } from "@/lib/tiktok/adlevel";
import { trailingWindowInclusive } from "@/lib/dates";
import { isReconcileOverdue, DEFAULT_RECONCILE_HOUR } from "@/lib/reconcile";
import { safeEqual } from "@/lib/crypto";

/**
 * Nightly TikTok reconciliation — the direct mirror of the Meta and Google crons.
 *
 * 🔴 Why it exists: until this route, TikTok's only caller was the on-load
 * stale-while-revalidate refresh, which re-pulls TODAY and nothing else. Every
 * earlier day was therefore frozen at whatever TikTok had reported the last time
 * somebody happened to open that dashboard — and a day nobody opened was never
 * corrected at all. Since TikTok credits click-through conversions for up to 28
 * days, those figures are still moving long after the page view that captured
 * them, so the dashboard drifted away from TikTok Ads Manager silently and in
 * one direction. Silent divergence from the platform's own UI is the failure
 * this application was built to replace.
 *
 * Safe at any cadence: each client is picked up only once its local reconcile
 * hour has passed without a TikTok reconcile since. Tracks its own marker
 * (`lastTiktokReconciledAt`), separate from Meta's and Google's, so the three
 * crons cannot mark each other's work done.
 *
 * Scheduling note: this is NOT in `vercel.json` — the Hobby tier permits two
 * cron jobs and Meta and Google hold both. It runs from the free 3-hourly
 * GitHub Actions schedule in `.github/workflows/reconcile.yml`, which the
 * overdue gate makes safe: a late or missed run costs latency, never a skip.
 *
 * Query params: `?force=1` ignores the gate, `?hour=N` overrides the local hour.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** See the Meta cron — headroom to respond rather than be killed mid-loop. */
const DISPATCH_BUDGET_MS = 240_000;

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.replace(/^Bearer\s+/i, "");
  const secret = process.env.CRON_SECRET;
  if (!secret || !safeEqual(bearer, secret)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  const force = req.nextUrl.searchParams.get("force") === "1";
  // See the Meta cron: Number(null) is 0, so an absent param must not be parsed.
  const hourRaw = req.nextUrl.searchParams.get("hour");
  const hourParam = Number(hourRaw ?? NaN);
  const targetHour =
    Number.isInteger(hourParam) && hourParam >= 0 && hourParam <= 23
      ? hourParam
      : DEFAULT_RECONCILE_HOUR;

  const reaped = await reapAbandonedSyncRuns();

  const active = await db
    .select()
    .from(clients)
    .where(eq(clients.status, "active"));

  const results: Array<{
    slug: string;
    status: "synced" | "skipped" | "deferred" | "failed";
    rows?: number;
    error?: string;
  }> = [];

  /** The ad-level pass per client — kept apart from `results`, which is the spend reconcile alone. */
  const adLevel: Array<Awaited<ReturnType<typeof adLevelIfDue>>> = [];

  for (const client of active) {
    if (Date.now() - startedAt > DISPATCH_BUDGET_MS) {
      results.push({ slug: client.slug, status: "deferred" });
      continue;
    }

    /*
     * No configuration gate ahead of this, unlike the Google cron. TikTok
     * credentials are per-advertiser and stored encrypted on the account row
     * rather than read from a global env var, so "is TikTok configured" is
     * exactly "does any client have an active advertiser" — which this already
     * asks, one client at a time.
     */
    const accounts = await activeTiktokAccounts(client.id);
    if (accounts.length === 0) {
      results.push({ slug: client.slug, status: "skipped" });
      continue;
    }
    if (
      !force &&
      !isReconcileOverdue(
        client.timezone,
        client.lastTiktokReconciledAt,
        targetHour,
      )
    ) {
      results.push({ slug: client.slug, status: "skipped" });
    } else {
      try {
        const window = trailingWindowInclusive(TIKTOK_RECONCILE_DAYS, client.timezone);
        const { rowsWritten } = await syncClientTiktokMetrics(client, {
          since: window.startKey,
          until: window.endKey,
          isReconcile: true,
        });
        results.push({ slug: client.slug, status: "synced", rows: rowsWritten });
      } catch (err) {
        // One client's revoked advertiser token must not abort the whole run.
        results.push({
          slug: client.slug,
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    adLevel.push(await adLevelIfDue(client, startedAt, force));
  }

  const deferred = results.filter((r) => r.status === "deferred").length;
  return NextResponse.json({
    ok: true,
    targetHour,
    reaped,
    deferred,
    elapsedMs: Date.now() - startedAt,
    results,
    adLevel,
  });
}

/** How long the ad-level pass waits between successes — once a day, retried every run until it lands. */
const AD_LEVEL_EVERY_MS = 20 * 60 * 60 * 1000;
/** After this the pass stops fetching pictures, leaving time to answer before `maxDuration`. */
const AD_LEVEL_STOP_MS = 270_000;

/**
 * The client's TikTok ad-level pass, when it is due.
 *
 * 🔴 Its own gate, not the campaign reconcile's. Tied to that marker, a client
 * whose campaign reconcile kept failing on one dead advertiser token would
 * never get ad-level detail for its healthy ones; and a pass that failed or was
 * deferred would wait a whole day. Due means "no successful ad-level run in 20
 * hours", so a failed one is tried again on the next run, three hours later.
 *
 * Never fatal to anything: its failures are recorded on its own `tiktok_adlevel`
 * run, and the campaign result above is already in.
 */
async function adLevelIfDue(
  client: Client,
  startedAt: number,
  force: boolean,
): Promise<{ slug: string; status: "synced" | "skipped" | "deferred" | "failed"; rows?: number }> {
  try {
    const last = await lastTiktokAdLevelSuccess(client.id);
    if (!force && last && Date.now() - last.getTime() < AD_LEVEL_EVERY_MS) {
      return { slug: client.slug, status: "skipped" };
    }
    if (Date.now() - startedAt > DISPATCH_BUDGET_MS) return { slug: client.slug, status: "deferred" };
    const { rowsWritten } = await syncClientTiktokAdLevel(client, {
      days: TIKTOK_RECONCILE_DAYS,
      deadline: startedAt + AD_LEVEL_STOP_MS,
    });
    return { slug: client.slug, status: "synced", rows: rowsWritten };
  } catch (err) {
    console.error(`[tiktok] ad-level pass failed for ${client.slug}:`, err instanceof Error ? err.message : err);
    return { slug: client.slug, status: "failed" };
  }
}
