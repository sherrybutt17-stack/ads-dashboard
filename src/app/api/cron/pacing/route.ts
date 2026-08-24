import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { clients } from "@/db/schema";
import { safeEqual } from "@/lib/crypto";
import { localHour } from "@/lib/dates";
import { alertPacing } from "@/lib/alerts/pacing-send";
import { activeAdAccounts } from "@/lib/meta/accounts";
import { activeGoogleAccounts } from "@/lib/google/accounts";
import { activeTiktokAccounts } from "@/lib/tiktok/accounts";
import type { AdPlatform } from "@/lib/platforms";

/**
 * Budget-pacing alerts.
 *
 * The dashboard panel is passive — it is right whenever somebody looks at it,
 * and an agency running a dozen accounts does not open twelve dashboards every
 * morning. An underspend is only fixable while the month still has days left,
 * so this pushes the finding while it can still be acted on.
 *
 * ── Why it is safe to call this often ─────────────────────────────────
 *
 * Every suppression rule lives in `decidePacingAlert`, which is pure and
 * cooldown-aware: the same verdict is not repeated inside `COOLDOWN_DAYS`, and
 * a reversal is never suppressed. So running this on the same 3-hourly schedule
 * as the reconciles produces at most one message per client per week per
 * direction, not eight a day.
 *
 * The one thing the decision function cannot know is what time it is where the
 * client is — hence the working-hours gate below.
 *
 * Query params:
 *   ?force=1  — ignore the working-hours gate (the cooldown still applies).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Local hours during which an alert may be sent. */
const OPEN_HOUR = 9;
const CLOSE_HOUR = 20;

/** See the reconcile crons — headroom to respond rather than be killed mid-loop. */
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
  const now = new Date();

  const active = await db
    .select()
    .from(clients)
    .where(eq(clients.status, "active"));

  const results: Array<{
    slug: string;
    platform?: AdPlatform;
    status: "sent" | "skipped" | "deferred" | "failed";
    kind?: string;
    reason?: string;
  }> = [];

  for (const client of active) {
    if (Date.now() - startedAt > DISPATCH_BUDGET_MS) {
      results.push({ slug: client.slug, status: "deferred" });
      continue;
    }

    /*
     * Cheapest gates first: a client with alerts switched off must cost no
     * queries at all, because this loop runs over the whole book every time.
     */
    if (!client.alertsEnabled || !client.alertWebhookEncrypted) {
      results.push({ slug: client.slug, status: "skipped", reason: "disabled" });
      continue;
    }

    if (!force) {
      const hour = localHour(client.timezone, now);
      if (hour < OPEN_HOUR || hour >= CLOSE_HOUR) {
        results.push({ slug: client.slug, status: "skipped", reason: "out_of_hours" });
        continue;
      }
    }

    const connected = await connectedPlatforms(client.id);
    if (connected.length === 0) {
      results.push({ slug: client.slug, status: "skipped", reason: "no_accounts" });
      continue;
    }

    /*
     * Alerts are per client, not per client per platform: one channel, one
     * cooldown, one `last_pacing_alert_status`. So platforms are tried in order
     * and the first with something to say wins — a client whose Meta and Google
     * budgets are both adrift gets one message now and the other next week,
     * rather than two at once about the same account.
     */
    let spoke = false;
    for (const platform of connected) {
      const outcome = await alertPacing(client, platform, now);
      if (outcome.sent) {
        results.push({ slug: client.slug, platform, status: "sent", kind: outcome.kind });
        spoke = true;
        break;
      }
      /*
       * A rejected destination is reported rather than swallowed: a webhook
       * revoked in Slack is exactly the silent failure this product exists to
       * surface, and it looks identical to "nothing to say" unless it is named.
       */
      if (outcome.reason === "failed" || outcome.reason === "bad_destination") {
        results.push({
          slug: client.slug,
          platform,
          status: "failed",
          reason: outcome.reason,
        });
        spoke = true;
        break;
      }
    }
    if (!spoke) {
      results.push({ slug: client.slug, status: "skipped", reason: "nothing_to_say" });
    }
  }

  const sent = results.filter((r) => r.status === "sent").length;
  const deferred = results.filter((r) => r.status === "deferred").length;
  return NextResponse.json({
    ok: true,
    sent,
    deferred,
    elapsedMs: Date.now() - startedAt,
    results,
  });
}

/** Which ad platforms this client actually has a live account on. */
async function connectedPlatforms(clientId: string): Promise<AdPlatform[]> {
  const [meta, google, tiktok] = await Promise.all([
    activeAdAccounts(clientId).catch(() => []),
    activeGoogleAccounts(clientId).catch(() => []),
    activeTiktokAccounts(clientId).catch(() => []),
  ]);
  const out: AdPlatform[] = [];
  if (meta.length) out.push("meta");
  if (google.length) out.push("google");
  if (tiktok.length) out.push("tiktok");
  return out;
}
