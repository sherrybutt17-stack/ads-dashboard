import { NextRequest, NextResponse } from "next/server";
import { setUserPassword } from "@/lib/users";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import * as audit from "@/lib/audit";
import { verifyResetToken } from "@/lib/password-reset";
import { MIN_PASSWORD_LENGTH } from "@/lib/password-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Complete a password reset.
 *
 * Public by necessity — the token in the body IS the credential, and someone
 * who cannot sign in cannot present a session. It is HMAC-signed over the
 * user's current password hash, so it is unforgeable and expires the instant it
 * is used. See `lib/password-reset.ts`.
 */
export async function POST(req: NextRequest) {
  const ctx = audit.requestContext(req);

  const limit = rateLimit(`reset:${clientIp(req)}`, 8, 60_000);
  if (!limit.ok) {
    return NextResponse.json(
      { ok: false, error: "Too many attempts. Try again shortly." },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) },
      },
    );
  }

  const body = await req.json().catch(() => null);
  const token = typeof body?.token === "string" ? body.token : "";
  const password = typeof body?.password === "string" ? body.password : "";

  if (password.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json(
      {
        ok: false,
        error: `Choose a password of at least ${MIN_PASSWORD_LENGTH} characters.`,
      },
      { status: 400 },
    );
  }

  const found = await verifyResetToken(token);
  if (!found.ok) {
    void audit.record({
      action: "auth.reset_rejected",
      targetType: "session",
      metadata: { reason: found.reason },
      ...ctx,
    });
    return NextResponse.json(
      { ok: false, error: MESSAGES[found.reason] },
      { status: found.reason === "unavailable" ? 503 : 400 },
    );
  }

  await setUserPassword(found.user.id, password);

  void audit.record({
    action: "auth.reset_completed",
    targetType: "user",
    targetId: found.user.id,
    metadata: { email: found.user.email },
    ...ctx,
  });

  /*
   * 🔴 No session is issued here.
   *
   * Signing the browser in on the strength of an emailed link would make the
   * link equivalent to the password for anyone who reads the inbox — including
   * after the fact, since mail is not deleted when it is used. Making them type
   * the password they just chose also confirms they have it, which catches a
   * typo now rather than on the next login when the reset link is gone.
   *
   * Existing sessions elsewhere are NOT revoked, because the session token is
   * signed independently of the password hash and carries a 30-day expiry. That
   * is a real limitation and worth stating plainly rather than implying
   * otherwise: a reset locks out anyone who knew the old password, but not
   * anyone already holding a live session cookie.
   */
  return NextResponse.json({ ok: true });
}

const MESSAGES: Record<
  "malformed" | "expired" | "used" | "unavailable",
  string
> = {
  malformed: "That reset link isn't valid. Request a new one from the sign-in page.",
  expired: "That reset link has expired. Request a new one from the sign-in page.",
  used: "That link has already been used. If you've set a new password, sign in with it — otherwise request a fresh link.",
  unavailable: "Password resets aren't configured on this server.",
};
