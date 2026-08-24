import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { clients, googleAdAccounts, type GoogleAdAccount } from "@/db/schema";
import { encrypt, decryptNullable } from "@/lib/crypto";
import { agencyIdForClient } from "@/lib/tenancy";
import { googleRefreshTokenFor } from "@/lib/shared-credentials";
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
 * The same read, for surfaces that must RENDER rather than fail.
 *
 * 🔴 This table gains columns (`login_customer_id`, `is_manager` in migration
 * 0016), and Drizzle selects every column it knows about — so a deploy that
 * lands before its migration makes `SELECT *` throw `column does not exist`.
 * Inside the dashboard page's `Promise.all` that took the WHOLE page down:
 * a client with no Google account at all lost their Facebook dashboard because
 * of a column only the Google connect flow uses. Measured, not theorised —
 * `/c/gg-ads` returned its error boundary.
 *
 * Every other migration-dependent read on that page already degrades this way
 * (branding → defaults, layout → defaults, creatives → a contained error), and
 * this was the one that didn't.
 *
 * Deliberately NOT applied to `activeGoogleAccounts` itself. The sync and the
 * health check also read it, and there a silent `[]` is the worse failure: a
 * sync that finds no accounts does nothing and reports success, and a health
 * check that finds none says "no Google accounts configured" when the truth is
 * "we could not read them". Degrading is a decision per caller, so it is a
 * separate function that says so in its name.
 */
export async function activeGoogleAccountsForDisplay(
  clientId: string,
): Promise<{ accounts: GoogleAdAccount[]; error: string | null }> {
  try {
    return { accounts: await activeGoogleAccounts(clientId), error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[google] accounts unavailable, hiding the platform toggle:", message);
    return { accounts: [], error: message };
  }
}

/**
 * A Google Ads client scoped to one account. Uses the account's own refresh
 * token override when present (an account not under our MCC), otherwise the
 * agency default from env.
 */
/**
 * The API client for one stored account.
 *
 * 🔴 Passes the account's OWN `login_customer_id`. Before this, every call went
 * out with the agency MCC from env, which is correct only while every client
 * account is linked under our Manager account. The moment a client connects
 * their own Google account the header has to be theirs — and the failure is
 * silent: the request is well-formed and simply returns nothing for an account
 * that plainly has spend.
 *
 * `null` (the value every pre-existing row carries) still means "use the agency
 * MCC", so nothing that works today changes.
 */
export function googleClientForAccount(
  account: GoogleAdAccount,
  agencyId: string,
): GoogleAdsClient {
  const override = decryptNullable(account.refreshTokenEncrypted);
  return new GoogleAdsClient(
    googleRefreshTokenFor(agencyId, override),
    account.loginCustomerId,
  );
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
  /** The manager to reach this account through; `""` for none. See the schema. */
  loginCustomerId?: string | null,
): Promise<AddGoogleAccountResult> {
  const customerId = normalizeCustomerId(rawCustomerId);
  if (!customerId) throw new Error("Google Ads customer id is required");

  /*
   * Scoped to the caller's own agency, for the reason written out in full on
   * the equivalent check in `meta/accounts.ts`: an unscoped version is both a
   * squat (first typist owns the id forever) and a disclosure oracle (the
   * rejection confirms another tenant holds it). Within one agency the check is
   * still worth making — the same account on two clients double-counts its
   * spend in that agency's roll-up.
   */
  const agencyId = await agencyIdForClient(clientId);
  if (!agencyId) throw new Error("Unknown client");

  const [clash] = await db
    .select({ clientId: googleAdAccounts.clientId, name: clients.name })
    .from(googleAdAccounts)
    .innerJoin(clients, eq(clients.id, googleAdAccounts.clientId))
    .where(
      and(
        eq(googleAdAccounts.customerId, customerId),
        eq(clients.agencyId, agencyId),
      ),
    )
    .limit(1);
  if (clash && clash.clientId !== clientId) {
    throw new Error(
      `That Google Ads account is already attached to ${clash.name}. An account can only belong to one client (otherwise its spend would be double-counted).`,
    );
  }

  // Verified with the SAME header the sync will use, so a wrong manager id is
  // caught here rather than showing up later as an account that reports zero.
  const google = new GoogleAdsClient(
    googleRefreshTokenFor(agencyId, refreshTokenOverride),
    loginCustomerId,
  );
  const info = await google.getCustomer(customerId);

  const existingActive = await activeGoogleAccounts(clientId);
  const primary = existingActive.find((a) => a.isPrimary) ?? existingActive[0];
  const isPrimary = !primary;

  const values = {
    clientId,
    customerId,
    refreshTokenEncrypted: refreshTokenOverride ? encrypt(refreshTokenOverride) : null,
    loginCustomerId: loginCustomerId ?? null,
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
    // Matches the (client_id, customer_id) unique index — see the note on the
    // equivalent upsert in `meta/accounts.ts`.
    .onConflictDoUpdate({
      target: [googleAdAccounts.clientId, googleAdAccounts.customerId],
      set: values,
    })
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
  /*
   * 🔴 Read before update — same trap as `meta/accounts.ts`, same fix.
   *
   * `RETURNING` gives the row AFTER the update, and the update sets
   * `isPrimary: false`, so branching on the returned flag never fired and the
   * promotion below was dead code. See the longer note there.
   */
  const [existing] = await db
    .select()
    .from(googleAdAccounts)
    .where(
      and(eq(googleAdAccounts.id, accountId), eq(googleAdAccounts.clientId, clientId)),
    )
    .limit(1);
  if (!existing) throw new Error("Account not found");

  await db
    .update(googleAdAccounts)
    .set({ status: "removed", isPrimary: false, updatedAt: new Date() })
    .where(
      and(eq(googleAdAccounts.id, accountId), eq(googleAdAccounts.clientId, clientId)),
    );

  if (existing.isPrimary) {
    const [next] = await db
      .select()
      .from(googleAdAccounts)
      .where(
        and(
          eq(googleAdAccounts.clientId, clientId),
          eq(googleAdAccounts.status, "active"),
        ),
      )
      // Deterministic promotion; see the note in `meta/accounts.ts`.
      .orderBy(googleAdAccounts.createdAt)
      .limit(1);
    if (next) {
      await db
        .update(googleAdAccounts)
        .set({ isPrimary: true, updatedAt: new Date() })
        .where(eq(googleAdAccounts.id, next.id));
    }
  }
}
