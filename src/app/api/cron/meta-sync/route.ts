import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { clients } from "@/db/schema";
import {
  syncClientMetrics,
  isDueForNightlySync,
  RECONCILE_DAYS,
} from "@/lib/meta/sync";
import { activeAdAccounts } from "@/lib/meta/accounts";
import { trailingWindowInclusive } from "@/lib/dates";
import { safeEqual } from "@/lib/crypto";

/**
 * Nightly reconciliation.
 *
 * Re-pulls a trailing window and upserts, which is what keeps the dashboard in
 * agreement with Ads Manager as Meta restates spend and conversions over the
 * following weeks.
 *
 * Intended to run HOURLY. Each invocation only processes clients whose local
 * time has just reached the target hour, because Meta buckets days in the ad
 * account's timezone — a single global run cannot be correct for clients in
 * different regions.
 *
 * ⚠️ Vercel's Hobby tier permits one cron run per day. On Hobby, either pin the
 * schedule to an hour that is ~02:00 for all clients, or pass `?force=1` from
 * an external scheduler.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.replace(/^Bearer\s+/i, "");
  const secret = process.env.CRON_SECRET;

  // Vercel Cron sends the CRON_SECRET as a bearer token.
  if (!secret || !safeEqual(bearer, secret)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const force = req.nextUrl.searchParams.get("force") === "1";
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
    const accounts = await activeAdAccounts(client.id);
    if (accounts.length === 0) {
      results.push({ slug: client.slug, status: "skipped" });
      continue;
    }
    if (!force && !isDueForNightlySync(client, targetHour)) {
      results.push({ slug: client.slug, status: "skipped" });
      continue;
    }

    try {
      const window = trailingWindowInclusive(RECONCILE_DAYS, client.timezone);
      const { rowsWritten } = await syncClientMetrics(client, {
        since: window.startKey,
        until: window.endKey,
        includeReach: true,
      });
      results.push({ slug: client.slug, status: "synced", rows: rowsWritten });
    } catch (err) {
      // One client's bad token must not abort the whole run.
      results.push({
        slug: client.slug,
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return NextResponse.json({ ok: true, results });
}
