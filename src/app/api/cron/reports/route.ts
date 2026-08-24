import { NextRequest, NextResponse } from "next/server";
import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { clients } from "@/db/schema";
import { safeEqual } from "@/lib/crypto";
import { emailConfigured } from "@/lib/reports/email";
import { dueSchedules, sendScheduledReport } from "@/lib/reports/send";

/**
 * Scheduled report delivery.
 *
 * ── Safe to call at any cadence ───────────────────────────────────────
 *
 * Same property the Meta reconcile has, and for the same reason: each schedule
 * decides for itself whether its period is complete, whether the client's local
 * send hour has passed, and whether that period has already gone out. Fire this
 * hourly, or twice, or retry a failed run — the second call finds nothing to do.
 * The guarantee is enforced in the database, not here: `report_sends` carries a
 * partial unique index on (client, platform, period) and the row is claimed
 * before the email is sent.
 *
 * ── 🔴 Which is why it can live on GitHub Actions ─────────────────────
 *
 * Vercel Hobby permits one cron per day and both slots are already spent on the
 * Meta and Google reconciles. An hourly schedule is what makes per-timezone send
 * hours work at all, so this runs from GitHub Actions with `CRON_SECRET` as a
 * repo secret — the same arrangement already in place for the reconciles.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Leave headroom to answer. Unsent schedules stay due and go next run. */
const BUDGET_MS = 240_000;

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.replace(/^Bearer\s+/i, "");
  const secret = process.env.CRON_SECRET;
  if (!secret || !safeEqual(bearer, secret)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  if (!emailConfigured()) {
    /*
     * 200, not an error. An unconfigured deployment is a supported state, and a
     * cron that reports failure every hour for a feature nobody switched on
     * trains people to ignore the one time it means something.
     */
    return NextResponse.json({
      ok: true,
      skipped: "email not configured",
      hint: "Set RESEND_API_KEY and REPORT_FROM to enable scheduled reports.",
    });
  }

  const startedAt = Date.now();
  const now = new Date();

  const schedules = await dueSchedules();
  if (schedules.length === 0) {
    return NextResponse.json({ ok: true, schedules: 0, sent: 0 });
  }

  const clientRows = await db
    .select()
    .from(clients)
    .where(inArray(clients.id, [...new Set(schedules.map((s) => s.clientId))]));
  const byId = new Map(clientRows.map((c) => [c.id, c]));

  const results: Array<{
    client: string;
    platform: string;
    sent: boolean;
    reason?: string;
    period?: string;
  }> = [];
  let sent = 0;
  let deferred = 0;

  for (const schedule of schedules) {
    if (Date.now() - startedAt > BUDGET_MS) {
      // Never let a budget cut read as "nothing was due".
      deferred++;
      continue;
    }

    const client = byId.get(schedule.clientId);
    if (!client) continue;
    /*
     * Archived clients keep their schedule row rather than having it deleted —
     * un-archiving should restore what was configured — but they must not be
     * emailed. Checked here rather than in the query so the reason is visible
     * in the response.
     */
    if (client.status !== "active") {
      results.push({
        client: client.slug,
        platform: schedule.platform,
        sent: false,
        reason: `client is ${client.status}`,
      });
      continue;
    }

    try {
      const outcome = await sendScheduledReport(client, schedule, now);
      if (outcome.sent) {
        sent++;
        results.push({
          client: client.slug,
          platform: schedule.platform,
          sent: true,
          period: outcome.period.label,
        });
      } else {
        results.push({
          client: client.slug,
          platform: schedule.platform,
          sent: false,
          reason: outcome.reason,
        });
      }
    } catch (err) {
      // One client's failure must not stop the rest of the book.
      console.error(`[cron/reports] ${client.slug} failed:`, err);
      results.push({
        client: client.slug,
        platform: schedule.platform,
        sent: false,
        reason: "unhandled error",
      });
    }
  }

  return NextResponse.json({
    ok: true,
    schedules: schedules.length,
    sent,
    deferred,
    ms: Date.now() - startedAt,
    results,
  });
}
