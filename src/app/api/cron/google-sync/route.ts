import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { clients } from "@/db/schema";
import { reapAbandonedSyncRuns } from "@/lib/meta/sync";
import {
  syncClientGoogleMetrics,
  GOOGLE_RECONCILE_DAYS,
} from "@/lib/google/sync";
import { activeGoogleAccounts } from "@/lib/google/accounts";
import { isGoogleConfigured } from "@/lib/google/oauth";
import { trailingWindowInclusive } from "@/lib/dates";
import { isReconcileOverdue, DEFAULT_RECONCILE_HOUR } from "@/lib/reconcile";
import { safeEqual } from "@/lib/crypto";

/**
 * Nightly Google Ads reconciliation — the direct mirror of the Meta cron.
 *
 * Safe at any cadence: each client is picked up only once its local reconcile
 * hour has passed without a Google reconcile since. Tracks its own marker
 * (`lastGoogleReconciledAt`), separate from Meta's, so the two crons cannot mark
 * each other's work done.
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

  if (!isGoogleConfigured()) {
    return NextResponse.json({ ok: true, skipped: "google not configured" });
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

  for (const client of active) {
    if (Date.now() - startedAt > DISPATCH_BUDGET_MS) {
      results.push({ slug: client.slug, status: "deferred" });
      continue;
    }

    const accounts = await activeGoogleAccounts(client.id);
    if (accounts.length === 0) {
      results.push({ slug: client.slug, status: "skipped" });
      continue;
    }
    if (
      !force &&
      !isReconcileOverdue(
        client.timezone,
        client.lastGoogleReconciledAt,
        targetHour,
      )
    ) {
      results.push({ slug: client.slug, status: "skipped" });
      continue;
    }

    try {
      const window = trailingWindowInclusive(GOOGLE_RECONCILE_DAYS, client.timezone);
      const { rowsWritten } = await syncClientGoogleMetrics(client, {
        since: window.startKey,
        until: window.endKey,
        isReconcile: true,
      });
      results.push({ slug: client.slug, status: "synced", rows: rowsWritten });
    } catch (err) {
      results.push({
        slug: client.slug,
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
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
