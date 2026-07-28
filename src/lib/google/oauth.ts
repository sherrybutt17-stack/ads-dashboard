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

const TOKEN_URL = "https://oauth2.googleapis.com/token";

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}
const cache = new Map<string, CachedToken>();

/** Every env var Google needs before it can make a single call. */
export function isGoogleConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_ADS_DEVELOPER_TOKEN &&
      process.env.GOOGLE_ADS_CLIENT_ID &&
      process.env.GOOGLE_ADS_CLIENT_SECRET &&
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
