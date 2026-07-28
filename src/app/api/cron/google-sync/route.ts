import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { clients } from "@/db/schema";
import { isDueForNightlySync } from "@/lib/meta/sync";
import {
  syncClientGoogleMetrics,
  GOOGLE_RECONCILE_DAYS,
} from "@/lib/google/sync";
import { activeGoogleAccounts } from "@/lib/google/accounts";
import { isGoogleConfigured } from "@/lib/google/oauth";
import { trailingWindowInclusive } from "@/lib/dates";
import { safeEqual } from "@/lib/crypto";

/**
 * Nightly Google Ads reconciliation — the direct mirror of the Meta cron.
 *
 * Runs hourly; each invocation processes only clients whose local time has just
 * reached the target hour (days are bucketed in the ad account's timezone).
 * Reuses `isDueForNightlySync` from the Meta module so both platforms share the
 * same per-timezone scheduling.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

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

  const force = req.nextUrl.searchParams.get("force") === "1";
  // See the Meta cron: the 2am per-timezone gate is only for an hourly (Pro)
  // schedule. On the Hobby daily run it just skips clients whose local hour
  // isn't the target. Default: reconcile every active client each daily run;
  // ?hourly=1 restores the per-timezone gate for a Pro hourly cron.
  const hourly = req.nextUrl.searchParams.get("hourly") === "1";
  const targetHour = Number(req.nextUrl.searchParams.get("hour") ?? 2);

  const active = await db
    .select()
    .from(clients)
    .where(eq(clients.status, "active"));

  const results: Array<{
    slug: string;
    status: "synced" | "skipped" | "failed";
    rows?: number;
    error?: string;
  }> = [];

  for (const client of active) {
    const accounts = await activeGoogleAccounts(client.id);
    if (accounts.length === 0) {
      results.push({ slug: client.slug, status: "skipped" });
      continue;
    }
    if (!force && hourly && !isDueForNightlySync(client, targetHour)) {
      results.push({ slug: client.slug, status: "skipped" });
      continue;
    }

    try {
      const window = trailingWindowInclusive(GOOGLE_RECONCILE_DAYS, client.timezone);
      const { rowsWritten } = await syncClientGoogleMetrics(client, {
        since: window.startKey,
        until: window.endKey,
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

  return NextResponse.json({ ok: true, results });
}
