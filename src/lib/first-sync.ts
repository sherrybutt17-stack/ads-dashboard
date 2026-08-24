import type { Client } from "@/db/schema";
import type { AdPlatform } from "@/lib/platforms";
import { backfillClientMetrics } from "@/lib/meta/sync";
import { backfillClientGoogleMetrics } from "@/lib/google/sync";
import { syncClientTiktokMetrics } from "@/lib/tiktok/sync";
import { getAdPipeStatus } from "@/lib/metrics/pipe-status";
import { trailingWindowInclusive } from "@/lib/dates";

/**
 * Start pulling history the moment an ad account is attached.
 *
 * ── The problem this solves ───────────────────────────────────────────
 *
 * Connecting an ad account used to succeed into silence. The nightly
 * reconciliation might be twelve hours away, so the operator finished the
 * wizard, opened the dashboard, and saw an empty state — with no way to tell
 * whether they had done something wrong, whether it was broken, or whether they
 * simply needed to wait. The 90-day import existed the whole time, as a button
 * further down the setup page that nobody had a reason to press yet.
 *
 * This is the moment a trial is won or abandoned, and it was the only stage of
 * the journey with no designed behaviour at all.
 *
 * ── Why it only ever runs once ────────────────────────────────────────
 *
 * Guarded on the pipe having never completed a full pull. Re-attaching an
 * account, fixing a typo, or adding a second ad account to a client that
 * already has three months of data must NOT kick another 90-day re-pull —
 * that is a large number of API calls against a rate limit shared with the
 * nightly cron, bought for no new information.
 */
export const FIRST_SYNC_DAYS = 90;

/**
 * Kick the first import, if this platform has never completed one.
 *
 * 🔴 **Call inside `after()`, never bare and never awaited.** A 90-day pull
 * takes minutes; awaiting it would hold the account-picker's HTTP response open
 * until it finished or the route timed out, so the operator would watch a
 * spinner instead of the "connected" state they just earned. `after()` also
 * beats a floating promise, which the platform is free to kill the instant the
 * response is flushed — the same reasoning already applied in
 * `webhooks/crm/route.ts` and on the dashboard page.
 *
 * Resolves to what it did, for logging. Never throws: the sync writes its own
 * `sync_runs` row either way, so a failure is already recorded where the health
 * checklist and the dashboard's pipe status will both find it. Throwing here
 * would only add an unhandled rejection on a path with no caller left to catch
 * it.
 */
export async function kickFirstSync(
  client: Client,
  platform: AdPlatform,
): Promise<"started" | "skipped" | "failed"> {
  try {
    const pipe = await getAdPipeStatus(client, platform);

    /*
     * `lastSuccessAt` rather than "are there rows": a client can hold metric
     * rows from a since-detached account, and re-importing on top of those is
     * the needless re-pull this guard exists to prevent. A run currently in
     * flight also counts as already-started — two concurrent 90-day imports
     * would race each other into the same unique index.
     */
    if (pipe.lastSuccessAt || pipe.state === "backfilling") return "skipped";
    if (pipe.state === "not_connected") return "skipped";

    const window = trailingWindowInclusive(FIRST_SYNC_DAYS, client.timezone);

    switch (platform) {
      case "meta":
        await backfillClientMetrics(client, FIRST_SYNC_DAYS);
        break;
      case "google":
        await backfillClientGoogleMetrics(client, FIRST_SYNC_DAYS);
        break;
      case "tiktok":
        /*
         * No `backfillClientTiktokMetrics` exists — the ordinary sync takes an
         * explicit window, which is all a backfill is here. It records
         * `tiktok_daily`, which `FULL_SYNC_KINDS` already counts, so the pipe
         * status sees it exactly as it sees the other two.
         */
        await syncClientTiktokMetrics(client, {
          since: window.startKey,
          until: window.endKey,
        });
        break;
    }
    return "started";
  } catch (err) {
    console.error(`[first-sync] ${platform} import failed for ${client.slug}:`, err);
    return "failed";
  }
}
