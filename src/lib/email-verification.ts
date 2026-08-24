import { createHmac, timingSafeEqual } from "node:crypto";
import { getUserById } from "@/lib/users";
import type { User } from "@/db/schema";
import { appBaseUrlOr } from "@/lib/app-url";

/**
 * Email verification links.
 *
 * The same stateless construction as `password-reset.ts`, and for the same
 * reason: no table, no cleanup job, and single-use as a property of arithmetic
 * rather than of a row somebody has to remember to delete.
 *
 * ── What the signature covers, and why each part is there ────────────────
 *
 * `userId | exp | email | emailVerifiedAt`
 *
 * **`email`** — so a link stops working the instant the address changes. A user
 * who typos their address, corrects it, then clicks the first email would
 * otherwise verify an address they no longer hold.
 *
 * **`emailVerifiedAt`** — this is what makes it single-use. Verifying stamps the
 * column, the signature stops matching, and every outstanding link for that
 * account dies at the same instant. Without it a verification link stays live
 * for its full hour after being used, which matters because these arrive in
 * inboxes that get forwarded.
 *
 * ── Deliberately NOT in the signature ────────────────────────────────────
 *
 * `passwordHash` — resetting a password should not invalidate a pending
 * verification. They are separate journeys and a user is quite likely to do both
 * in the same sitting; coupling them means the second one silently breaks the
 * first, with no way for the user to tell what happened.
 *
 * `status` — a disabled account must not be verifiable, but that is checked live
 * against the current row. Baking it in would let someone disabled after the
 * link was sent still complete the flow.
 */

/**
 * 24 hours, against the reset link's one.
 *
 * A reset link is a credential for an account that already exists and is worth
 * something to an attacker. A verification link only proves the recipient can
 * read the inbox, so the cost of a longer window is small, while the cost of a
 * short one is real: this arrives during sign-up, and people leave sign-up
 * half-finished and come back to it that evening.
 */
export const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;

function authSecret(): string {
  return process.env.AUTH_SECRET || process.env.ENCRYPTION_KEY || "";
}

function sign(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message).digest("base64url");
}

function safeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** The part of the user's state the signature is bound to. */
function fingerprint(
  user: Pick<User, "id" | "email" | "emailVerifiedAt">,
  exp: number,
): string {
  return `${user.id}|${exp}|${user.email}|${user.emailVerifiedAt?.getTime() ?? 0}`;
}

/**
 * Mint a verification token.
 *
 * Returns null when no signing secret is configured. An HMAC keyed on the empty
 * string verifies against any other empty-key token, so refusing to mint is the
 * only safe answer — the same rule as `createResetToken`.
 */
export function createVerifyToken(
  user: Pick<User, "id" | "email" | "emailVerifiedAt">,
  now: number = Date.now(),
): string | null {
  const secret = authSecret();
  if (!secret) return null;
  const exp = now + VERIFY_TTL_MS;
  return `${user.id}.${exp}.${sign(secret, fingerprint(user, exp))}`;
}

export type VerifyTokenResult =
  | { ok: true; user: User }
  | { ok: false; reason: "malformed" | "expired" | "already" | "unavailable" };

/**
 * Verify a token and return the user it belongs to.
 *
 * `already` is separated from `malformed` because the recovery differs and the
 * user can act on it. Clicking a verification link twice — from the email and
 * from a browser's restored tab — is ordinary, and telling someone their link
 * is invalid when they have in fact already succeeded turns a solved problem
 * into a support ticket.
 */
export async function verifyVerifyToken(
  token: string,
  now: number = Date.now(),
): Promise<VerifyTokenResult> {
  const secret = authSecret();
  if (!secret) return { ok: false, reason: "unavailable" };

  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [userId, expRaw, sig] = parts;

  const exp = Number(expRaw);
  if (!Number.isFinite(exp)) return { ok: false, reason: "malformed" };

  // Checked before the database read: the expiry is covered by the MAC anyway,
  // and reading first would make this endpoint time-probeable for real ids.
  if (exp <= now) return { ok: false, reason: "expired" };

  const user = await getUserById(userId);
  if (!user || user.status !== "active") return { ok: false, reason: "malformed" };

  if (!safeEqualStr(sig, sign(secret, fingerprint(user, exp)))) {
    /*
     * The signature covers `emailVerifiedAt`, so by far the most common reason
     * to land here is that the address is already verified — the link having
     * expired itself on use. Reported as `already`, which is both true and the
     * thing the person needs to hear.
     */
    return user.emailVerifiedAt
      ? { ok: false, reason: "already" }
      : { ok: false, reason: "malformed" };
  }

  return { ok: true, user };
}

/** The link that goes in the email. */
export function verifyUrl(token: string): string {
  const base = appBaseUrlOr("http://localhost:3000");
  return `${base}/verify?token=${encodeURIComponent(token)}`;
}
