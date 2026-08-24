import { randomBytes } from "node:crypto";
import { encrypt, decrypt } from "@/lib/crypto";
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
 * 🔴 **In-process, deliberately, with a short life.** Parking a live ad-account
 * credential in a table for a flow somebody abandoned two minutes in leaves a
 * row nobody cleans up. If the pick is abandoned this evaporates with the
 * process, and starting again is one click.
 *
 * The honest cost: on serverless, a later request may land on another instance
 * and find nothing. That reads as "your sign-in expired, try again" — a
 * recoverable inconvenience, where the durable alternative's failure mode is a
 * leaked credential nobody knows exists. Mirrors `lib/google/connect.ts`.
 */

interface Stash {
  clientId: string;
  tokenEncrypted: string;
  /** Token expiry, not stash expiry. Null when the token does not expire. */
  tokenExpiresAt: Date | null;
  expiresAt: number;
}

const STASH_TTL_MS = 15 * 60_000;
const stash = new Map<string, Stash>();

function prune(now = Date.now()) {
  for (const [k, v] of stash) if (v.expiresAt <= now) stash.delete(k);
}

export async function stashMetaConnection(
  clientId: string,
  accessToken: string,
  tokenExpiresAt: Date | null,
): Promise<string> {
  prune();
  const id = randomBytes(18).toString("base64url");
  stash.set(id, {
    clientId,
    // Encrypted even in memory: a heap dump or a serialised error should not
    // print a live credential.
    tokenEncrypted: encrypt(accessToken),
    tokenExpiresAt,
    expiresAt: Date.now() + STASH_TTL_MS,
  });
  return id;
}

export type MetaStashLookup =
  | { ok: true; clientId: string; accessToken: string; tokenExpiresAt: Date | null }
  | { ok: false; reason: "expired" | "wrong_client" };

/**
 * Retrieve a stashed connection.
 *
 * `expectedClientId` is checked rather than trusted: the stash id travels
 * through a URL, and one minted for one client must not attach accounts to
 * another.
 */
export function readMetaStash(id: string, expectedClientId: string): MetaStashLookup {
  prune();
  const found = stash.get(id);
  if (!found) return { ok: false, reason: "expired" };
  if (found.clientId !== expectedClientId) return { ok: false, reason: "wrong_client" };
  return {
    ok: true,
    clientId: found.clientId,
    accessToken: decrypt(found.tokenEncrypted),
    tokenExpiresAt: found.tokenExpiresAt,
  };
}

export function dropMetaStash(id: string) {
  stash.delete(id);
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
