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
  // No expiry and no extras: Google refresh tokens are reusable, do not rotate,
  // and the accessible customers are re-queried at discovery rather than
  // trusted from the exchange.
  return await putConnectStash("google", clientId, refreshToken);
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
): Promise<{
  accounts: DiscoveredAccount[];
  partial: boolean;
  /**
   * 🔴 The first refusal, kept rather than dropped.
   *
   * "Some parts of this account tree could not be read" is true and useless on
   * its own: it cannot distinguish one suspended manager — ignorable — from
   * every account failing, which is a setup that will never sync. The operator
   * could not tell which, and neither could we, because the only copy of the
   * reason was a `catch` that discarded it.
   *
   * Handed back raw. The route redacts it, because the same taxonomy that
   * decides what a tenant may read already exists and must not be reimplemented
   * here.
   */
  partialError?: unknown;
}> {
  const root = new GoogleAdsClient(refreshToken, "");
  const accessible = await root.listAccessibleCustomers();

  const byId = new Map<string, DiscoveredAccount>();
  let partial = false;
  let partialError: unknown = null;

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

    /*
     * 🔴 Twice, the second time naming the account as its own manager.
     *
     * `listAccessibleCustomers` hands back every customer the sign-in can
     * reach, INCLUDING manager accounts and accounts that sit under one. Google
     * will not answer a `FROM customer` query for those without a
     * `login-customer-id` header saying which authorised customer the request
     * is being made through — it answers 403 USER_PERMISSION_DENIED instead.
     *
     * This asked once, with no header, and treated the refusal as "cannot read
     * this branch". The visible cost was a picker listing seven bare ten-digit
     * ids with no name, currency or timezone — and, worse, `loginCustomerId`
     * left as "" on every one of them, so ATTACHING an account then failed the
     * same way and reported "Connected, but Google no longer shows this account
     * to that sign-in". Nothing was wrong with the sign-in.
     *
     * The plain attempt stays first: it is correct for a directly-owned account
     * and one round trip cheaper. The retry is what rescues everything under a
     * manager, and when it is the one that works, the header it used is the
     * header every later query for that account must carry — so it is recorded
     * rather than rediscovered.
     */
    /*
     * 🔴 Every manager it could be reached through, not just "none" and
     * "itself".
     *
     * Google documents USER_PERMISSION_DENIED as *either* "the user has no
     * access to this customer" *or* "`login-customer-id` is not set correctly",
     * and the two are indistinguishable in the response. An agency login
     * usually reaches a client account THROUGH a manager, so the correct header
     * is that manager's id — which is neither empty nor the account's own id,
     * and is very often another entry in this same accessible list.
     *
     * So the candidates are: no header (a directly-owned account, and one round
     * trip cheaper), the account itself (a manager being read directly), then
     * every other accessible customer as a possible parent. It stops at the
     * first that answers, so the common cases still cost one call, and the
     * whole list is bounded by what `listAccessibleCustomers` returned.
     */
    const attempts: Array<{ loginCustomerId: string }> = [
      { loginCustomerId: "" },
      { loginCustomerId: customerId },
      ...accessible
        .filter((other) => other !== customerId)
        .map((other) => ({ loginCustomerId: other })),
    ];
    let read = false;
    let lastErr: unknown = null;

    for (const attempt of attempts) {
      try {
        const info = await new GoogleAdsClient(
          refreshToken,
          attempt.loginCustomerId,
        ).getCustomer(customerId);
        self = {
          ...self,
          name: info.descriptiveName,
          currency: info.currencyCode,
          timezone: info.timeZone,
          loginCustomerId: attempt.loginCustomerId,
        };
        read = true;
        break;
      } catch (err) {
        lastErr = err;
      }
    }

    if (!read) {
      /*
       * Both attempts refused. The id is kept — it is still the route to the
       * children below — but this is LOGGED, because the alternative was a
       * picker full of nameless ids with the reason discarded: not in the UI,
       * not in the server logs, nowhere.
       */
      /*
       * 🔴 The MESSAGE, not the error object.
       *
       * `console.error(err)` hands the object to Node's inspector, which stops
       * at depth 2 and prints `body: [ { error: [Object] } ]` — collapsing the
       * one field that says what Google actually objected to. `GoogleAdsError`
       * already interpolates the whole response body into its message, so the
       * string carries everything the object does and nothing truncates it.
       *
       * This mattered: the first real log line from production named a 403 and
       * then hid the reason behind `[Object]`, which is how three plausible
       * fixes got shipped for a cause nobody had actually read.
       */
      console.error(
        `[google-connect] customer ${customerId} details unreadable:`,
        lastErr instanceof Error ? lastErr.message : String(lastErr),
      );
      partial = true;
      partialError ??= lastErr;
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
    } catch (err) {
      // Same reasoning as above: swallowed so one suspended manager does not
      // cost the other four, logged so "incomplete" is explicable.
      console.error(
        `[google-connect] could not expand ${customerId}:`,
        err instanceof Error ? err.message : String(err),
      );
      partial = true;
      partialError ??= err;
    }
  }

  const accounts = [...byId.values()].sort((a, b) => {
    // Managers first, then by name, so the tree reads as a structure rather
    // than an arbitrary list of ten-digit numbers.
    if (a.isManager !== b.isManager) return a.isManager ? -1 : 1;
    return (a.name ?? a.customerId).localeCompare(b.name ?? b.customerId);
  });

  return { accounts, partial, partialError: partialError ?? undefined };
}
