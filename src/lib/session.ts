/**
 * Session cookie: an HMAC-signed, expiring token that identifies the logged-in
 * user AND carries their authorization (role + the client slugs they may see),
 * so the edge proxy can enforce access with NO database call.
 *
 * Everything here uses only Web Crypto + `btoa`/`TextEncoder`, which exist in
 * both the edge (proxy) and node (auth route) runtimes.
 *
 * Token shape:  v3.<userId>.<role>.<slugsCsv>.<expiryMs>.<sig>
 *   sig = base64url(HMAC-SHA256(secret, "<userId>|<role>|<slugsCsv>|<expiryMs>"))
 *
 * The payload is signed, not encrypted — it carries no secret, only identity and
 * scope, and tampering is rejected by the MAC. Because role/scope are baked into
 * the token, a change to a user's grants takes effect on their next login (or
 * when the token expires); server pages additionally re-check `users.status` on
 * every load, so a disabled account is bounced promptly.
 */

export const SESSION_COOKIE = "dash_auth";

/** 30 days, matching the cookie maxAge set by the auth route. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type SessionRole = "staff" | "client";

export interface SessionPayload {
  /** The user's uuid, or "shared" for the shared-password staff bootstrap. */
  userId: string;
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
): Promise<string> {
  const exp = now + SESSION_TTL_MS;
  const slugsCsv = payload.slugs.join(",");
  const sig = await hmac(
    authSecret(),
    `${payload.userId}|${payload.role}|${slugsCsv}|${exp}`,
  );
  return `v3.${payload.userId}.${payload.role}.${slugsCsv}.${exp}.${sig}`;
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
  if (parts.length !== 6 || parts[0] !== "v3") return null;
  const [, userId, role, slugsCsv, expStr, sig] = parts;
  if (role !== "staff" && role !== "client") return null;

  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp <= now) return null;

  const expected = await hmac(secret, `${userId}|${role}|${slugsCsv}|${exp}`);
  if (!timingSafeEqual(sig, expected)) return null;

  return {
    userId,
    role,
    slugs: slugsCsv ? slugsCsv.split(",") : [],
  };
}
