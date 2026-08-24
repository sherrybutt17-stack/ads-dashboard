import { NextRequest, NextResponse } from "next/server";
import { randomBytes, createHmac } from "node:crypto";
import { getSessionUser, isAgencyOperator } from "@/lib/auth";
import { buildMetaAuthorizeUrl, isMetaConnectConfigured } from "@/lib/meta/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const META_STATE_COOKIE = "meta_oauth_state";

/**
 * Start the "Continue with Facebook" flow.
 *
 * `state` carries the client id this connection will bind to, HMAC-signed so a
 * tampered value cannot attach someone's ad accounts to another tenant, plus a
 * nonce echoed in a short-lived cookie — the CSRF defence. Identical in shape to
 * the Google authorize route, deliberately: two OAuth flows that verify state
 * differently is how one of them ends up verifying it wrongly.
 *
 * Staff-only. `clientId` is caller-supplied, so a client-role user could
 * otherwise start a flow that rebinds another tenant's accounts on callback.
 */
export async function GET(req: NextRequest) {
  if (!isAgencyOperator(await getSessionUser())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!isMetaConnectConfigured()) {
    return NextResponse.json(
      {
        error:
          "Facebook connect is not configured. Set META_APP_ID and META_APP_SECRET.",
      },
      { status: 500 },
    );
  }

  const clientId = req.nextUrl.searchParams.get("clientId") ?? "";
  if (!clientId) {
    return NextResponse.json({ error: "clientId is required" }, { status: 400 });
  }

  const nonce = randomBytes(16).toString("hex");
  const payload = `${clientId}.${nonce}`;
  const sig = createHmac("sha256", process.env.META_APP_SECRET!)
    .update(payload)
    .digest("hex")
    .slice(0, 32);
  const state = `${payload}.${sig}`;

  const res = NextResponse.redirect(buildMetaAuthorizeUrl(state));
  res.cookies.set(META_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    // Long enough to read a consent screen, short enough that an abandoned
    // attempt cannot be completed by someone else at the same machine later.
    maxAge: 600,
  });
  return res;
}
