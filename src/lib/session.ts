/**
 * Session cookie: an HMAC-signed, expiring token that identifies the logged-in
 * user AND carries their authorization (role + the client slugs they may see),
 * so the edge proxy can enforce access with NO database call.
 *
 * Everything here uses only Web Crypto + `btoa`/`TextEncoder`, which exist in
 * both the edge (proxy) and node (auth route) runtimes.
 *
 * Token shape:  v4.<userId>.<agencyId>.<role>.<slugsCsv>.<expiryMs>.<sig>
 *   sig = base64url(HMAC-SHA256(secret,
 *           "<userId>|<agencyId>|<role>|<slugsCsv>|<expiryMs>"))
 *
 * The payload is signed, not encrypted — it carries no secret, only identity and
 * scope, and tampering is rejected by the MAC. Because role/scope are baked into
 * the token, a change to a user's grants takes effect on their next login (or
 * when the token expires); server pages additionally re-check `users.status` on
 * every load, so a disabled account is bounced promptly.
 *
 * ── v3 → v4: the tenant joins the payload ────────────────────────────────
 *
 * `agencyId` is inside the MAC rather than read from the database per request,
 * for the same reason role and slugs are: the edge proxy authorizes with no
 * database call, and a tenant it has to look up is a tenant it will eventually
 * be tempted to take from the URL.
 *
 * 🔴 v3 tokens are rejected outright rather than upgraded in place. A v3 token
 * names no agency, and the only ways to give it one are to guess (wrong, and
 * wrong in the direction of admitting someone to a tenant) or to read the
 * database from the edge (which is the property being protected). Everyone
 * re-logs in once. That is the whole cost, and it is paid a single time.
 */

export const SESSION_COOKIE = "dash_auth";

/** 30 days, matching the cookie maxAge set by the auth route. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Every role the token may carry.
 *
 * 🔴 A literal, not an import from `@/db/schema`. This module runs in the edge
 * proxy, where pulling in Drizzle and the full schema is not an option — so the
 * list is duplicated, and `session.test.ts` asserts it against `userRoleEnum`
 * so the copy cannot drift from the database that authorises against it.
 */
export const SESSION_ROLES = ["staff", "superadmin", "agency", "client"] as const;

export type SessionRole = (typeof SESSION_ROLES)[number];

function isSessionRole(v: string): v is SessionRole {
  return (SESSION_ROLES as readonly string[]).includes(v);
}

export interface SessionPayload {
  /** The user's uuid, or "shared" for the shared-password staff bootstrap. */
  userId: string;
  /**
   * The agency this session acts within.
   *
   * Present for every role, `superadmin` included — a superadmin still HAS a
   * home agency, and crossing the boundary is a permission it exercises rather
   * than a tenant it lacks. Empty string only for the shared-password
   * bootstrap, which predates tenancy and is retired before sign-up opens.
   */
  agencyId: string;
  role: SessionRole;
  /** Client slugs a `client` user may access. Empty for staff (sees all). */
  slugs: string[];
}

function authSecret(): string {
  return process.env.AUTH_SECRET || process.env.ENCRYPTION_KEY || "";
}

function base64url(bytes: ArrayBuffer): string {
  const arr = new Uint8Array(bytes);
  let bin = "";
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return base64url(sig);
}

/** Constant-time string compare (both inputs are same-length server MACs). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Mint a session token for a successfully-authenticated user. */
export async function createSessionToken(
  payload: SessionPayload,
  now: number = Date.now(),
  /**
   * Lifetime override, for sessions that should not last a month.
   *
   * The first-run bootstrap uses it: that session has no database row behind
   * it, so nothing can revoke it once minted — which makes its expiry the only
   * control there is over how long it exists.
   */
  ttlMs: number = SESSION_TTL_MS,
): Promise<string> {
  const exp = now + ttlMs;
  const slugsCsv = payload.slugs.join(",");
  const sig = await hmac(
    authSecret(),
    `${payload.userId}|${payload.agencyId}|${payload.role}|${slugsCsv}|${exp}`,
  );
  return `v4.${payload.userId}.${payload.agencyId}.${payload.role}.${slugsCsv}.${exp}.${sig}`;
}

/**
 * Validate a cookie and return its payload. Returns null for a
 * missing/expired/forged/old-format token — never throws.
 */
export async function verifySessionToken(
  token: string | undefined | null,
  now: number = Date.now(),
): Promise<SessionPayload | null> {
  const secret = authSecret();
  if (!token || !secret) return null;

  const parts = token.split(".");
  // A v3 token names no agency and cannot be given one here — see the header.
  if (parts.length !== 7 || parts[0] !== "v4") return null;
  const [, userId, agencyId, role, slugsCsv, expStr, sig] = parts;
  if (!isSessionRole(role)) return null;

  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp <= now) return null;

  const expected = await hmac(
    secret,
    `${userId}|${agencyId}|${role}|${slugsCsv}|${exp}`,
  );
  if (!timingSafeEqual(sig, expected)) return null;

  return {
    userId,
    agencyId,
    role,
    slugs: slugsCsv ? slugsCsv.split(",") : [],
  };
}
