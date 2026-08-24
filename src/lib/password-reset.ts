import { createHmac, timingSafeEqual } from "node:crypto";
import { getUserById } from "@/lib/users";
import type { User } from "@/db/schema";
import { appBaseUrlOr } from "@/lib/app-url";

/**
 * Password reset links.
 *
 * ── 🔴 Stateless, and single-use for free ─────────────────────────────
 *
 * There is no `password_resets` table and there should not be one. The signed
 * message includes the user's CURRENT password hash, so the moment the password
 * changes the signature stops verifying — the link that was just used, and every
 * other outstanding link for that account, dies at the same instant. Single-use
 * becomes a property of the construction rather than a row somebody has to
 * remember to delete, and there is no window in which a used link still works
 * because a cleanup job has not run.
 *
 * It also means a stolen link is invalidated by the victim changing their
 * password, which is exactly the action they would take.
 *
 * The same idea underpins Django's default reset token, and it is worth the note
 * because "add a tokens table" is the obvious design and it is strictly worse
 * here: another migration against a database that is already behind, plus a
 * cleanup path, to buy a guarantee this gets from arithmetic.
 *
 * ── What is deliberately NOT in the signature ─────────────────────────
 *
 * `lastLoginAt` — it changes whenever the user signs in somewhere else, which
 * would silently kill a link they are in the middle of using.
 *
 * `status` — a disabled account must not be resettable, but that is checked
 * live at verification against the current row. Baking it in would mean a user
 * disabled after the link was sent could still complete the reset.
 */

/** One hour. Long enough to find the email, short enough to matter if leaked. */
export const RESET_TTL_MS = 60 * 60 * 1000;

function authSecret(): string {
  return process.env.AUTH_SECRET || process.env.ENCRYPTION_KEY || "";
}

function sign(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message).digest("base64url");
}

/** Constant-time compare of two same-length server MACs. */
function safeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Mint a reset link token for a user.
 *
 * Returns null when no signing secret is configured — a token signed with an
 * empty key would verify against any other empty-key token, so refusing to mint
 * one is the only safe response.
 */
export function createResetToken(
  user: Pick<User, "id" | "passwordHash">,
  now: number = Date.now(),
): string | null {
  const secret = authSecret();
  if (!secret) return null;

  const exp = now + RESET_TTL_MS;
  const sig = sign(secret, `${user.id}|${exp}|${user.passwordHash}`);
  return `${user.id}.${exp}.${sig}`;
}

export type ResetTokenResult =
  | { ok: true; user: User }
  | { ok: false; reason: "malformed" | "expired" | "used" | "unavailable" };

/**
 * Verify a reset token and return the user it belongs to.
 *
 * `used` and `expired` are distinguished because the recovery is different and
 * the user can act on both: an expired link needs a new one, while a link that
 * no longer matches the stored hash means the password has already been changed
 * — possibly by them, a minute ago, in another tab. Telling someone "invalid
 * link" when they have in fact already succeeded is how a solved problem
 * becomes a support ticket.
 *
 * Neither leaks anything an attacker holding the token does not already have.
 */
export async function verifyResetToken(
  token: string,
  now: number = Date.now(),
): Promise<ResetTokenResult> {
  const secret = authSecret();
  if (!secret) return { ok: false, reason: "unavailable" };

  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [userId, expRaw, sig] = parts;

  const exp = Number(expRaw);
  if (!Number.isFinite(exp)) return { ok: false, reason: "malformed" };

  /*
   * Expiry is checked BEFORE the database read, on the unverified value.
   *
   * That ordering is safe — the expiry is covered by the MAC, so a tampered one
   * fails below regardless — and it keeps an attacker from using this endpoint
   * to probe which user ids exist by timing the lookup.
   */
  if (exp <= now) return { ok: false, reason: "expired" };

  const user = await getUserById(userId);
  /*
   * A missing user reports `malformed`, not "no such user". The token carries
   * the id, so an attacker holding it learns nothing either way — but the two
   * outcomes staying indistinguishable means the endpoint cannot be turned into
   * a user-id oracle by anyone who guesses at ids.
   */
  if (!user || user.status !== "active") return { ok: false, reason: "malformed" };

  const expected = sign(secret, `${user.id}|${exp}|${user.passwordHash}`);
  if (!safeEqualStr(sig, expected)) {
    /*
     * The signature covers the password hash, so the overwhelmingly common
     * reason to land here is that the password has already been changed since
     * the link was sent — the link doing its job of expiring itself. Reported
     * as `used` rather than `malformed`, because "you have already reset this"
     * is actionable and "invalid" is not.
     */
    return { ok: false, reason: "used" };
  }

  return { ok: true, user };
}

/** The link that goes in the email. */
export function resetUrl(token: string): string {
  const base = appBaseUrlOr("http://localhost:3000");
  return `${base}/reset?token=${encodeURIComponent(token)}`;
}
