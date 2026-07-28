import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { clients, googleAdAccounts, type GoogleAdAccount } from "@/db/schema";
import { encrypt, decryptNullable } from "@/lib/crypto";
import { GoogleAdsClient, normalizeCustomerId } from "./client";

/**
 * A client's Google Ads customer accounts — the direct mirror of the Meta
 * accounts module. A client can hold several; the dashboard sums spend across
 * all of them.
 */

export async function listGoogleAccounts(
  clientId: string,
  { includeRemoved = false } = {},
): Promise<GoogleAdAccount[]> {
  const rows = await db
    .select()
    .from(googleAdAccounts)
    .where(eq(googleAdAccounts.clientId, clientId))
    .orderBy(googleAdAccounts.createdAt);
  return includeRemoved ? rows : rows.filter((r) => r.status !== "removed");
}

/** Active accounts only — what the sync and dashboard actually read. */
export async function activeGoogleAccounts(
  clientId: string,
): Promise<GoogleAdAccount[]> {
  return (await listGoogleAccounts(clientId)).filter((a) => a.status === "active");
}

/**
 * A Google Ads client scoped to one account. Uses the account's own refresh
 * token override when present (an account not under our MCC), otherwise the
 * agency default from env.
 */
export function googleClientForAccount(account: GoogleAdAccount): GoogleAdsClient {
  const override = decryptNullable(account.refreshTokenEncrypted);
  return new GoogleAdsClient(override ?? undefined);
}

export interface AddGoogleAccountResult {
  account: GoogleAdAccount;
  currencyMismatch?: { primary: string; thisAccount: string };
  timezoneMismatch?: { primary: string; thisAccount: string };
}

/**
 * Verify a Google Ads customer id against the API, then attach it to a client.
 *
 * Verify-then-store, exactly like the Meta flow: a mistyped id or an account not
 * linked to our MCC is caught here (the `getCustomer` call fails), rather than
 * surfacing later as silently missing spend. Echoes back the real
 * name/currency/timezone.
 */
export async function addGoogleAccount(
  clientId: string,
  rawCustomerId: string,
  refreshTokenOverride?: string,
): Promise<AddGoogleAccountResult> {
  const customerId = normalizeCustomerId(rawCustomerId);
  if (!customerId) throw new Error("Google Ads customer id is required");

  const [clash] = await db
    .select({ clientId: googleAdAccounts.clientId })
    .from(googleAdAccounts)
    .where(eq(googleAdAccounts.customerId, customerId))
    .limit(1);
  if (clash && clash.clientId !== clientId) {
    throw new Error(
      "That Google Ads account is already attached to a different client. An account can only belong to one client (otherwise its spend would be double-counted).",
    );
  }

  const google = new GoogleAdsClient(refreshTokenOverride);
  const info = await google.getCustomer(customerId);

  const existingActive = await activeGoogleAccounts(clientId);
  const primary = existingActive.find((a) => a.isPrimary) ?? existingActive[0];
  const isPrimary = !primary;

  const values = {
    clientId,
    customerId,
    refreshTokenEncrypted: refreshTokenOverride ? encrypt(refreshTokenOverride) : null,
    accountName: info.descriptiveName ?? null,
    currency: info.currencyCode ?? null,
    timezone: info.timeZone ?? null,
    isPrimary,
    status: "active" as const,
    updatedAt: new Date(),
  };

  const [account] = await db
    .insert(googleAdAccounts)
    .values(values)
    .onConflictDoUpdate({ target: googleAdAccounts.customerId, set: values })
    .returning();

  // Only set the client's display currency/timezone if Meta has not already —
  // a client's primary bucketing timezone should come from whichever ad platform
  // was connected first, and we must not clobber Meta's.
  if (isPrimary) {
    const [client] = await db
      .select({ metaCurrency: clients.metaCurrency })
      .from(clients)
      .where(eq(clients.id, clientId));
    if (!client?.metaCurrency) {
      await db
        .update(clients)
        .set({
          metaCurrency: info.currencyCode ?? null,
          metaTimezone: info.timeZone ?? null,
          ...(info.timeZone ? { timezone: info.timeZone } : {}),
          updatedAt: new Date(),
        })
        .where(eq(clients.id, clientId));
    }
  }

  const result: AddGoogleAccountResult = { account };
  if (primary) {
    if (primary.currency && info.currencyCode && primary.currency !== info.currencyCode) {
      result.currencyMismatch = { primary: primary.currency, thisAccount: info.currencyCode };
    }
    if (primary.timezone && info.timeZone && primary.timezone !== info.timeZone) {
      result.timezoneMismatch = { primary: primary.timezone, thisAccount: info.timeZone };
    }
  }
  return result;
}

/** Detach an account — marked `removed`, never deleted, so historical spend stays. */
export async function removeGoogleAccount(
  clientId: string,
  accountId: string,
): Promise<void> {
  const [account] = await db
    .update(googleAdAccounts)
    .set({ status: "removed", isPrimary: false, updatedAt: new Date() })
    .where(
      and(eq(googleAdAccounts.id, accountId), eq(googleAdAccounts.clientId, clientId)),
    )
    .returning();
  if (!account) throw new Error("Account not found");

  if (account.isPrimary) {
    const [next] = await db
      .select()
      .from(googleAdAccounts)
      .where(
        and(
          eq(googleAdAccounts.clientId, clientId),
          eq(googleAdAccounts.status, "active"),
        ),
      )
      .limit(1);
    if (next) {
      await db
        .update(googleAdAccounts)
        .set({ isPrimary: true, updatedAt: new Date() })
        .where(eq(googleAdAccounts.id, next.id));
    }
  }
}
