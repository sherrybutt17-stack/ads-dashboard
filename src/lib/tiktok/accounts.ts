import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { clients, tiktokAdAccounts, type TiktokAdAccount } from "@/db/schema";
import { encrypt } from "@/lib/crypto";
import { TiktokClient, normalizeAdvertiserId } from "./client";

/**
 * TikTok advertisers attached to a client, for display.
 *
 * Degrades to an empty list rather than throwing, exactly as the Google
 * equivalent does: this table is added by a migration, and a deploy that lands
 * before its migration would otherwise take the whole dashboard down over a
 * platform the client may not even use.
 */
export async function activeTiktokAccountsForDisplay(
  clientId: string,
): Promise<{ accounts: TiktokAdAccount[]; error: string | null }> {
  try {
    const rows = await db
      .select()
      .from(tiktokAdAccounts)
      .where(eq(tiktokAdAccounts.clientId, clientId));
    return { accounts: rows.filter((r) => r.status !== "removed"), error: null };
  } catch (err) {
    console.error("[tiktok] account list unavailable:", err);
    return {
      accounts: [],
      error: err instanceof Error ? err.message : "unavailable",
    };
  }
}

/**
 * Active advertisers — what the sync, the pipe status and the roll-up read.
 *
 * Lives here rather than in `sync.ts` so that `pipe-status.ts` can ask "does
 * this client have TikTok attached" without importing the entire sync module,
 * matching how the Meta and Google equivalents are laid out. `sync.ts`
 * re-exports it for its existing callers.
 *
 * Unlike `activeTiktokAccountsForDisplay` above, this one throws. A caller that
 * is about to sync or to total spend must not silently read "no accounts" from
 * a database error — that is the difference between "this client does not use
 * TikTok" and "we could not tell", and only the display path can afford to
 * blur it.
 */
/**
 * The advertisers this client actually has, for syncing and pipe status.
 *
 * 🔴 `!== "removed"`, not `=== "active"`.
 *
 * Three places ask this question — here, `activeTiktokAccountsForDisplay`, and
 * the batched SQL in `metrics/pipe-status.ts` — and this one disagreed with the
 * other two. Today that is invisible: the app only ever writes `active` (on
 * add, and as the column default) or `removed`, so the two predicates select
 * the same rows and a comment in `pipe-status.ts` claiming they match went
 * unchallenged.
 *
 * It stops being invisible the moment a third status exists. TikTok's own
 * advertiser states include disabled and under-review, and the obvious future
 * change — recording what the platform reports — would make a paused advertiser
 * vanish from the sync and from the client page while the portfolio page still
 * counted it. Removed is the only state this app treats as gone, and it is the
 * only one it writes deliberately; everything else is an advertiser we still
 * hold history for.
 */
export async function activeTiktokAccounts(
  clientId: string,
): Promise<TiktokAdAccount[]> {
  const rows = await db
    .select()
    .from(tiktokAdAccounts)
    .where(eq(tiktokAdAccounts.clientId, clientId));
  return rows.filter((r) => r.status !== "removed");
}

export interface AddTiktokAccountResult {
  account: TiktokAdAccount;
  /** Set when this advertiser's currency differs from the client's Meta primary. */
  currencyMismatch?: { client: string; thisAccount: string };
  /** Set when its timezone differs from the client's reporting timezone. */
  timezoneMismatch?: { client: string; thisAccount: string };
}

/**
 * Verify a TikTok advertiser against the API, then attach it to a client.
 *
 * Verify-then-store, as `addAdAccount` does for Meta: an advertiser the grant
 * cannot actually reach is caught here, echoing back its real name, rather than
 * being stored and surfacing later as an account reporting zero spend forever —
 * which on this dashboard is indistinguishable from a paused campaign.
 *
 * ── 🔴 What this deliberately does NOT do ─────────────────────────────
 *
 * Meta's equivalent writes the account's timezone onto `clients.timezone`,
 * because the first ad account connected defines how the client's days are
 * bucketed. This one **never** touches it. By the time TikTok is being
 * connected there is almost always Meta or Google data already stored, bucketed
 * in the existing timezone — silently re-pointing it here would shift every
 * historical day boundary on the dashboard for a platform the client may have
 * just added as a secondary. The mismatch is reported instead, so a real
 * disagreement is a sentence the operator reads rather than a number that moved.
 *
 * There is also no `isPrimary` here, and no global-uniqueness clash check:
 * `tiktok_ad_accounts` is uniquely indexed on `(client_id, advertiser_id)`, so
 * an advertiser can legitimately appear under two clients without one squatting
 * the other. That is the correct multi-tenant shape and it should stay that way.
 */
export async function addTiktokAccount(
  clientId: string,
  rawAdvertiserId: string,
  accessToken: string,
): Promise<AddTiktokAccountResult> {
  const advertiserId = normalizeAdvertiserId(rawAdvertiserId);

  const info = await new TiktokClient(accessToken).getAdvertiser(advertiserId);
  if (!info) {
    throw new Error(
      "That TikTok authorization cannot reach this advertiser account.",
    );
  }

  const values = {
    clientId,
    advertiserId,
    advertiserName: info.advertiser_name ?? null,
    /*
     * The grant is stored per advertiser row. TikTok issues one token covering
     * many advertisers, so the same ciphertext lands on each — which is what
     * makes revocation of a single advertiser a row-level operation.
     */
    accessTokenEncrypted: encrypt(accessToken),
    currency: info.currency ?? null,
    timezone: info.timezone ?? null,
    status: "active" as const,
    updatedAt: new Date(),
  };

  const [account] = await db
    .insert(tiktokAdAccounts)
    .values(values)
    .onConflictDoUpdate({
      target: [tiktokAdAccounts.clientId, tiktokAdAccounts.advertiserId],
      set: values,
    })
    .returning();

  const [client] = await db
    .select({ timezone: clients.timezone, currency: clients.metaCurrency })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);

  const result: AddTiktokAccountResult = { account };
  if (client?.currency && info.currency && client.currency !== info.currency) {
    result.currencyMismatch = {
      client: client.currency,
      thisAccount: info.currency,
    };
  }
  if (client?.timezone && info.timezone && client.timezone !== info.timezone) {
    result.timezoneMismatch = {
      client: client.timezone,
      thisAccount: info.timezone,
    };
  }
  return result;
}

/**
 * Detach an advertiser.
 *
 * Marked `removed` rather than deleted, so the metrics already pulled under it
 * stay in `tiktok_daily_metrics` and historical totals do not silently drop —
 * the same rule as Meta and Google.
 */
export async function removeTiktokAccount(
  clientId: string,
  accountId: string,
): Promise<void> {
  const [account] = await db
    .update(tiktokAdAccounts)
    .set({ status: "removed", updatedAt: new Date() })
    .where(
      and(
        eq(tiktokAdAccounts.id, accountId),
        eq(tiktokAdAccounts.clientId, clientId),
      ),
    )
    .returning();
  if (!account) throw new Error("Account not found");
}
