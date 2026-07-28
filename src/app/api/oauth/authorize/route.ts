import { NextRequest, NextResponse } from "next/server";
import { randomBytes, createHmac } from "node:crypto";
import { buildAuthorizeUrl, isOauthConfigured } from "@/lib/ghl/oauth";
import { getSessionUser, isStaff } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Kick off the GHL OAuth install.
 *
 * `state` carries the client id we want to bind the install to, signed with an
 * HMAC so a tampered value cannot cause an install to be attached to somebody
 * else's client. It is also stored in a short-lived cookie and compared on the
 * way back, which is the CSRF defence.
 *
 * Staff-only: the `clientId` bound here is caller-supplied, so a non-staff user
 * could otherwise start an install that rebinds another tenant's GHL wiring on
 * callback. The callback itself stays open because marketplace-initiated
 * installs arrive with no session cookie.
 */
export async function GET(req: NextRequest) {
  if (!isStaff(await getSessionUser())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!isOauthConfigured()) {
    return NextResponse.json(
      {
        error:
          "GHL OAuth is not configured. Set GHL_CLIENT_ID and GHL_CLIENT_SECRET.",
      },
      { status: 500 },
    );
  }

  const clientId = req.nextUrl.searchParams.get("clientId") ?? "";
  const nonce = randomBytes(16).toString("hex");
  const payload = `${clientId}.${nonce}`;
  const sig = createHmac("sha256", process.env.GHL_CLIENT_SECRET!)
    .update(payload)
    .digest("hex")
    .slice(0, 32);
  const state = `${payload}.${sig}`;

  const res = NextResponse.redirect(buildAuthorizeUrl(state));
  res.cookies.set("ghl_oauth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 600,
  });
  return res;
}
