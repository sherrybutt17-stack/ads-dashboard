import { randomBytes } from "node:crypto";
import { encrypt, decrypt } from "@/lib/crypto";
import { GoogleAdsClient, type GoogleAccountNode } from "./client";

/**
 * The gap between "the client signed in" and "these accounts are theirs".
 *
 * Authorizing with a Google account that can see forty customers must not
 * silently attach forty customers — which is the whole reason this step exists
 * rather than the callback wiring things up directly. The refresh token is held
 * here, encrypted, while the operator picks.
 *
 * 🔴 **In-process, deliberately, with a short life.** A refresh token is a
 * long-lived credential; parking it in a database table for an unfinished flow
 * means a row that nobody ever cleans up, holding live access to a client's ad
 * account, for a decision that was abandoned two minutes after it started. If
 * the pick is abandoned the token evaporates with the process — and starting
 * again is one click.
 *
 * The cost is honest: on a serverless platform a later request may land on a
 * different instance and find nothing. That reads as "your sign-in expired,
 * please try again", which is a recoverable inconvenience, where the durable
 * alternative's failure mode is a leaked credential nobody knows exists.
 */

interface Stash {
  clientId: string;
  refreshTokenEncrypted: string;
  expiresAt: number;
}

const STASH_TTL_MS = 15 * 60_000;
const stash = new Map<string, Stash>();

function prune(now = Date.now()) {
  for (const [k, v] of stash) if (v.expiresAt <= now) stash.delete(k);
}

export async function stashGoogleConnection(
  clientId: string,
  refreshToken: string,
): Promise<string> {
  prune();
  const id = randomBytes(18).toString("base64url");
  stash.set(id, {
    clientId,
    // Encrypted even in memory: a heap dump or an error serialising this map
    // should not print a live credential.
    refreshTokenEncrypted: encrypt(refreshToken),
    expiresAt: Date.now() + STASH_TTL_MS,
  });
  return id;
}

export type StashLookup =
  | { ok: true; clientId: string; refreshToken: string }
  | { ok: false; reason: "expired" | "wrong_client" };

/**
 * Retrieve a stashed connection.
 *
 * `expectedClientId` is checked rather than trusted from the caller: the stash
 * id travels through a URL, and a stash minted for one client must not be
 * usable to attach accounts to another.
 */
export function readGoogleStash(
  id: string,
  expectedClientId: string,
): StashLookup {
  prune();
  const found = stash.get(id);
  if (!found) return { ok: false, reason: "expired" };
  if (found.clientId !== expectedClientId) {
    return { ok: false, reason: "wrong_client" };
  }
  return {
    ok: true,
    clientId: found.clientId,
    refreshToken: decrypt(found.refreshTokenEncrypted),
  };
}

export function dropGoogleStash(id: string) {
  stash.delete(id);
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
