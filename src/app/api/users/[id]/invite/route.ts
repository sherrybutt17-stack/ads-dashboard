import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/user-access";
import { rotateInvite, allowedClientNamesForUser, inviterNameFor } from "@/lib/users";
import { invitesConfigured, isPendingInvite } from "@/lib/invites";
import { issueAccessLink } from "@/lib/access-links";
import { rateLimit } from "@/lib/rate-limit";
import * as audit from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A fresh link for one login — "Send a new invite" or "Send a password link".
 *
 * Which one is decided by the login, not the caller:
 *
 *   · Never set up → a new 7-day invite. The login's random password is
 *     rotated first, which kills every earlier invite link, so a lost or
 *     forwarded one stops working the moment its replacement exists.
 *   · Already in use → a 24-hour "choose a new password" link. NOT rotated:
 *     the owner's current password keeps working until they use the link,
 *     so an operator sending one cannot lock anybody out by doing so.
 *
 * This replaces the operator typing a new password and pasting it into chat.
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const got = await requireUser(id);
  if ("denied" in got) return got.denied;
  const { target, session } = got;

  if (target.status !== "active") {
    // A link for a disabled login would verify as nothing, so say so first.
    return NextResponse.json(
      { error: "This login is disabled. Enable it first, then send a link." },
      { status: 409 },
    );
  }
  if (!invitesConfigured()) {
    return NextResponse.json(
      { error: "Links need AUTH_SECRET (or ENCRYPTION_KEY) set on the server." },
      { status: 503 },
    );
  }

  /*
   * Per operator, and generous: this is a person clicking a button. The limit
   * exists because each click can send an email from our domain, and an
   * authenticated relay is still a relay.
   */
  const limit = rateLimit(`access-link:${session.userId}`, 20, 60 * 60_000);
  if (!limit.ok) {
    return NextResponse.json(
      { error: "Too many links sent in the last hour. Try again later." },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) },
      },
    );
  }

  const pending = isPendingInvite(target);
  const user = pending ? await rotateInvite(target.id) : target;
  if (!user) {
    // Set up between the page loading and this click: not an invite any more.
    return NextResponse.json(
      { error: "This login was just set up. Refresh the page and try again." },
      { status: 409 },
    );
  }

  const link = await issueAccessLink({
    user,
    kind: pending ? "invite" : "password",
    inviterName: await inviterNameFor(session.userId),
    clientNames:
      user.role === "client" ? await allowedClientNamesForUser(user.id) : [],
  });
  if (!link) {
    return NextResponse.json({ error: "Could not create a link." }, { status: 503 });
  }

  void audit.record({
    action: pending ? "user.invite_resent" : "user.password_link",
    targetType: "user",
    targetId: user.id,
    agencyId: user.agencyId,
    // 🔴 Never the URL. It IS the credential until it is used or expires.
    metadata: { email: user.email, emailed: link.emailed },
    ...audit.requestContext(req),
  });

  return NextResponse.json({ ok: true, link });
}
