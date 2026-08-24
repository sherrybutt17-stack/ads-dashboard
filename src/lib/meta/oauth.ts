/**
 * "Continue with Facebook" — the self-serve Meta connect flow.
 *
 * ── Why this exists alongside the system-user token ───────────────────
 *
 * Until now the only way to attach a Meta ad account was to paste its numeric
 * id, and the shared `META_SYSTEM_USER_TOKEN` did the reading. That works
 * whenever the agency already has Business Manager access to the client's
 * account — which is the normal case, and it is why the token model was chosen.
 *
 * It does not work for a client who will not add the agency to their Business
 * Manager, and it is a poor first-run experience even when it does: the operator
 * has to go and find a ten-digit id. This flow lets whoever actually owns the
 * ads sign in and grant access directly, which is what every competitor ships.
 *
 * ── 🔴 The difference that matters: these tokens EXPIRE ───────────────
 *
 * A system-user token never expires. A **user** token from this flow is
 * short-lived (1–2 hours) and must be exchanged for a long-lived one, which
 * lasts roughly **60 days** — and then stops.
 *
 * That introduces a decaying credential into a product whose entire thesis is
 * that a dead pipe must never be mistaken for a quiet one. So the expiry is
 * stored on the account (`meta_ad_accounts.token_expires_at`), not discarded,
 * and the health checklist warns while there is still time to act. A connection
 * that silently stopped 60 days after a successful setup would be precisely the
 * failure this application was built to replace.
 *
 * ── App Review ────────────────────────────────────────────────────────
 *
 * `ads_read` works without review for anyone holding a role (admin, developer,
 * tester) on the Meta app. For everyone else — a client signing in with their
 * own Facebook account — Meta App Review is required first. The flow is built
 * and correct either way; until review passes, only people with a role on the
 * app can complete it.
 */

import { appBaseUrlOr } from "@/lib/app-url";

const GRAPH = "https://graph.facebook.com";
const DIALOG = "https://www.facebook.com";
const DEFAULT_VERSION = "v25.0";

function apiVersion(): string {
  return process.env.META_API_VERSION || DEFAULT_VERSION;
}

/**
 * The one permission this asks for.
 *
 * Read-only, deliberately. `ads_management` would let the product change
 * budgets and pause campaigns — which it never does, by design (the keep/kill
 * engine recommends and stops there) — and asking for it would drag this into a
 * slower, more scrutinised review for a capability we would not use.
 */
export const META_SCOPE = "ads_read";

/** True when the consent flow can run at all. */
export function isMetaConnectConfigured(): boolean {
  return Boolean(process.env.META_APP_ID && process.env.META_APP_SECRET);
}

/** Where Facebook sends the browser back. Must match the app's config exactly. */
export function metaRedirectUri(): string {
  const base = appBaseUrlOr("http://localhost:3000");
  return `${base}/api/oauth/meta/callback`;
}

export function buildMetaAuthorizeUrl(state: string): string {
  const url = new URL(`${DIALOG}/${apiVersion()}/dialog/oauth`);
  url.searchParams.set("client_id", process.env.META_APP_ID ?? "");
  url.searchParams.set("redirect_uri", metaRedirectUri());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", META_SCOPE);
  url.searchParams.set("state", state);
  return url.toString();
}

export interface MetaTokenExchange {
  accessToken: string;
  /** When the token dies, or null if Meta says it does not expire. */
  expiresAt: Date | null;
}

async function tokenRequest(params: Record<string, string>): Promise<MetaTokenExchange> {
  const url = new URL(`${GRAPH}/${apiVersion()}/oauth/access_token`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url, { cache: "no-store" });
  const text = await res.text();

  let body: { access_token?: string; expires_in?: number; error?: { message?: string } };
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Facebook returned a non-JSON token response (${res.status}).`);
  }

  /*
   * Meta reports its own errors with a real HTTP status AND an `error` object.
   * Both are checked: a 200 carrying an `error` key is not a token, and a
   * non-200 with no parseable message should still say something useful.
   */
  if (!res.ok || body.error || !body.access_token) {
    throw new Error(
      body.error?.message ?? `Facebook token exchange failed (${res.status}).`,
    );
  }

  return {
    accessToken: body.access_token,
    /*
     * `expires_in` absent means a non-expiring token (a system user, or an app
     * configured that way). Recorded as null rather than as "now", so the health
     * check can tell "never expires" from "expired".
     */
    expiresAt:
      typeof body.expires_in === "number" && body.expires_in > 0
        ? new Date(Date.now() + body.expires_in * 1000)
        : null,
  };
}

/**
 * Exchange the one-time `code`, then immediately upgrade to a long-lived token.
 *
 * 🔴 Both steps, always. The code exchange returns a token good for an hour or
 * two; storing that is a connection that works during setup, passes every check
 * the operator runs while watching, and is dead before the first nightly sync.
 * The long-lived exchange is what makes it last ~60 days.
 */
export async function exchangeMetaCode(code: string): Promise<MetaTokenExchange> {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error("META_APP_ID / META_APP_SECRET are not set.");
  }

  const short = await tokenRequest({
    client_id: appId,
    client_secret: appSecret,
    redirect_uri: metaRedirectUri(),
    code,
  });

  return await tokenRequest({
    grant_type: "fb_exchange_token",
    client_id: appId,
    client_secret: appSecret,
    fb_exchange_token: short.accessToken,
  });
}

/**
 * How close to expiry a token has to be before the operator is told.
 *
 * Two weeks, because re-authorising needs the person who owns the Facebook
 * account — which may be the client, not the agency — and that is a
 * conversation, not a button press. A warning that arrived the morning the
 * token died would be an obituary.
 */
export const TOKEN_EXPIRY_WARN_DAYS = 14;

export function tokenExpiryState(
  expiresAt: Date | null | undefined,
  now: Date = new Date(),
): "none" | "ok" | "expiring" | "expired" {
  if (!expiresAt) return "none";
  const msLeft = expiresAt.getTime() - now.getTime();
  if (msLeft <= 0) return "expired";
  return msLeft <= TOKEN_EXPIRY_WARN_DAYS * 86_400_000 ? "expiring" : "ok";
}
