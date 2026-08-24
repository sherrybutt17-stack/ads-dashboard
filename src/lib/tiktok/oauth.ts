/**
 * "Continue with TikTok" — the self-serve TikTok connect flow.
 *
 * Same three steps as Facebook and Google — click, approve, pick accounts — so
 * that an operator who has connected one platform already knows how to connect
 * this one. Everything below that differs from those two is a difference TikTok
 * imposes, not a choice.
 *
 * ── 🔴 Four places TikTok's OAuth differs from every other provider ───
 *
 * Each of these was verified against TikTok's live docs on 2026-08-17, and each
 * one silently produces a broken flow rather than an error if you assume the
 * usual shape:
 *
 *  1. **The callback returns `auth_code`, not `code`.** It returns BOTH, and
 *     TikTok's own example contradicts its prose about which to use. Only
 *     `auth_code` is accepted by the token endpoint. Reading `code` gets you a
 *     value that looks right and exchanges for nothing.
 *  2. **The exchange is a JSON POST, not a query string.** `app_id`, `secret`,
 *     `auth_code` in the body with `Content-Type: application/json`. Sending it
 *     form-encoded routes to a *different* endpoint (`/oauth/token/`) that
 *     answers a different question. There is no `grant_type` and no
 *     `redirect_uri` in the exchange.
 *  3. **Errors arrive as HTTP 200** with the failure in the body's `code`. Same
 *     convention the rest of `tiktok/client.ts` already guards against; it
 *     applies here too, before a client object exists to guard it.
 *  4. **The token never expires and there is no refresh token.**
 *     `/oauth2/refresh_token/` is documented as deprecated precisely because
 *     long-lived tokens are issued instead. So the stored expiry is null — a
 *     real "does not expire", not an unknown.
 *
 * Note TikTok's own SDK repo claims tokens last 24 hours. That text is copied
 * from the creator-account flow and is wrong for advertisers; the primary API
 * docs win. If a token does turn out to die, the health check reports it as a
 * dead pipe rather than the dashboard quietly reading zero.
 *
 * ── The two things that break the "one click" promise ─────────────────
 *
 * Surfaced in the UI rather than left to be discovered:
 *
 *  - **The advertiser must type a verification code emailed to them** during
 *    authorization. Not skippable, valid 48h, re-triggered per developer app.
 *  - **`redirect_uri` is pre-registered on the app**, so it must match what is
 *    configured in TikTok's portal character for character. See
 *    `tiktokRedirectUri` below.
 */

import { appBaseUrlOr } from "@/lib/app-url";

const AUTH_PORTAL = "https://business-api.tiktok.com/portal/auth";
const OPEN_API = "https://business-api.tiktok.com/open_api";
const VERSION = "v1.3";

/** True when the consent flow can run at all. */
export function isTiktokConnectConfigured(): boolean {
  return Boolean(process.env.TIKTOK_APP_ID && process.env.TIKTOK_APP_SECRET);
}

/**
 * Where TikTok sends the browser back.
 *
 * 🔴 Must match the app's **Advertiser redirect URL** exactly. TikTok's app
 * creation form takes a single URL, not a list — so this is `localhost` during
 * development and the deployed origin in production, and the two cannot both be
 * registered at once. A mismatch fails at the exchange with an unhelpful
 * message, long after the actual mistake, which is why the setup page prints
 * this value next to the Connect button.
 */
export function tiktokRedirectUri(): string {
  const base = appBaseUrlOr("http://localhost:3000");
  return `${base}/api/oauth/tiktok/callback`;
}

/**
 * The consent URL.
 *
 * Scopes are absent by design: TikTok fixes them when the app is created, not
 * per authorization, so there is nothing to request here. That also means a
 * missing scope cannot be fixed by changing this function — it needs a new app.
 */
export function buildTiktokAuthorizeUrl(state: string): string {
  const url = new URL(AUTH_PORTAL);
  url.searchParams.set("app_id", process.env.TIKTOK_APP_ID ?? "");
  url.searchParams.set("redirect_uri", tiktokRedirectUri());
  url.searchParams.set("state", state);
  return url.toString();
}

export interface TiktokTokenExchange {
  accessToken: string;
  /**
   * The advertisers this grant covers, straight from the exchange.
   *
   * Kept as a cross-check rather than as the source of truth for the picker:
   * `/oauth2/advertiser/get/` is re-queried at discovery time and is the
   * authoritative list. If the two disagree, the live query is right.
   */
  advertiserIds: string[];
}

/**
 * Exchange the one-time `auth_code` for a long-lived access token.
 *
 * One step, unlike Meta — there is no short-lived token to upgrade, because
 * TikTok issues the durable one directly.
 */
export async function exchangeTiktokCode(
  authCode: string,
): Promise<TiktokTokenExchange> {
  const appId = process.env.TIKTOK_APP_ID;
  const secret = process.env.TIKTOK_APP_SECRET;
  if (!appId || !secret) {
    throw new Error("TIKTOK_APP_ID / TIKTOK_APP_SECRET are not set.");
  }

  const res = await fetch(`${OPEN_API}/${VERSION}/oauth2/access_token/`, {
    method: "POST",
    // 🔴 Exactly these three keys, as JSON. See the header note — form-encoding
    // this reaches a different endpoint entirely.
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, secret, auth_code: authCode }),
    cache: "no-store",
  });

  const text = await res.text();
  let body: {
    code?: number;
    message?: string;
    data?: { access_token?: string; advertiser_ids?: string[] };
  };
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`TikTok returned a non-JSON token response (${res.status}).`);
  }

  /*
   * 🔴 `body.code`, not `res.status`. A failed exchange is a 200 carrying
   * `{"code": 40002, ...}`. Checking only the HTTP status here would let a
   * refusal through as a success with an undefined token, and the first symptom
   * would be a TikTok dashboard reading zero spend with a green health check —
   * the exact failure mode this application exists to replace.
   */
  if (body.code !== 0) {
    throw new Error(
      body.message || `TikTok token exchange failed (code ${body.code ?? "?"}).`,
    );
  }

  const accessToken = body.data?.access_token;
  if (!accessToken) {
    throw new Error("TikTok reported success but returned no access token.");
  }

  return {
    accessToken,
    advertiserIds: (body.data?.advertiser_ids ?? []).map(String),
  };
}
