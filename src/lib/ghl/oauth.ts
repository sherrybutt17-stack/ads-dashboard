import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { ghlInstallations, webhookEvents, type GhlInstallation, type Client } from "@/db/schema";
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
const LOCATION_TOKEN_URL = "https://services.leadconnectorhq.com/oauth/locationToken";
const INSTALLED_LOCATIONS_URL = "https://services.leadconnectorhq.com/oauth/installedLocations";
const AUTHORIZE_URL =
  "https://marketplace.gohighlevel.com/v2/oauth/chooselocation";
/** The API version the two agency calls are documented under. */
const API_VERSION = "2021-07-28";
/**
 * Sub-accounts one agency install connects at most: a "select all" on a large
 * agency must not run the callback past its time. The rest can be connected
 * from their clients' setup pages.
 */
const AGENCY_INSTALL_MAX_LOCATIONS = 50;
/**
 * How long an agency install waits for GHL to finish installing on the
 * sub-account just ticked, and how often it looks. GHL redirects back before
 * it has (see `installFromAgencyToken`), so the callback waits for its INSTALL
 * notification — usually under a second, the whole wait only when none comes.
 */
const TICKED_WAIT_MS = 10_000;
const TICKED_POLL_MS = 1_000;

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
  /** An agency-level install: the sub-accounts it was approved for. */
  approvedLocations?: string[];
}

async function postToken(body: Record<string, string>): Promise<TokenResponse> {
  return postForm(TOKEN_URL, body, {}, "GHL token exchange");
}

/** A form POST to GHL's OAuth service, answered with JSON — or an error naming what failed. */
async function postForm(
  url: string,
  body: Record<string, string>,
  headers: Record<string, string>,
  what: string,
): Promise<TokenResponse> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      ...headers,
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
      `${what} failed (${res.status}): ${
        typeof parsed === "string" ? parsed : JSON.stringify(parsed)
      }`,
    );
  }
  return parsed as TokenResponse;
}

/** One sub-account an install covers. */
export interface InstalledSubAccount {
  installation: GhlInstallation;
  /** No row held it before this install, or only an uninstalled one: freshly installed, by our records. */
  isNew: boolean;
  /**
   * GHL says this is the sub-account installed now: a sub-account install's
   * own token, or an agency install's signed INSTALL notification. The one
   * positive sign of what was ticked; everything else is inference.
   */
  justInstalled: boolean;
}

export interface ExchangeOptions {
  /** How long an agency install waits for the ticked sub-account (ms). */
  waitMs?: number;
  pollMs?: number;
}

/**
 * Exchange the authorization code from the OAuth callback: every sub-account
 * the install covers, one installation each. Never moves a sub-account
 * between clients of one agency (`upsertInstallation`, `installFor`).
 */
export async function exchangeCode(
  code: string,
  intendedClientId: string | null,
  opts: ExchangeOptions = {},
): Promise<InstalledSubAccount[]> {
  const token = await postToken({
    client_id: process.env.GHL_CLIENT_ID!,
    client_secret: process.env.GHL_CLIENT_SECRET!,
    grant_type: "authorization_code",
    code,
    /*
     * 🔴 Without this GHL answers with a Company token — no locationId — even
     * for a single sub-account install (`installType: "Location"` on the
     * INSTALL webhook).
     */
    user_type: "Location",
    redirect_uri: redirectUri(),
  });

  // A sub-account install: GHL names the one sub-account installed.
  if (token.locationId) return [{ ...(await upsertInstallation(token, intendedClientId)), justInstalled: true }];
  return installFromAgencyToken(token, intendedClientId !== null, opts);
}

/**
 * An agency-level install, made into sub-account ones.
 *
 * 🔴 GHL's install screen makes one even when a single sub-account is ticked.
 * Every new marketplace app is bulk-installable, so the screen is a
 * multi-select, and the code it hands back is the agency's: a Company token
 * with no locationId, whatever `user_type` asks for. Refusing it refused every
 * install made from the agency (Aloha Laser Vision, 26 Oct 2026: installed in
 * GHL, "agency-level install" here).
 *
 * GHL's documented path: the agency token names the sub-accounts it was
 * approved for (`approvedLocations`), and `oauth/locationToken` turns it into
 * each one's own Location token with its own refresh token — so everything
 * downstream stays per sub-account, exactly as for a direct install. Needs the
 * app's `oauth.write` (and `oauth.readonly` for the fallback list).
 *
 * 🔴 The token lists every sub-account the app is approved on in that
 * agency, not only the ones just ticked (King LASIK, linked since 22 Oct,
 * came back with Aloha Laser Vision). So nothing here changes which client
 * any sub-account belongs to: `installFor` picks the client's one.
 *
 * 🔴 And GHL redirects back BEFORE it has finished installing on the
 * sub-account just ticked. 26 Oct 2026: our exchange at 17:45:49.26, GHL's
 * INSTALL for Aloha at 17:45:49.44 — so the token came back naming King LASIK
 * alone, and an earlier rule ("one sub-account came back: it is the one")
 * moved King LASIK onto Aloha's client. So when the install was started for a
 * client, this waits for GHL's signed INSTALL notification of the ticked
 * sub-account (its webhook lands in `webhook_events`), mints that one too, and
 * marks it `justInstalled` — what GHL says was installed, not what we guess.
 */
async function installFromAgencyToken(
  token: TokenResponse,
  waitForTicked: boolean,
  opts: ExchangeOptions,
): Promise<InstalledSubAccount[]> {
  const companyId = token.companyId;
  if (!companyId) {
    throw new Error("GHL returned neither a sub-account nor an agency for this install.");
  }
  let locations = [
    ...new Set((token.approvedLocations ?? []).filter((l): l is string => typeof l === "string" && l !== "")),
  ];
  if (locations.length === 0) locations = await installedLocations(token.access_token, companyId);

  const out = new Map<string, InstalledSubAccount>();
  let firstError: unknown = null;
  /** One sub-account's own token pair from the agency's. Bindings untouched: the token chose no client. */
  const mint = async (locationId: string) => {
    if (out.has(locationId) || out.size >= AGENCY_INSTALL_MAX_LOCATIONS) return;
    try {
      const loc = await postForm(
        LOCATION_TOKEN_URL,
        { companyId, locationId },
        { Version: API_VERSION, Authorization: `Bearer ${token.access_token}` },
        "GHL sub-account token",
      );
      if (!loc.access_token || !loc.refresh_token) {
        throw new Error("GHL returned no usable token for a sub-account of this install.");
      }
      const sub = await upsertInstallation(
        { ...loc, locationId: loc.locationId ?? locationId, companyId: loc.companyId ?? companyId, userType: "Location" },
        null,
      );
      out.set(locationId, { ...sub, justInstalled: false });
    } catch (err) {
      // One sub-account refused must not cost the others theirs — and one not
      // installed yet is tried again below.
      firstError ??= err;
    }
  };
  for (const locationId of locations) await mint(locationId);

  if (waitForTicked) {
    const deadline = Date.now() + (opts.waitMs ?? TICKED_WAIT_MS);
    for (;;) {
      const ticked = await recentInstalls(companyId);
      for (const locationId of ticked) await mint(locationId);
      for (const locationId of ticked) {
        const sub = out.get(locationId);
        if (sub) sub.justInstalled = true;
      }
      if (ticked.some((l) => out.has(l)) || Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, opts.pollMs ?? TICKED_POLL_MS));
    }
  }

  if (out.size === 0) {
    throw firstError ?? new Error("This install named no sub-account. Install the app on a sub-account, then try again.");
  }
  return [...out.values()];
}

/**
 * Sub-accounts GHL has just told us it installed the app on, in one agency:
 * its INSTALL notifications of the last two minutes, signature-verified — a
 * forged one cannot steer which sub-account a client gets.
 */
async function recentInstalls(companyId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ locationId: sql<string>`${webhookEvents.payload}->>'locationId'` })
    .from(webhookEvents)
    .where(
      and(
        sql`${webhookEvents.receivedAt} > now() - interval '2 minutes'`,
        sql`${webhookEvents.payload}->>'type' IN ('INSTALL', 'AppInstall')`,
        sql`${webhookEvents.payload}->>'companyId' = ${companyId}`,
        sql`${webhookEvents.headers}->>'__signature' = 'valid'`,
        sql`coalesce(${webhookEvents.payload}->>'locationId', '') <> ''`,
      ),
    );
  return rows.map((r) => r.locationId);
}

/**
 * The sub-accounts this app is installed on in one agency — for an agency
 * install that names none (everything approved). A fallback only: a failure
 * here is an empty list, and the caller says so.
 */
async function installedLocations(agencyToken: string, companyId: string): Promise<string[]> {
  // The parent app id: a version's client id is `<app id>-<suffix>`.
  const appId = (process.env.GHL_CLIENT_ID ?? "").split("-")[0];
  const url = new URL(INSTALLED_LOCATIONS_URL);
  url.searchParams.set("companyId", companyId);
  url.searchParams.set("appId", appId);
  url.searchParams.set("isInstalled", "true");
  url.searchParams.set("limit", String(AGENCY_INSTALL_MAX_LOCATIONS));
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", Version: API_VERSION, Authorization: `Bearer ${agencyToken}` },
      cache: "no-store",
    });
    if (!res.ok) return [];
    const body = (await res.json()) as {
      locations?: Array<{ _id?: unknown; isInstalled?: unknown }>;
      items?: Array<{ _id?: unknown; isInstalled?: unknown }>;
    };
    return (body.locations ?? body.items ?? [])
      .filter((l) => l.isInstalled !== false && typeof l._id === "string" && l._id !== "")
      .map((l) => l._id as string);
  } catch {
    return [];
  }
}

async function upsertInstallation(
  token: TokenResponse,
  /**
   * The client this install is being performed FOR, from the signed OAuth
   * state — null for an agency-level install with no target.
   */
  intendedClientId: string | null,
): Promise<Omit<InstalledSubAccount, "justInstalled">> {
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
   * So the binding is cleared when the install names a client of ANOTHER
   * agency than the one holding the row. `claimInstallation` below then
   * re-binds it, with the authorization this function has no way to perform.
   *
   * 🔴 Within one agency the binding stays. A sub-account does not move from
   * one of an agency's clients to another because an install named it — on 26
   * Oct 2026 an install for Aloha Laser Vision moved King LASIK onto Aloha's
   * client that way. The callback refuses instead (`pickInstall`).
   */
  const existing = await getInstallationByLocation(token.locationId!);
  const rebinding =
    intendedClientId !== null &&
    existing?.clientId != null &&
    existing.clientId !== intendedClientId &&
    (await otherAgency(existing.clientId, intendedClientId));

  const [row] = await db
    .insert(ghlInstallations)
    .values(values)
    .onConflictDoUpdate({
      target: ghlInstallations.locationId,
      set: rebinding ? { ...values, clientId: null } : values,
    })
    .returning();

  return { installation: row, isNew: existing === null || existing.uninstalledAt !== null };
}

/** Whether two clients belong to different agencies — an unresolvable one counts as different. */
async function otherAgency(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([agencyIdForClient(a), agencyIdForClient(b)]);
  return x === null || x !== y;
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
    // Same as the exchange: a refresh must not trade a location token for a
    // Company one that the location-scoped reads cannot use.
    user_type: "Location",
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
 * Which sub-account of an install is the client it was started for — or null.
 *
 * 🔴 Never one another client holds. A sub-account changes client by being
 * disconnected first, never because a token named it: GHL's agency token
 * names every sub-account the app is on in the agency, and once named only
 * King LASIK (linked to its own client) for an install meant for Aloha Laser
 * Vision. That moved it — 26 Oct 2026.
 *
 * 1. What GHL says was installed now (`justInstalled`) decides alone, when it
 *    says anything: the one such sub-account free for this client, or null.
 * 2. Else, by our records: the one freshly installed and unclaimed;
 * 3. else the one already this client's — a reconnect;
 * 4. else the one no client holds yet.
 *
 * Anything else would be a guess, and an install bound to the wrong client
 * reads another business's CRM: null, and nothing is bound.
 */
export function installFor(clientId: string, subs: readonly InstalledSubAccount[]): GhlInstallation | null {
  const free = (s: InstalledSubAccount) =>
    s.installation.clientId === null || s.installation.clientId === clientId;
  const one = (list: readonly InstalledSubAccount[]) => (list.length === 1 ? list[0].installation : null);
  const ticked = subs.filter((s) => s.justInstalled);
  if (ticked.length > 0) return one(ticked.filter(free));
  const open = subs.filter(free);
  return (
    one(open.filter((s) => s.isNew && s.installation.clientId === null)) ??
    one(open.filter((s) => s.installation.clientId === clientId)) ??
    one(open.filter((s) => s.installation.clientId === null))
  );
}

/** What the callback does with an install started for a client. */
export type InstallPick =
  | { kind: "client"; installation: GhlInstallation }
  /** GHL installed only sub-accounts other clients here already hold: nothing moves. */
  | { kind: "elsewhere"; names: string[] }
  /** Installed, but which sub-account is this client's cannot be told: nothing bound. */
  | { kind: "unclear" };

export function pickInstall(clientId: string, subs: readonly InstalledSubAccount[]): InstallPick {
  const installation = installFor(clientId, subs);
  if (installation) return { kind: "client", installation };
  const ticked = subs.filter((s) => s.justInstalled);
  if (ticked.length > 0 && ticked.every((s) => s.installation.clientId !== null && s.installation.clientId !== clientId)) {
    return { kind: "elsewhere", names: ticked.map((s) => s.installation.locationName ?? "That sub-account") };
  }
  return { kind: "unclear" };
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
