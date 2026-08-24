import { NextRequest, NextResponse } from "next/server";
import { verifyVerifyToken } from "@/lib/email-verification";
import { markEmailVerified } from "@/lib/users";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import * as audit from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Confirm an email address.
 *
 * Public by necessity: the whole point is that the caller cannot sign in yet.
 * The token is the credential, and it is verified in full — signature, expiry,
 * and against the live user row — before anything is written.
 *
 * ── 🔴 POST, not GET ─────────────────────────────────────────────────────
 *
 * A GET link that performs the write is followed by every link-preview scanner,
 * corporate mail gateway and antivirus proxy between us and the recipient,
 * often within seconds of delivery. The address ends up "verified" by a machine
 * that merely fetched the URL, and the user's own click then reports "already
 * confirmed" — confusing at best, and in the case of a link forwarded to the
 * wrong person, it verifies an address nobody proved. The `/verify` page shows
 * a button; this handler does the work.
 */
export async function POST(req: NextRequest) {
  const ctx = audit.requestContext(req);

  // A token is unguessable, so this is not brute-force defence — it is a cap on
  // an unauthenticated endpoint that writes.
  const limit = rateLimit(`verify:${clientIp(req)}`, 10, 60_000);
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
  if (!token) {
    return NextResponse.json({ ok: false, error: "Missing link" }, { status: 400 });
  }

  const result = await verifyVerifyToken(token);
  if (!result.ok) {
    /*
     * Each reason gets its own sentence because each has a different next step,
     * and "invalid link" is the message that generates support tickets. In
     * particular `already` is a SUCCESS from the person's point of view — they
     * clicked twice, or a restored tab re-submitted — and telling them it
     * failed would send them looking for a problem that does not exist.
     */
    const message = {
      already: "That address is already confirmed. You can sign in.",
      expired: "That link has expired. Sign in to have a new one sent.",
      malformed:
        "That link is not valid. It may have been truncated by your email client.",
      unavailable: "Email confirmation is not configured on this server.",
    }[result.reason];
    return NextResponse.json(
      { ok: false, error: message, reason: result.reason },
      // `already` is not a client error worth an alarming status — the desired
      // state holds, which is what 200 means.
      { status: result.reason === "already" ? 200 : 400 },
    );
  }

  await markEmailVerified(result.user.id);
  void audit.record({
    action: "auth.email_verified",
    targetType: "user",
    targetId: result.user.id,
    metadata: { email: result.user.email },
    ...ctx,
  });

  // Still no session. Verification proves the address; the password proves the
  // person, and they supply it at the login screen like anybody else.
  return NextResponse.json({ ok: true });
}
