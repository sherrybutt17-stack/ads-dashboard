import { createHmac, timingSafeEqual } from "node:crypto";
import { getUserById } from "@/lib/users";
import type { User } from "@/db/schema";
import { appBaseUrlOr } from "@/lib/app-url";

/**
 * Invite links — "choose your own password", sent by whoever made the login.
 *
 * ── The problem this replaces ────────────────────────────────────────────
 *
 * The Users page used to take a password from the operator and print
 * "Share these credentials — x@y.com / hunter2" on screen. The only way to get
 * it to the person was to paste it into WhatsApp or email, where it then lives
 * forever, readable by everyone who can see that chat, and known to the
 * operator for as long as the account exists. Nothing could ever prove which of
 * them signed in.
 *
 * An invite link carries no password. The person opens it and chooses one, so
 * nobody but them ever knows it — and a link that has been used is dead.
 *
 * ── Same construction as `password-reset.ts`, deliberately ───────────────
 *
 * Stateless: no table, no cleanup job. The signature covers the user's CURRENT
 * password hash, so setting a password through the link invalidates that link
 * and every other outstanding one at the same instant. An invitee has a random
 * hash nobody knows (`createUser` without a password), and "send a new invite"
 * rotates it — which is how a lost or forwarded link is killed.
 *
 * The email is covered too, so a link stops working if the address on the
 * account changes.
 *
 * ── 🔴 Why it has its own label in the signature ─────────────────────────
 *
 * A reset token is `id.exp.sig` over `id|exp|hash`. Signed over the same message
 * with the same key, an invite token would BE a reset token, and the two
 * endpoints would accept each other's links. That is not harmless: accepting an
 * invite also confirms the email address, so a reset link would gain a power it
 * was never designed with, and an invite would quietly obey the reset link's
 * one-hour expiry rules in some places and not others. The label makes them
 * different messages, so neither can ever verify as the other.
 *
 * ── Two lifetimes ────────────────────────────────────────────────────────
 *
 * The expiry is inside the MAC, so the verifier never needs to know which kind
 * of link it holds. The issuer picks:
 *
 *   INVITE_TTL_MS        7 days — a new login, which is worth nothing until
 *                        it is set up. People open invites the following week.
 *   PASSWORD_LINK_TTL_MS 24 hours — an operator-sent "set a new password" link
 *                        for an account that already works. That one IS a
 *                        credential for something of value, so it is short.
 */

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const PASSWORD_LINK_TTL_MS = 24 * 60 * 60 * 1000;

const LABEL = "invite/v1";

function authSecret(): string {
  return process.env.AUTH_SECRET || process.env.ENCRYPTION_KEY || "";
}

/**
 * Can links be minted at all? Checked BEFORE a login is created, so a missing
 * secret refuses the invite rather than leaving behind an account nobody can
 * ever set up.
 */
export function invitesConfigured(): boolean {
  return authSecret() !== "";
}

function sign(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message).digest("base64url");
}

function safeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function message(
  user: Pick<User, "id" | "email" | "passwordHash">,
  exp: number,
): string {
  return `${LABEL}|${user.id}|${exp}|${user.email}|${user.passwordHash}`;
}

/**
 * Has this login never been set up?
 *
 * An invited user's address is confirmed by accepting the invite, so an
 * unconfirmed address on a login that has never signed in is an invite still
 * waiting. Derived rather than stored: a column for it would be a second copy
 * of a fact `email_verified_at` already records, free to disagree with it.
 */
export function isPendingInvite(
  user: Pick<User, "emailVerifiedAt" | "lastLoginAt">,
): boolean {
  return !user.emailVerifiedAt && !user.lastLoginAt;
}

/**
 * Mint a link token.
 *
 * Returns null when no signing secret is configured — an HMAC keyed on the
 * empty string verifies against any other empty-key token, so refusing to mint
 * is the only safe answer. Same rule as `createResetToken`.
 */
export function createInviteToken(
  user: Pick<User, "id" | "email" | "passwordHash">,
  opts: { ttlMs?: number; now?: number } = {},
): { token: string; expiresAt: Date } | null {
  const secret = authSecret();
  if (!secret) return null;
  const now = opts.now ?? Date.now();
  const exp = now + (opts.ttlMs ?? INVITE_TTL_MS);
  return {
    token: `${user.id}.${exp}.${sign(secret, message(user, exp))}`,
    expiresAt: new Date(exp),
  };
}

export type InviteTokenResult =
  | { ok: true; user: User }
  | { ok: false; reason: "malformed" | "expired" | "used" | "unavailable" };

/**
 * Verify a link and return the user it belongs to.
 *
 * `used` is told apart from `malformed` for the same reason the reset and
 * verification links do it: opening an invite twice — from the email, then from
 * a restored tab — is ordinary, and "invalid link" to someone who has in fact
 * already finished turns a solved problem into a support message.
 */
export async function verifyInviteToken(
  token: string,
  now: number = Date.now(),
): Promise<InviteTokenResult> {
  const secret = authSecret();
  if (!secret) return { ok: false, reason: "unavailable" };

  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [userId, expRaw, sig] = parts;

  const exp = Number(expRaw);
  if (!Number.isFinite(exp)) return { ok: false, reason: "malformed" };

  // Before the database read: the expiry is covered by the MAC anyway, and
  // reading first would make the endpoint time-probeable for real ids.
  if (exp <= now) return { ok: false, reason: "expired" };

  const user = await getUserById(userId);
  // Missing and disabled read the same, so this is not a user-id oracle.
  if (!user || user.status !== "active") return { ok: false, reason: "malformed" };

  if (!safeEqualStr(sig, sign(secret, message(user, exp)))) {
    /*
     * The signature covers the password hash. For a login that has been set up,
     * the overwhelmingly common reason to land here is that this link was the
     * one that set it. For a login still waiting, it is that a newer invite
     * replaced this one — which reads as `malformed`, because telling the two
     * apart from a forgery is not possible and not needed: the next step is the
     * same ("ask for a fresh link").
     */
    return isPendingInvite(user)
      ? { ok: false, reason: "malformed" }
      : { ok: false, reason: "used" };
  }

  return { ok: true, user };
}

/** The link that goes in the email, or on the operator's clipboard. */
export function inviteUrl(token: string): string {
  const base = appBaseUrlOr("http://localhost:3000");
  return `${base}/invite?token=${encodeURIComponent(token)}`;
}
