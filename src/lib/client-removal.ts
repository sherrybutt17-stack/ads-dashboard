import { and, eq, ne } from "drizzle-orm";
import { db } from "@/db";
import {
  clients,
  metaAdAccounts,
  googleAdAccounts,
  userClients,
  users,
} from "@/db/schema";
import { markUninstalled } from "@/lib/ghl/oauth";

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
 *   - Meta/Google ad accounts: soft-removed (historical spend is kept).
 *   - Client logins: this client's grants are revoked, and any client user left
 *     with no dashboards is disabled so their credentials stop working.
 */
export interface RemoveClientResult {
  ghlDisconnected: boolean;
  metaAccountsRemoved: number;
  googleAccountsRemoved: number;
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
    await markUninstalled(client.ghlLocationId).catch(() => {});
    ghlDisconnected = true;
  }

  // 2. Soft-remove ad-account connections (keeps their historical metrics).
  const metaRemoved = await db
    .update(metaAdAccounts)
    .set({ status: "removed", isPrimary: false, updatedAt: new Date() })
    .where(
      and(eq(metaAdAccounts.clientId, clientId), ne(metaAdAccounts.status, "removed")),
    )
    .returning({ id: metaAdAccounts.id });

  const googleRemoved = await db
    .update(googleAdAccounts)
    .set({ status: "removed", isPrimary: false, updatedAt: new Date() })
    .where(
      and(eq(googleAdAccounts.clientId, clientId), ne(googleAdAccounts.status, "removed")),
    )
    .returning({ id: googleAdAccounts.id });

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
    clientLoginsDisabled: disabled,
  };
}
