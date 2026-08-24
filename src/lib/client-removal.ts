import { and, eq, ne } from "drizzle-orm";
import { db } from "@/db";
import {
  clients,
  metaAdAccounts,
  googleAdAccounts,
  tiktokAdAccounts,
  userClients,
  users,
} from "@/db/schema";
import { markUninstalledForClient } from "@/lib/ghl/oauth";

/**
 * Remove a client and disconnect everything attached to it.
 *
 * We ARCHIVE rather than hard-delete: `stage_transitions` is the append-only
 * system-of-record and GoHighLevel exposes no history API, so a delete would
 * destroy funnel history that can never be recovered. Everything else is
 * disconnected so we stop touching the client's systems:
 *
 *   - GHL: the marketplace install is marked uninstalled (we ignore its
 *     webhooks) and the stored token is dropped. We cannot force GHL to remove
 *     the app from their sub-account — only they can — but it is inert for us.
 *   - Ad accounts on EVERY platform: soft-removed (historical spend is kept)
 *     and their stored credential cleared. A platform this function forgets
 *     keeps a live access token on a client we were asked to let go of, and
 *     keeps a connection that other surfaces read as active — while the removal
 *     reports success. TikTok was that omission until 2026-08-19: this module
 *     was written when Meta and Google were the only platforms.
 *   - Client logins: this client's grants are revoked, and any client user left
 *     with no dashboards is disabled so their credentials stop working.
 */
export interface RemoveClientResult {
  ghlDisconnected: boolean;
  metaAccountsRemoved: number;
  googleAccountsRemoved: number;
  tiktokAccountsRemoved: number;
  clientLoginsDisabled: number;
}

export async function removeClient(
  clientId: string,
): Promise<RemoveClientResult> {
  const [client] = await db
    .select()
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  if (!client) throw new Error("Client not found");

  // 1. Disconnect GoHighLevel.
  let ghlDisconnected = false;
  if (client.ghlLocationId) {
    /*
     * 🔴 Keyed on the CLIENT, not on `client.ghlLocationId`.
     *
     * That column can be typed into a form. Marking uninstalled by location id
     * meant deleting your own client could kill a different tenant's live
     * GoHighLevel connection — you only had to have entered their location id.
     * `markUninstalledForClient` can only touch a row actually bound here.
     */
    await markUninstalledForClient(client.id).catch(() => {});
    ghlDisconnected = true;
  }

  /*
   * 2. Soft-remove every ad-account connection, keeping its historical metrics
   *    and clearing its credential.
   *
   * 🔴 The token is cleared, not just the status. `removed` is a soft flag on a
   * row that still exists, so leaving the credential means any query that
   * forgets the filter is holding usable access to a client's ad account after
   * we were asked to disconnect — which is the same reasoning that has always
   * dropped the GHL token below. It costs nothing to re-add: every add path
   * upserts and supplies a fresh token.
   */
  const now = new Date();
  const metaRemoved = await db
    .update(metaAdAccounts)
    .set({ status: "removed", isPrimary: false, tokenEncrypted: null, updatedAt: now })
    .where(
      and(eq(metaAdAccounts.clientId, clientId), ne(metaAdAccounts.status, "removed")),
    )
    .returning({ id: metaAdAccounts.id });

  const googleRemoved = await db
    .update(googleAdAccounts)
    .set({
      status: "removed",
      isPrimary: false,
      refreshTokenEncrypted: null,
      updatedAt: now,
    })
    .where(
      and(eq(googleAdAccounts.clientId, clientId), ne(googleAdAccounts.status, "removed")),
    )
    .returning({ id: googleAdAccounts.id });

  const tiktokRemoved = await db
    .update(tiktokAdAccounts)
    .set({ status: "removed", accessTokenEncrypted: null, updatedAt: now })
    .where(
      and(eq(tiktokAdAccounts.clientId, clientId), ne(tiktokAdAccounts.status, "removed")),
    )
    .returning({ id: tiktokAdAccounts.id });

  // 3. Revoke logins: drop this client's grants, then disable any client user
  //    left with zero dashboards.
  const affected = await db
    .select({ userId: userClients.userId })
    .from(userClients)
    .where(eq(userClients.clientId, clientId));
  await db.delete(userClients).where(eq(userClients.clientId, clientId));

  let disabled = 0;
  for (const { userId } of affected) {
    const remaining = await db
      .select({ id: userClients.id })
      .from(userClients)
      .where(eq(userClients.userId, userId));
    if (remaining.length === 0) {
      const [u] = await db
        .update(users)
        .set({ status: "disabled", updatedAt: new Date() })
        .where(and(eq(users.id, userId), eq(users.role, "client")))
        .returning({ id: users.id });
      if (u) disabled += 1;
    }
  }

  // 4. Archive the client and drop its stored GHL token. History is kept.
  await db
    .update(clients)
    .set({ status: "archived", ghlTokenEncrypted: null, updatedAt: new Date() })
    .where(eq(clients.id, clientId));

  return {
    ghlDisconnected,
    metaAccountsRemoved: metaRemoved.length,
    googleAccountsRemoved: googleRemoved.length,
    tiktokAccountsRemoved: tiktokRemoved.length,
    clientLoginsDisabled: disabled,
  };
}
