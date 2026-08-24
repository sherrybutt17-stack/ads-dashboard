import { randomBytes } from "node:crypto";
import { encrypt, decrypt } from "@/lib/crypto";
import { TiktokClient, type TiktokAdvertiser } from "./client";

/**
 * The gap between "they authorized TikTok" and "these advertisers are this
 * client's".
 *
 * One TikTok grant can cover every advertiser an agency manages — the token
 * exchange literally hands back an `advertiser_ids` array — so attaching all of
 * them because someone connected one client would put another tenant's spend on
 * this dashboard. Consent and selection stay two steps, and the token waits here
 * in between.
 *
 * 🔴 **In-process, deliberately, with a short life.** Identical reasoning to
 * `lib/meta/connect.ts` and `lib/google/connect.ts`: parking a live ad-account
 * credential in a table for a flow somebody abandoned two minutes in leaves a
 * row nobody cleans up. If the pick is abandoned this evaporates with the
 * process, and starting again is one click.
 *
 * The honest cost: on serverless, a later request may land on another instance
 * and find nothing. That reads as "your sign-in expired, try again" — a
 * recoverable inconvenience, where the durable alternative's failure mode is a
 * leaked credential nobody knows exists.
 */

interface Stash {
  clientId: string;
  tokenEncrypted: string;
  /**
   * The advertiser ids the exchange reported. Held only as a cross-check —
   * discovery re-queries TikTok and that answer wins.
   */
  advertiserIds: string[];
  expiresAt: number;
}

const STASH_TTL_MS = 15 * 60_000;
const stash = new Map<string, Stash>();

function prune(now = Date.now()) {
  for (const [k, v] of stash) if (v.expiresAt <= now) stash.delete(k);
}

export async function stashTiktokConnection(
  clientId: string,
  accessToken: string,
  advertiserIds: string[],
): Promise<string> {
  prune();
  const id = randomBytes(18).toString("base64url");
  stash.set(id, {
    clientId,
    // Encrypted even in memory: a heap dump or a serialised error should not
    // print a live credential.
    tokenEncrypted: encrypt(accessToken),
    advertiserIds,
    expiresAt: Date.now() + STASH_TTL_MS,
  });
  return id;
}

export type TiktokStashLookup =
  | { ok: true; clientId: string; accessToken: string; advertiserIds: string[] }
  | { ok: false; reason: "expired" | "wrong_client" };

/**
 * Retrieve a stashed connection.
 *
 * `expectedClientId` is checked rather than trusted: the stash id travels
 * through a URL, and one minted for one client must not attach advertisers to
 * another.
 */
export function readTiktokStash(
  id: string,
  expectedClientId: string,
): TiktokStashLookup {
  prune();
  const found = stash.get(id);
  if (!found) return { ok: false, reason: "expired" };
  if (found.clientId !== expectedClientId) return { ok: false, reason: "wrong_client" };
  return {
    ok: true,
    clientId: found.clientId,
    accessToken: decrypt(found.tokenEncrypted),
    advertiserIds: found.advertiserIds,
  };
}

export function dropTiktokStash(id: string) {
  stash.delete(id);
}

/* ------------------------------------------------------------------ *
 * Discovery
 * ------------------------------------------------------------------ */

export interface DiscoveredTiktokAdvertiser {
  advertiserId: string;
  name: string | null;
  currency: string | null;
  timezone: string | null;
}

/**
 * Every advertiser this grant can reach, with the detail needed to choose.
 *
 * 🔴 **Two calls, not one, and both are required.**
 * `/oauth2/advertiser/get/` returns only `advertiser_id` and
 * `advertiser_name`; currency and timezone come from `/advertiser/info/`. A
 * picker built on the first call alone would show a list of names with no
 * currency — and since this product sums spend across accounts, and currencies
 * cannot be summed, that is a number nobody should trust.
 *
 * Simpler than the Google equivalent in one respect: there is no manager
 * hierarchy here, so no account has to be shown-but-disabled the way a Google
 * MCC does. Every advertiser returned is one that holds campaigns.
 */
export interface TiktokDiscovery {
  advertisers: DiscoveredTiktokAdvertiser[];
  /**
   * 🔴 True when `/advertiser/info/` failed, so every `currency` and `timezone`
   * below is null because we could not ASK — not because TikTok has none.
   *
   * Returned rather than merely logged, because the picker cannot tell those
   * apart and renders both as `?`. The header above spells out why currency
   * specifically matters: this product sums spend across accounts and
   * currencies cannot be summed, so an operator picking blind may attach a EUR
   * advertiser into a USD total. The attach step still catches that and warns
   * — but at that point they have already chosen, and the warning arrives as a
   * surprise rather than as information they had while deciding.
   *
   * `discoverGoogleAccounts` returns `partial` for exactly this reason; these
   * two flows are siblings and had drifted apart on it.
   */
  detailUnavailable: boolean;
}

export async function discoverTiktokAdvertisers(
  accessToken: string,
): Promise<TiktokDiscovery> {
  const appId = process.env.TIKTOK_APP_ID;
  const secret = process.env.TIKTOK_APP_SECRET;
  if (!appId || !secret) {
    throw new Error("TIKTOK_APP_ID / TIKTOK_APP_SECRET are not set.");
  }

  const client = new TiktokClient(accessToken);
  const listed = await client.listAdvertisers(appId, secret);
  if (listed.length === 0) return { advertisers: [], detailUnavailable: false };

  /*
   * Detail is best-effort. If `/advertiser/info/` fails we still show the
   * advertisers, just without currency and timezone — an operator who can see
   * the account they were looking for can proceed, whereas an empty list would
   * read as "the authorization did not work" and send them round consent again
   * for a fault that is not theirs.
   */
  let detail = new Map<string, TiktokAdvertiser>();
  let detailUnavailable = false;
  try {
    const rows = await client.getAdvertisers(listed.map((a) => a.advertiser_id));
    detail = new Map(rows.map((r) => [String(r.advertiser_id), r]));
  } catch (err) {
    console.error("[tiktok-connect] advertiser detail unavailable:", err);
    detailUnavailable = true;
  }

  const advertisers = listed
    .map((a) => {
      const id = String(a.advertiser_id);
      const d = detail.get(id);
      return {
        advertiserId: id,
        name: d?.advertiser_name ?? a.advertiser_name ?? null,
        currency: d?.currency ?? null,
        timezone: d?.timezone ?? null,
      };
    })
    .sort((a, b) =>
      (a.name ?? a.advertiserId).localeCompare(b.name ?? b.advertiserId),
    );

  return { advertisers, detailUnavailable };
}
