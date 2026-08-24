import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { clients, metaAdAccounts, type MetaAdAccount } from "@/db/schema";
import { encrypt, decryptNullable } from "@/lib/crypto";
import { agencyIdForClient } from "@/lib/tenancy";
import { metaTokenFor } from "@/lib/shared-credentials";
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
 * different Business Manager). Falling back to the shared system-user token is
 * now a tenancy decision rather than a default — see `shared-credentials.ts`,
 * which is why `agencyId` is required here and cannot be inferred from the
 * account row.
 */
export function metaClientForAccount(
  account: MetaAdAccount,
  agencyId: string,
): MetaClient {
  const override = decryptNullable(account.tokenEncrypted);
  return new MetaClient(metaTokenFor(agencyId, override));
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
  /**
   * When `token` dies. Undefined/null means it does not — which is true of the
   * system user token and of a pasted permanent token, and false of anything
   * that came out of "Continue with Facebook". Stored so the health checklist
   * can warn before a ~60-day user token takes the client's spend offline.
   */
  tokenExpiresAt?: Date | null,
): Promise<AddAccountResult> {
  const adAccountId = rawAccountId.trim().replace(/^act_/i, "");
  if (!adAccountId) throw new Error("Ad account id is required");

  /*
   * 🔴 Scoped to the caller's own agency. This query used to look across the
   * whole table, which made it a disclosure oracle: type an ad account id, and
   * "already attached to a different client" told you a stranger's tenant holds
   * it. Combined with the global unique index it also handed permanent
   * ownership to whoever typed an id first, locking out the real owner.
   *
   * Within one agency the check still earns its place — the same account on two
   * of an agency's clients double-counts its spend in their roll-up, and a
   * named message is far better than a raw constraint violation. Across
   * agencies there is nothing to say and nothing worth confirming.
   */
  const agencyId = await agencyIdForClient(clientId);
  if (!agencyId) throw new Error("Unknown client");

  const [clash] = await db
    .select({ clientId: metaAdAccounts.clientId, name: clients.name })
    .from(metaAdAccounts)
    .innerJoin(clients, eq(clients.id, metaAdAccounts.clientId))
    .where(
      and(
        eq(metaAdAccounts.adAccountId, adAccountId),
        eq(clients.agencyId, agencyId),
      ),
    )
    .limit(1);
  if (clash && clash.clientId !== clientId) {
    throw new Error(
      `That ad account is already attached to ${clash.name}. An ad account can only belong to one client (otherwise its spend would be double-counted).`,
    );
  }

  const meta = new MetaClient(metaTokenFor(agencyId, token));
  const acct = await meta.getAdAccount(adAccountId);

  const existingActive = await activeAdAccounts(clientId);
  const primary = existingActive.find((a) => a.isPrimary) ?? existingActive[0];
  const isPrimary = !primary;

  const values = {
    clientId,
    adAccountId,
    tokenEncrypted: token ? encrypt(token) : null,
    // Only meaningful alongside a token; clearing the token clears the expiry
    // so a stale date cannot outlive the credential it described.
    tokenExpiresAt: token ? (tokenExpiresAt ?? null) : null,
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
      /*
       * 🔴 Must name the SAME columns as the unique index, which is now
       * (client_id, …) rather than the account id alone — Postgres rejects an
       * ON CONFLICT target with no matching constraint, so leaving this on the
       * old single column would fail every re-add at runtime while compiling
       * perfectly. Changed with the index in Phase 1's un-squat.
       */
      target: [metaAdAccounts.clientId, metaAdAccounts.adAccountId],
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
  /*
   * 🔴 Read the row BEFORE the update, not out of `RETURNING`.
   *
   * This used to be one statement: set `isPrimary: false` and branch on the
   * returned row's `isPrimary`. Postgres `RETURNING` yields the row as it is
   * AFTER the update, so that flag was always false and the promotion below was
   * dead code — removing a client's primary ad account left them with no
   * primary at all, still displaying the currency and timezone of an account
   * they no longer had. It typechecked, it never threw, and the only symptom
   * was a stale currency symbol.
   *
   * The scoped WHERE stays the authorization on both statements: an account id
   * belonging to another client is "not found" rather than removed, so the id
   * alone is never the permission.
   */
  const [existing] = await db
    .select()
    .from(metaAdAccounts)
    .where(
      and(
        eq(metaAdAccounts.id, accountId),
        eq(metaAdAccounts.clientId, clientId),
      ),
    )
    .limit(1);
  if (!existing) throw new Error("Account not found");

  await db
    .update(metaAdAccounts)
    .set({ status: "removed", isPrimary: false, updatedAt: new Date() })
    .where(
      and(
        eq(metaAdAccounts.id, accountId),
        eq(metaAdAccounts.clientId, clientId),
      ),
    );

  if (existing.isPrimary) {
    const [next] = await db
      .select()
      .from(metaAdAccounts)
      .where(
        and(
          eq(metaAdAccounts.clientId, clientId),
          eq(metaAdAccounts.status, "active"),
        ),
      )
      // Oldest first, so the promotion is deterministic. Without an ORDER BY
      // the winner is whatever Postgres hands back, which can differ between a
      // test and production and makes "which account is primary" unanswerable.
      .orderBy(metaAdAccounts.createdAt)
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
