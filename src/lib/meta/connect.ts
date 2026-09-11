import {
  putConnectStash,
  readConnectStash,
  dropConnectStash,
} from "@/lib/connect-stash";
import { MetaClient, type MetaAdAccountSummary } from "./client";

/**
 * The gap between "they signed in with Facebook" and "these accounts are this
 * client's".
 *
 * A media buyer's Facebook account can reach every account the agency manages.
 * Attaching all of them because someone connected one client would put another
 * tenant's spend on this dashboard — so consent and selection are two steps, and
 * the token waits here in between.
 *
 * The stash itself lives in `lib/connect-stash.ts`, shared with the Google
 * flow: see there for why it is a table rather than the in-process Map it
 * started as, and why the tenant check must not exist in two copies.
 */

export type MetaStashLookup =
  | { ok: true; clientId: string; accessToken: string; tokenExpiresAt: Date | null }
  | { ok: false; reason: "expired" | "wrong_client" };

export async function stashMetaConnection(
  clientId: string,
  accessToken: string,
  tokenExpiresAt: Date | null,
): Promise<string> {
  /*
   * 🔴 The expiry travels WITH the token. A Meta user token lasts ~60 days,
   * and that date has to survive the picker to reach `meta_ad_accounts`, where
   * the health check warns on it while there is still time to re-authorise.
   * Dropped here, the connection would simply stop working two months after a
   * setup that looked perfect.
   */
  return await putConnectStash("meta", clientId, accessToken, tokenExpiresAt);
}

export async function readMetaStash(
  id: string,
  expectedClientId: string,
): Promise<MetaStashLookup> {
  const found = await readConnectStash("meta", id, expectedClientId);
  if (!found.ok) return found;
  return {
    ok: true,
    clientId: found.clientId,
    accessToken: found.token,
    tokenExpiresAt: found.tokenExpiresAt,
  };
}

export async function dropMetaStash(id: string): Promise<void> {
  await dropConnectStash("meta", id);
}

/* ------------------------------------------------------------------ *
 * Discovery
 * ------------------------------------------------------------------ */

export interface DiscoveredMetaAccount {
  adAccountId: string;
  name: string | null;
  currency: string | null;
  timezone: string | null;
  /** Meta's `account_status`; 1 is the only usable state. */
  active: boolean;
}

/**
 * Every ad account the authorising Facebook user can reach.
 *
 * Disabled and closed accounts are returned rather than filtered, flagged
 * instead. An operator looking for an account they know exists needs to see it
 * greyed out with a reason — silently omitting it reads as "the sign-in did not
 * work" and sends them round the consent flow again.
 */
export async function discoverMetaAccounts(
  accessToken: string,
): Promise<DiscoveredMetaAccount[]> {
  const rows: MetaAdAccountSummary[] = await new MetaClient(accessToken).listAdAccounts();

  return rows
    .map((r) => ({
      adAccountId: String(r.account_id),
      name: r.name ?? null,
      currency: r.currency ?? null,
      timezone: r.timezone_name ?? null,
      active: r.account_status === 1,
    }))
    .sort((a, b) => {
      // Usable accounts first, then by name — an alphabetical list of numeric
      // ids is not a list anyone can pick from.
      //
      // Grouping by Business Manager would be the natural agency ordering, but
      // that field needs `business_management`; see the note in
      // `client.listAdAccounts`. The picker's filter box covers the same need.
      if (a.active !== b.active) return a.active ? -1 : 1;
      return (a.name ?? a.adAccountId).localeCompare(b.name ?? b.adAccountId);
    });
}
