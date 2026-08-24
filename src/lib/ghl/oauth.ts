import { eq } from "drizzle-orm";
import { db } from "@/db";
import { ghlInstallations, type GhlInstallation, type Client } from "@/db/schema";
import { encrypt, decrypt } from "@/lib/crypto";
import { agencyIdForClient } from "@/lib/tenancy";
import { GhlClient } from "./client";
import { appBaseUrlOr } from "@/lib/app-url";

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
  const base = appBaseUrlOr("http://localhost:3000");
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
export async function exchangeCode(
  code: string,
  intendedClientId: string | null,
): Promise<GhlInstallation> {
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

  return upsertInstallation(token, intendedClientId);
}

async function upsertInstallation(
  token: TokenResponse,
  /**
   * The client this install is being performed FOR, from the signed OAuth
   * state — null for an agency-level install with no target.
   */
  intendedClientId: string | null,
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

  /*
   * 🔴 A reinstall must not deliver fresh tokens into somebody else's row.
   *
   * `values` deliberately omits `clientId`, so an upsert PRESERVES whatever
   * client the row was already bound to. That is right for the ordinary case —
   * the same client reinstalling after a scope change should not have to
   * re-claim. It is wrong the moment a sub-account moves between agencies:
   * agency B reinstalls, and B's working access and refresh tokens land in a
   * row still pointing at agency A's client, which then reads B's contacts and
   * pipeline through them.
   *
   * So the binding is cleared whenever the install names a DIFFERENT client
   * than the row holds. `claimInstallation` below then re-binds it, with the
   * authorization this function has no way to perform.
   */
  const existing = await getInstallationByLocation(token.locationId!);
  const rebinding =
    intendedClientId !== null &&
    existing?.clientId != null &&
    existing.clientId !== intendedClientId;

  const [row] = await db
    .insert(ghlInstallations)
    .values(values)
    .onConflictDoUpdate({
      target: ghlInstallations.locationId,
      set: rebinding ? { ...values, clientId: null } : values,
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

/**
 * Bind an install to a client, and vice versa.
 *
 * ── What was wrong with this ─────────────────────────────────────────────
 *
 * 🔴 It took `(installationId, clientId)` and did as it was told. No check that
 * the caller was entitled to either, and no check that the install was already
 * claimed — so it would silently re-point any installation at any client. A
 * sub-account's tokens, contacts and stage transitions could be moved to
 * another tenant by supplying two ids.
 *
 * Two changes close it:
 *
 *  1. **It takes a `Client`, not a client id.** The caller cannot pass an id it
 *     never loaded, and every route that loads one now does so through
 *     `requireClient` / `getClientForSession`. Authorization moves to the one
 *     place that can actually perform it, and this function stops pretending
 *     an id is a permission.
 *  2. **An already-claimed install may only move WITHIN an agency.** Moving a
 *     sub-account between an agency's own clients is ordinary housekeeping.
 *     Moving it across a tenant boundary is the attack, and there is no
 *     legitimate flow that needs it — a genuine handover goes through an
 *     uninstall and a fresh install by the new owner.
 */
export async function claimInstallation(
  installationId: string,
  client: Client,
): Promise<void> {
  const [existing] = await db
    .select()
    .from(ghlInstallations)
    .where(eq(ghlInstallations.id, installationId))
    .limit(1);
  if (!existing) throw new Error("Installation not found");

  if (existing.clientId && existing.clientId !== client.id) {
    const holder = await agencyIdForClient(existing.clientId);
    if (holder !== client.agencyId) {
      /*
       * Deliberately says nothing about who holds it. The caller has just
       * demonstrated they do not own this install; confirming which tenant does
       * would turn a failed claim into a lookup service.
       */
      throw new Error(
        "That GoHighLevel sub-account is already connected elsewhere. Disconnect it there first.",
      );
    }
  }

  const [installation] = await db
    .update(ghlInstallations)
    .set({ clientId: client.id, updatedAt: new Date() })
    .where(eq(ghlInstallations.id, installationId))
    .returning();
  if (!installation) throw new Error("Installation not found");

  const { clients } = await import("@/db/schema");
  await db
    .update(clients)
    .set({
      /*
       * The ONLY writer of `ghlLocationId` that can be trusted, because the
       * value comes out of a completed OAuth exchange rather than out of a form
       * field. See the note on the column.
       */
      ghlLocationId: installation.locationId,
      ghlLocationName: installation.locationName,
      ghlAuthMethod: "oauth",
      updatedAt: new Date(),
    })
    .where(eq(clients.id, client.id));
}

/**
 * Mark an install dead by location id.
 *
 * ⚠️ Location-keyed, and therefore only safe when GHL itself is the one saying
 * so — i.e. the uninstall webhook, whose payload names the location. Do NOT
 * call this from a user-initiated path: `clients.ghlLocationId` can be typed
 * into a form, so "delete my client" would let one tenant kill another tenant's
 * live connection by having entered their location id. That path uses
 * `markUninstalledForClient` instead.
 */
export async function markUninstalled(locationId: string): Promise<void> {
  await db
    .update(ghlInstallations)
    .set({ uninstalledAt: new Date(), updatedAt: new Date() })
    .where(eq(ghlInstallations.locationId, locationId));
}

/**
 * Mark this CLIENT's install dead, whatever location it points at.
 *
 * Keyed on the binding rather than on a location string, so it can only ever
 * touch a row that was actually claimed by this client.
 */
export async function markUninstalledForClient(clientId: string): Promise<void> {
  await db
    .update(ghlInstallations)
    .set({ uninstalledAt: new Date(), updatedAt: new Date() })
    .where(eq(ghlInstallations.clientId, clientId));
}

/** Installs not yet bound to a client — surfaced in the UI to be claimed. */
export async function listUnclaimedInstallations(): Promise<GhlInstallation[]> {
  const rows = await db.select().from(ghlInstallations);
  return rows.filter((r) => !r.clientId && !r.uninstalledAt);
}

/**
 * Refuse a location id that belongs to somebody else's live install.
 *
 * ── Why this exists at all ───────────────────────────────────────────────
 *
 * `clients.ghlLocationId` cannot simply be made non-writable: the Private
 * Integration Token path has no OAuth exchange to learn it from, so an operator
 * genuinely types it in. That leaves the field as caller input, and caller
 * input naming another tenant's sub-account is the squat — the marketplace
 * callback no longer auto-binds on it (see the GHL callback route), but a typed
 * id still steers webhook routing and every "which client is this location"
 * lookup.
 *
 * So the value is validated instead of forbidden. It is only dangerous when it
 * collides with a live install owned by a different agency; within an agency it
 * is ordinary configuration, and against no install at all it is a client being
 * set up ahead of its connection.
 *
 * 🔴 The rejection names nothing. Saying "that belongs to Acme Dental" would
 * turn this validation into the lookup service it exists to prevent.
 */
export async function assertLocationIdAvailable(
  agencyId: string,
  locationId: string,
  /** The client being edited, so re-saving its own value is not a clash. */
  clientId?: string,
): Promise<void> {
  const existing = await getInstallationByLocation(locationId);
  if (!existing || existing.uninstalledAt || !existing.clientId) return;
  if (existing.clientId === clientId) return;

  const holder = await agencyIdForClient(existing.clientId);
  if (holder && holder !== agencyId) {
    throw new Error(
      "That GoHighLevel location is already connected elsewhere. Disconnect it there first.",
    );
  }
}
