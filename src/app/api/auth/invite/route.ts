import { NextRequest, NextResponse } from "next/server";
import { verifyInviteToken, isPendingInvite } from "@/lib/invites";
import { setPasswordFromLink } from "@/lib/users";
import { MIN_PASSWORD_LENGTH } from "@/lib/password-policy";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import * as audit from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Accept an invite (or an operator-sent password link): choose a password.
 *
 * Public by necessity — the person cannot sign in until this has run. The
 * HMAC-signed token in the body IS the credential. It covers the login's
 * current password hash, so it stops verifying the instant a password is set,
 * and the write below re-checks that hash so two racing submits cannot both
 * succeed. See `lib/invites.ts`.
 *
 * ── Why this does NOT sign the person in ─────────────────────────────────
 *
 * Same stance as `/api/auth/reset`: they type the password they just chose on
 * the sign-in page. It proves they have it — a typo is found now rather than at
 * the next login, when the link is already dead — and it keeps exactly one
 * route in the codebase that mints sessions.
 */
export async function POST(req: NextRequest) {
  const ctx = audit.requestContext(req);

  // Not brute-force defence — a token is unguessable — but a cap on an
  // unauthenticated endpoint that writes.
  const limit = rateLimit(`invite-accept:${clientIp(req)}`, 8, 60_000);
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

  if (password.length < MIN_PASSWORD_LENGTH || password.length > 200) {
    return NextResponse.json(
      {
        ok: false,
        error: `Choose a password of at least ${MIN_PASSWORD_LENGTH} characters.`,
      },
      { status: 400 },
    );
  }

  const found = await verifyInviteToken(token);
  if (!found.ok) {
    void audit.record({
      action: "auth.invite_rejected",
      targetType: "session",
      metadata: { reason: found.reason },
      ...ctx,
    });
    return NextResponse.json(
      { ok: false, error: MESSAGES[found.reason], reason: found.reason },
      { status: found.reason === "unavailable" ? 503 : 400 },
    );
  }

  const wasInvite = isPendingInvite(found.user);
  const won = await setPasswordFromLink(found.user, password);
  if (!won) {
    // Another submit of this same link got there first.
    return NextResponse.json(
      { ok: false, error: MESSAGES.used, reason: "used" },
      { status: 400 },
    );
  }

  void audit.record({
    action: wasInvite ? "auth.invite_accepted" : "auth.password_link_used",
    targetType: "user",
    targetId: found.user.id,
    agencyId: found.user.agencyId,
    metadata: { email: found.user.email },
    ...ctx,
  });

  // The address, so the next page can pre-fill the sign-in form with it.
  return NextResponse.json({ ok: true, email: found.user.email });
}

const MESSAGES: Record<"malformed" | "expired" | "used" | "unavailable", string> = {
  malformed:
    "This link isn't valid any more — it may have been replaced by a newer one. Ask whoever sent it for a fresh link.",
  expired: "This link has expired. Ask whoever sent it for a fresh one.",
  used: "This link has already been used. Sign in with the password you chose, or use “Forgot your password?” on the sign-in page.",
  unavailable: "Invites aren't configured on this server.",
};
