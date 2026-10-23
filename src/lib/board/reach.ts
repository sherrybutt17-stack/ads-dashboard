import type { Client } from "@/db/schema";
import type { DateWindow } from "@/lib/dates";
import { activeAdAccounts } from "@/lib/meta/accounts";
import { syncAccountPeriodReach } from "@/lib/meta/sync";
import { getPeriodReachRow } from "@/lib/metrics/board-queries";

export type ReachOutcome =
  | "cached"
  | "fetched"
  | "multi_account"
  | "no_account"
  | "timeout"
  | "failed";

/**
 * Make sure reach for exactly this range is in `fb_period_reach`.
 *
 * Reach counts distinct people over the whole range, so it can never be built
 * from the stored daily rows — it is one question to Meta per range. The
 * nightly sync only asks for two fixed windows, so a board range almost always
 * needs a fresh one.
 *
 * Never called while rendering a page: a page shows the widget as pending and
 * the widget asks the data API, which calls this. A slow Meta answer then
 * delays one tile, not the board. The timeout does not cancel the request — if
 * Meta answers late, the row still lands and the next view reads it.
 *
 * Single-account clients only. Two accounts may reach the same person, and
 * their figures cannot be added, so there is no honest combined number.
 */
export async function ensurePeriodReach(
  client: Client,
  window: DateWindow,
  opts: { timeoutMs?: number } = {},
): Promise<ReachOutcome> {
  try {
    const cached = await getPeriodReachRow(client.id, window);
    if (cached === "multiple") return "multi_account";
    if (cached) return "cached";

    const accounts = await activeAdAccounts(client.id);
    if (accounts.length === 0) return "no_account";
    if (accounts.length > 1) return "multi_account";

    const work = syncAccountPeriodReach(client, accounts[0], window.startKey, window.endKey);
    // Swallowed here so a late failure after the timeout is not an unhandled rejection.
    work.catch((err) => console.error("[board] period reach failed:", err));

    const timeoutMs = opts.timeoutMs ?? 8000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    try {
      const result = await Promise.race([work.then(() => "fetched" as const), timeout]);
      return result;
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch (err) {
    console.error("[board] period reach unavailable:", err);
    return "failed";
  }
}
