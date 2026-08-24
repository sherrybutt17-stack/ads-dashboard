/**
 * Google Ads OAuth — agency-level.
 *
 * Unlike the Meta system-user token (a single static string), Google requires an
 * OAuth2 refresh token that is exchanged for a short-lived access token. But it
 * is still ONE agency credential: the MCC-owner's refresh token authorizes every
 * client account linked under our Manager account, so it lives in env, not per
 * client. A per-account `refreshTokenEncrypted` override exists only for an
 * account not under our MCC.
 *
 * Google refresh tokens are REUSABLE (they are not single-use like GHL's), so
 * there is no rotation/write-back to manage — we just cache the access token
 * in-memory until it is about to expire.
 */

import { appBaseUrlOr } from "@/lib/app-url";

const TOKEN_URL = "https://oauth2.googleapis.com/token";

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}
const cache = new Map<string, CachedToken>();

/**
 * Every env var Google needs before it can make a single call.
 *
 * 🔴 The APP-level credentials only. This used to also require
 * `GOOGLE_ADS_REFRESH_TOKEN` and `GOOGLE_ADS_LOGIN_CUSTOMER_ID`, which are
 * **Model A only** — the agency's own MCC token, per `.env.example`.
 *
 * That made Model B unreachable. It gates the wizard's Google step, the
 * add-account route and the nightly cron, so an install configured for client
 * sign-in — developer token, OAuth client, no agency MCC — reported Google as
 * "not configured" and never rendered the Connect button. The one route that
 * would have worked, `/api/oauth/google/authorize`, checks these three and is
 * correct; nobody could reach it.
 *
 * The per-account path was ready the whole time: `googleRefreshTokenFor` takes
 * the account's own encrypted token when it has one and only falls back to the
 * shared agency token otherwise, raising a clear error if neither exists. So
 * the right question here is "can we talk to Google at all", and the answer to
 * "do we have an agency-wide credential" belongs where that credential is used.
 */
export function isGoogleConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_ADS_DEVELOPER_TOKEN &&
      process.env.GOOGLE_ADS_CLIENT_ID &&
      process.env.GOOGLE_ADS_CLIENT_SECRET,
  );
}

/**
 * Model A additionally: a shared agency refresh token and MCC id, which let an
 * operator attach an account by pasting its Customer ID rather than having the
 * client sign in. Model B installs have neither and do not need them.
 */
export function isAgencyGoogleConfigured(): boolean {
  return Boolean(
    isGoogleConfigured() &&
      process.env.GOOGLE_ADS_REFRESH_TOKEN &&
      process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID,
  );
}

/**
 * A valid access token for the given refresh token (or the agency default),
 * cached until ~1 min before expiry.
 */
export async function getAccessToken(refreshTokenOverride?: string): Promise<string> {
  const refreshToken =
    refreshTokenOverride ?? process.env.GOOGLE_ADS_REFRESH_TOKEN;
  if (!refreshToken) {
    throw new Error(
      "GOOGLE_ADS_REFRESH_TOKEN is not set — connect the agency Google account (see SETUP.md).",
    );
  }

  const cached = cache.get(refreshToken);
  if (cached && cached.expiresAt > Date.now()) return cached.accessToken;

  const clientId = process.env.GOOGLE_ADS_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_ADS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_ADS_CLIENT_ID / GOOGLE_ADS_CLIENT_SECRET are not set.");
  }

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }).toString(),
    cache: "no-store",
  });

  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) {
    throw new Error(
      `Google token exchange failed (${res.status}): ${
        typeof body === "string" ? body : JSON.stringify(body)
      }`,
    );
  }

  const token = body as { access_token: string; expires_in: number };
  cache.set(refreshToken, {
    accessToken: token.access_token,
    expiresAt: Date.now() + (token.expires_in - 60) * 1000,
  });
  return token.access_token;
}

/* ------------------------------------------------------------------ *
 * Self-serve connect — the client signs in with their own Google account
 * ------------------------------------------------------------------ */

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

/**
 * The one scope this app asks for.
 *
 * `adwords` is a SENSITIVE scope (upgraded from restricted in Oct 2020), which
 * means standard OAuth verification — a written justification and a demo video,
 * but **no CASA**. The annual third-party security assessment applies to
 * restricted scopes only, and asking for anything beyond `adwords` would drag
 * this application into a different, far slower review.
 */
export const GOOGLE_ADS_SCOPE = "https://www.googleapis.com/auth/adwords";

/** Where Google sends the browser back. Must match the console entry exactly. */
export function googleRedirectUri(): string {
  const base = appBaseUrlOr("http://localhost:3000");
  return `${base}/api/oauth/google/callback`;
}

/**
 * True when the pieces needed for the CONSENT FLOW are present.
 *
 * Deliberately distinct from `isGoogleConfigured`, which additionally requires
 * an agency refresh token and MCC id. A deployment can be ready to let clients
 * sign in without the agency having connected its own account — and conflating
 * the two would hide the connect button behind a condition that has nothing to
 * do with it.
 */
export function isGoogleConnectConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_ADS_CLIENT_ID &&
      process.env.GOOGLE_ADS_CLIENT_SECRET &&
      process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
  );
}

export function buildGoogleAuthorizeUrl(state: string): string {
  const url = new URL(AUTH_URL);
  url.searchParams.set("client_id", process.env.GOOGLE_ADS_CLIENT_ID ?? "");
  url.searchParams.set("redirect_uri", googleRedirectUri());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_ADS_SCOPE);
  /*
   * 🔴 Both of these are required to get a REFRESH token, and their failure
   * mode is quiet. `access_type=offline` asks for one at all; `prompt=consent`
   * forces the consent screen even for a user who has authorized before —
   * without it, a returning user's exchange comes back with an access token and
   * NO refresh token, so the connection works for exactly one hour and then
   * stops, long after anyone is still watching.
   */
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);
  return url.toString();
}

export interface GoogleTokenExchange {
  refreshToken: string;
  accessToken: string;
}

/** Exchange the one-time `code` for tokens. */
export async function exchangeGoogleCode(code: string): Promise<GoogleTokenExchange> {
  const clientId = process.env.GOOGLE_ADS_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_ADS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_ADS_CLIENT_ID / GOOGLE_ADS_CLIENT_SECRET are not set.");
  }

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: googleRedirectUri(),
      grant_type: "authorization_code",
    }).toString(),
    cache: "no-store",
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Google code exchange failed (${res.status}): ${text}`);
  }

  const token = JSON.parse(text) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  if (!token.refresh_token) {
    /*
     * Named explicitly rather than stored as null. Without a refresh token the
     * connection dies in an hour, and the cause is almost always the app being
     * in "Testing" publishing status — where Google revokes refresh tokens
     * after seven days — or a missing `prompt=consent`.
     */
    throw new Error(
      "Google returned no refresh token. This normally means the OAuth app is still in Testing publishing status, or the user had already granted access without a forced consent prompt.",
    );
  }

  // Warm the access-token cache so the very next call does not re-exchange.
  cache.set(token.refresh_token, {
    accessToken: token.access_token,
    expiresAt: Date.now() + (token.expires_in - 60) * 1000,
  });

  return { refreshToken: token.refresh_token, accessToken: token.access_token };
}
