import {
  putConnectStash,
  readConnectStash,
  dropConnectStash,
} from "@/lib/connect-stash";
import { GoogleAdsClient, type GoogleAccountNode } from "./client";

/**
 * The gap between "the client signed in" and "these accounts are theirs".
 *
 * Authorizing with a Google account that can see forty customers must not
 * silently attach forty customers — which is the whole reason this step exists
 * rather than the callback wiring things up directly. The refresh token waits,
 * encrypted, while the operator picks.
 *
 * The stash itself lives in `lib/connect-stash.ts`, shared with the Meta flow:
 * see there for why it is a table rather than the in-process Map it started as,
 * and why the tenant check must not exist in two copies.
 */

export type StashLookup =
  | { ok: true; clientId: string; refreshToken: string }
  | { ok: false; reason: "expired" | "wrong_client" };

export async function stashGoogleConnection(
  clientId: string,
  refreshToken: string,
): Promise<string> {
  // No expiry: Google refresh tokens are reusable and do not rotate.
  return await putConnectStash("google", clientId, refreshToken, null);
}

export async function readGoogleStash(
  id: string,
  expectedClientId: string,
): Promise<StashLookup> {
  const found = await readConnectStash("google", id, expectedClientId);
  if (!found.ok) return found;
  return { ok: true, clientId: found.clientId, refreshToken: found.token };
}

export async function dropGoogleStash(id: string): Promise<void> {
  await dropConnectStash("google", id);
}

/* ------------------------------------------------------------------ *
 * Discovery
 * ------------------------------------------------------------------ */

export interface DiscoveredAccount extends GoogleAccountNode {
  /**
   * 🔴 The manager to send as `login-customer-id` when querying this account,
   * or `""` when there is none above it.
   *
   * Resolved HERE, at discovery, because this is the only moment the hierarchy
   * is actually known. Deriving it later would mean re-walking the tree on
   * every sync, and defaulting it to the agency MCC — which is what the code
   * did before — produces a request that is syntactically valid and returns
   * nothing for an account that plainly has spend.
   */
  loginCustomerId: string;
}

/**
 * Everything the authorizing Google account can reach, flattened.
 *
 * `listAccessibleCustomers` returns only what the user can touch DIRECTLY — if
 * they authorized with a manager account, that is the manager alone, not the
 * accounts beneath it. So each accessible customer is expanded through
 * `customer_client`, and the results are merged.
 *
 * Failures on individual branches are swallowed rather than aborting: a user
 * with access to five managers, one of which has been suspended, should get the
 * other four rather than an error page.
 */
export async function discoverGoogleAccounts(
  refreshToken: string,
): Promise<{ accounts: DiscoveredAccount[]; partial: boolean }> {
  const root = new GoogleAdsClient(refreshToken, "");
  const accessible = await root.listAccessibleCustomers();

  const byId = new Map<string, DiscoveredAccount>();
  let partial = false;

  for (const customerId of accessible) {
    /*
     * A directly-accessible customer is reached with NO manager header — the
     * user's own grant is the authorization. Recorded as `""` rather than null
     * so "no manager" is stored as a decision rather than as an absence that a
     * later reader would fill in with the agency default.
     */
    let self: DiscoveredAccount = {
      customerId,
      name: null,
      currency: null,
      timezone: null,
      isManager: false,
      level: 0,
      loginCustomerId: "",
    };

    try {
      const info = await new GoogleAdsClient(refreshToken, "").getCustomer(customerId);
      self = {
        ...self,
        name: info.descriptiveName,
        currency: info.currencyCode,
        timezone: info.timeZone,
      };
    } catch {
      // A manager account can refuse a plain `customer` query. Keep the id —
      // it is still the route to the children below.
      partial = true;
    }
    byId.set(customerId, self);

    // Expand beneath it. If this customer is not a manager the query simply
    // returns nothing, which is cheaper than asking first.
    try {
      const children = await new GoogleAdsClient(refreshToken, customerId)
        .listClientAccounts(customerId);
      for (const child of children) {
        byId.set(child.customerId, {
          ...child,
          // Reached THROUGH the manager we just queried.
          loginCustomerId: customerId,
        });
      }
      if (children.length > 0) {
        const parent = byId.get(customerId);
        if (parent) byId.set(customerId, { ...parent, isManager: true });
      }
    } catch {
      partial = true;
    }
  }

  const accounts = [...byId.values()].sort((a, b) => {
    // Managers first, then by name, so the tree reads as a structure rather
    // than an arbitrary list of ten-digit numbers.
    if (a.isManager !== b.isManager) return a.isManager ? -1 : 1;
    return (a.name ?? a.customerId).localeCompare(b.name ?? b.customerId);
  });

  return { accounts, partial };
}
