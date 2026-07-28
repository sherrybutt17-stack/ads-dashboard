import { eq } from "drizzle-orm";
import { db } from "@/db";
import { ghlInstallations, type GhlInstallation } from "@/db/schema";
import { encrypt, decrypt } from "@/lib/crypto";
import { GhlClient } from "./client";

/**
 * GoHighLevel OAuth 2.0.
 *
 * Chosen over Private Integration Tokens because webhook subscriptions attach
 * to a marketplace app: the webhook URL is configured ONCE in app settings and
 * every installing sub-account then streams events automatically. A PIT has no
 * webhook capability at all, which is what forced per-client workflow building.
 *
 * The awkward part is token lifetime. Access tokens last ~24h and refresh
 * tokens are SINGLE-USE — each refresh returns a new refresh token and
 * invalidates the old one. Losing a refresh token means the client must
 * reinstall the app, so the write-back after refresh is not optional.
 */

const TOKEN_URL = "https://services.leadconnectorhq.com/oauth/token";
const AUTHORIZE_URL =
  "https://marketplace.gohighlevel.com/v2/oauth/chooselocation";

/**
 * Scopes requested at install.
 *
 * ⚠️ These LOCK PERMANENTLY once the marketplace app goes live — they can only
 * be edited while the app is in draft. Getting them wrong means publishing a
 * new app version and having every client reinstall, so err toward including a
 * scope you might need.
 */
export const GHL_SCOPES = [
  "opportunities.readonly",
  "contacts.readonly",
  "locations.readonly",
] as const;

export function isOauthConfigured(): boolean {
  return Boolean(process.env.GHL_CLIENT_ID && process.env.GHL_CLIENT_SECRET);
}

export function redirectUri(): string {
  const base =
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ??
    "http://localhost:3000";
  return `${base}/api/oauth/callback`;
}

/** Where to send an operator to install the app on a sub-account. */
export function buildAuthorizeUrl(state: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri());
  url.searchParams.set("client_id", process.env.GHL_CLIENT_ID!);
  // Space-separated, not comma.
  url.searchParams.set("scope", GHL_SCOPES.join(" "));
  url.searchParams.set("state", state);
  return url.toString();
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string;
  locationId?: string;
  companyId?: string;
  userType?: string;
  isBulkInstallation?: boolean;
}

async function postToken(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(body).toString(),
    cache: "no-store",
  });

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }

  if (!res.ok) {
    throw new Error(
      `GHL token exchange failed (${res.status}): ${
        typeof parsed === "string" ? parsed : JSON.stringify(parsed)
      }`,
    );
  }
  return parsed as TokenResponse;
}

/** Exchange the authorization code from the OAuth callback. */
export async function exchangeCode(code: string): Promise<GhlInstallation> {
  const token = await postToken({
    client_id: process.env.GHL_CLIENT_ID!,
    client_secret: process.env.GHL_CLIENT_SECRET!,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
  });

  if (!token.locationId) {
    /*
     * An agency-level (bulk) install returns a Company token with no
     * locationId. Supporting that properly means enumerating sub-accounts and
     * minting a location token for each — deliberately out of scope here, and
     * reported plainly rather than silently storing an unusable row.
     */
    throw new Error(
      "This install returned no locationId (agency-level install). Install the app on an individual sub-account instead.",
    );
  }

  return upsertInstallation(token);
}

async function upsertInstallation(
  token: TokenResponse,
): Promise<GhlInstallation> {
  // Refresh a minute early so a request in flight cannot land on a dead token.
  const expiresAt = new Date(Date.now() + (token.expires_in - 60) * 1000);

  let locationName: string | null = null;
  try {
    const client = new GhlClient(token.access_token);
    const loc = await client.getLocation(token.locationId!);
    locationName = loc.name ?? null;
  } catch {
    // Cosmetic only — never fail an install over a display name.
  }

  const values = {
    locationId: token.locationId!,
    companyId: token.companyId ?? null,
    userType: token.userType ?? null,
    accessTokenEncrypted: encrypt(token.access_token),
    refreshTokenEncrypted: encrypt(token.refresh_token),
    expiresAt,
    scopes: token.scope ?? null,
    locationName,
    lastRefreshedAt: new Date(),
    // A reinstall clears any previous uninstall marker.
    uninstalledAt: null,
    updatedAt: new Date(),
  };

  const [row] = await db
    .insert(ghlInstallations)
    .values(values)
    .onConflictDoUpdate({
      target: ghlInstallations.locationId,
      set: values,
    })
    .returning();

  return row;
}

/**
 * Return a valid access token for an installation, refreshing if needed.
 *
 * The write-back is the critical part: GHL's refresh tokens are single-use, so
 * if we obtain a new pair and fail to persist it, the old refresh token is
 * already dead and the client is locked out until they reinstall. Persist
 * first, return second.
 */
export async function getValidAccessToken(
  installation: GhlInstallation,
): Promise<string> {
  if (installation.expiresAt.getTime() > Date.now()) {
    return decrypt(installation.accessTokenEncrypted);
  }

  const token = await postToken({
    client_id: process.env.GHL_CLIENT_ID!,
    client_secret: process.env.GHL_CLIENT_SECRET!,
    grant_type: "refresh_token",
    refresh_token: decrypt(installation.refreshTokenEncrypted),
  });

  const expiresAt = new Date(Date.now() + (token.expires_in - 60) * 1000);
  await db
    .update(ghlInstallations)
    .set({
      accessTokenEncrypted: encrypt(token.access_token),
      refreshTokenEncrypted: encrypt(token.refresh_token),
      expiresAt,
      lastRefreshedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(ghlInstallations.id, installation.id));

  return token.access_token;
}

export async function getInstallationByLocation(
  locationId: string,
): Promise<GhlInstallation | null> {
  const [row] = await db
    .select()
    .from(ghlInstallations)
    .where(eq(ghlInstallations.locationId, locationId))
    .limit(1);
  return row ?? null;
}

export async function getInstallationForClient(
  clientId: string,
): Promise<GhlInstallation | null> {
  const [row] = await db
    .select()
    .from(ghlInstallations)
    .where(eq(ghlInstallations.clientId, clientId))
    .limit(1);
  return row ?? null;
}

/** Bind an install to a client, and vice versa. */
export async function claimInstallation(
  installationId: string,
  clientId: string,
): Promise<void> {
  const [installation] = await db
    .update(ghlInstallations)
    .set({ clientId, updatedAt: new Date() })
    .where(eq(ghlInstallations.id, installationId))
    .returning();

  if (!installation) throw new Error("Installation not found");

  const { clients } = await import("@/db/schema");
  await db
    .update(clients)
    .set({
      ghlLocationId: installation.locationId,
      ghlLocationName: installation.locationName,
      ghlAuthMethod: "oauth",
      updatedAt: new Date(),
    })
    .where(eq(clients.id, clientId));
}

export async function markUninstalled(locationId: string): Promise<void> {
  await db
    .update(ghlInstallations)
    .set({ uninstalledAt: new Date(), updatedAt: new Date() })
    .where(eq(ghlInstallations.locationId, locationId));
}

/** Installs not yet bound to a client — surfaced in the UI to be claimed. */
export async function listUnclaimedInstallations(): Promise<GhlInstallation[]> {
  const rows = await db.select().from(ghlInstallations);
  return rows.filter((r) => !r.clientId && !r.uninstalledAt);
}
