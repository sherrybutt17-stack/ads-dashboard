import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { clients, metaAdAccounts, type MetaAdAccount } from "@/db/schema";
import { encrypt, decryptNullable } from "@/lib/crypto";
import { MetaClient } from "./client";

/**
 * A client's Facebook ad accounts.
 *
 * A client can hold several — a practice running separate accounts per location,
 * an advertiser split across Business Managers — and the dashboard sums spend
 * and metrics across all of them. This module is the source of truth for which
 * accounts exist; `clients.metaCurrency` / `metaTimezone` are only a display
 * cache derived from the primary account.
 */

export async function listAdAccounts(
  clientId: string,
  { includeRemoved = false } = {},
): Promise<MetaAdAccount[]> {
  const rows = await db
    .select()
    .from(metaAdAccounts)
    .where(eq(metaAdAccounts.clientId, clientId))
    .orderBy(metaAdAccounts.createdAt);
  return includeRemoved ? rows : rows.filter((r) => r.status !== "removed");
}

/** Active accounts only — what the sync and dashboard actually read. */
export async function activeAdAccounts(
  clientId: string,
): Promise<MetaAdAccount[]> {
  return (await listAdAccounts(clientId)).filter((a) => a.status === "active");
}

/**
 * A Meta API client scoped to one ad account.
 *
 * Uses the account's own token override when present (for an account in a
 * different Business Manager), otherwise the shared system user token.
 */
export function metaClientForAccount(account: MetaAdAccount): MetaClient {
  const override = decryptNullable(account.tokenEncrypted);
  return new MetaClient(override ?? undefined);
}

export interface AddAccountResult {
  account: MetaAdAccount;
  /** Set when this account's currency differs from the client's primary. */
  currencyMismatch?: { primary: string; thisAccount: string };
  /** Set when its timezone differs from the client's primary. */
  timezoneMismatch?: { primary: string; thisAccount: string };
}

/**
 * Verify an ad account against the Meta API, then attach it to a client.
 *
 * Verify-then-store: a mistyped account id or a token that cannot reach it is
 * caught here, echoing back the real name/currency/timezone, rather than
 * surfacing later as silently missing spend.
 *
 * The first account added becomes primary and sets the client's display
 * currency and bucketing timezone. A later account whose currency or timezone
 * disagrees is still added, but the mismatch is returned so the UI can warn —
 * mixed currencies cannot be summed, and mixed timezones make "a day" ambiguous.
 */
export async function addAdAccount(
  clientId: string,
  rawAccountId: string,
  token?: string,
): Promise<AddAccountResult> {
  const adAccountId = rawAccountId.trim().replace(/^act_/i, "");
  if (!adAccountId) throw new Error("Ad account id is required");

  // Guard the global-uniqueness rule with a friendly message rather than a
  // raw constraint violation.
  const [clash] = await db
    .select({ clientId: metaAdAccounts.clientId })
    .from(metaAdAccounts)
    .where(eq(metaAdAccounts.adAccountId, adAccountId))
    .limit(1);
  if (clash && clash.clientId !== clientId) {
    throw new Error(
      "That ad account is already attached to a different client. An ad account can only belong to one client (otherwise its spend would be double-counted).",
    );
  }

  const meta = new MetaClient(token);
  const acct = await meta.getAdAccount(adAccountId);

  const existingActive = await activeAdAccounts(clientId);
  const primary = existingActive.find((a) => a.isPrimary) ?? existingActive[0];
  const isPrimary = !primary;

  const values = {
    clientId,
    adAccountId,
    tokenEncrypted: token ? encrypt(token) : null,
    accountName: acct.name ?? null,
    currency: acct.currency ?? null,
    timezone: acct.timezone_name ?? null,
    isPrimary,
    status: "active" as const,
    updatedAt: new Date(),
  };

  const [account] = await db
    .insert(metaAdAccounts)
    .values(values)
    .onConflictDoUpdate({
      target: metaAdAccounts.adAccountId,
      set: values,
    })
    .returning();

  // The primary account defines the client's display currency and timezone.
  if (isPrimary) {
    await db
      .update(clients)
      .set({
        metaCurrency: acct.currency ?? null,
        metaTimezone: acct.timezone_name ?? null,
        ...(acct.timezone_name ? { timezone: acct.timezone_name } : {}),
        updatedAt: new Date(),
      })
      .where(eq(clients.id, clientId));
  }

  const result: AddAccountResult = { account };
  if (primary) {
    if (primary.currency && acct.currency && primary.currency !== acct.currency) {
      result.currencyMismatch = {
        primary: primary.currency,
        thisAccount: acct.currency,
      };
    }
    if (
      primary.timezone &&
      acct.timezone_name &&
      primary.timezone !== acct.timezone_name
    ) {
      result.timezoneMismatch = {
        primary: primary.timezone,
        thisAccount: acct.timezone_name,
      };
    }
  }
  return result;
}

/**
 * Detach an account.
 *
 * Marked `removed` rather than deleted, so the metrics already pulled under it
 * stay in `fb_daily_metrics` and historical totals do not silently drop. If the
 * primary is removed, promote another active account so the client keeps a
 * display currency and timezone.
 */
export async function removeAdAccount(
  clientId: string,
  accountId: string,
): Promise<void> {
  const [account] = await db
    .update(metaAdAccounts)
    .set({ status: "removed", isPrimary: false, updatedAt: new Date() })
    .where(
      and(
        eq(metaAdAccounts.id, accountId),
        eq(metaAdAccounts.clientId, clientId),
      ),
    )
    .returning();
  if (!account) throw new Error("Account not found");

  if (account.isPrimary) {
    const [next] = await db
      .select()
      .from(metaAdAccounts)
      .where(
        and(
          eq(metaAdAccounts.clientId, clientId),
          eq(metaAdAccounts.status, "active"),
        ),
      )
      .limit(1);
    if (next) {
      await db
        .update(metaAdAccounts)
        .set({ isPrimary: true, updatedAt: new Date() })
        .where(eq(metaAdAccounts.id, next.id));
      await db
        .update(clients)
        .set({
          metaCurrency: next.currency,
          metaTimezone: next.timezone,
          ...(next.timezone ? { timezone: next.timezone } : {}),
          updatedAt: new Date(),
        })
        .where(eq(clients.id, clientId));
    }
  }
}
