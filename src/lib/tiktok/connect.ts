import {
  putConnectStash,
  readConnectStash,
  dropConnectStash,
} from "@/lib/connect-stash";
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
 * The stash itself lives in `lib/connect-stash.ts`, shared with the Meta and
 * Google flows: see there for why it is a table rather than the in-process Map
 * it started as, and why the tenant check must not exist in three copies.
 */

export type TiktokStashLookup =
  | { ok: true; clientId: string; accessToken: string; advertiserIds: string[] }
  | { ok: false; reason: "expired" | "wrong_client" };

export async function stashTiktokConnection(
  clientId: string,
  accessToken: string,
  advertiserIds: string[],
): Promise<string> {
  /*
   * The advertiser ids ride along as the stash payload. They are a CROSS-CHECK
   * and not the answer: discovery re-queries TikTok, and that result wins. A
   * grant can be widened or narrowed between consent and the pick, and the list
   * captured at exchange time would quietly be the stale one.
   */
  return await putConnectStash("tiktok", clientId, accessToken, {
    payload: { advertiserIds },
  });
}

/**
 * The advertiser ids as they come back out of jsonb.
 *
 * 🔴 Checked rather than cast. `payload` is shapeless by design, so the adapter
 * is the only place that knows what should be in it — and a cast here would
 * turn a malformed row into a crash much further downstream, in the picker,
 * where it would read as TikTok returning nothing.
 */
function advertiserIdsFrom(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const ids = (payload as { advertiserIds?: unknown }).advertiserIds;
  if (!Array.isArray(ids)) return [];
  return ids.filter((v): v is string => typeof v === "string");
}

export async function readTiktokStash(
  id: string,
  expectedClientId: string,
): Promise<TiktokStashLookup> {
  const found = await readConnectStash("tiktok", id, expectedClientId);
  if (!found.ok) return found;
  return {
    ok: true,
    clientId: found.clientId,
    accessToken: found.token,
    advertiserIds: advertiserIdsFrom(found.payload),
  };
}

export async function dropTiktokStash(id: string): Promise<void> {
  await dropConnectStash("tiktok", id);
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
