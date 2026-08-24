import { NextRequest, NextResponse } from "next/server";
import { randomBytes, createHmac } from "node:crypto";
import { getSessionUser, isAgencyOperator } from "@/lib/auth";
import {
  buildTiktokAuthorizeUrl,
  isTiktokConnectConfigured,
} from "@/lib/tiktok/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const TIKTOK_STATE_COOKIE = "tiktok_oauth_state";

/**
 * Start the "Continue with TikTok" flow.
 *
 * `state` carries the client id this connection will bind to, HMAC-signed so a
 * tampered value cannot attach someone's advertisers to another tenant, plus a
 * nonce echoed in a short-lived cookie — the CSRF defence. Identical in shape to
 * the Meta and Google authorize routes, deliberately: three OAuth flows that
 * verify state three different ways is how one of them ends up verifying it
 * wrongly.
 *
 * Staff-only. `clientId` is caller-supplied, so a client-role user could
 * otherwise start a flow that rebinds another tenant's advertisers on callback.
 */
export async function GET(req: NextRequest) {
  if (!isAgencyOperator(await getSessionUser())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!isTiktokConnectConfigured()) {
    return NextResponse.json(
      {
        error:
          "TikTok connect is not configured. Set TIKTOK_APP_ID and TIKTOK_APP_SECRET.",
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
  const sig = createHmac("sha256", process.env.TIKTOK_APP_SECRET!)
    .update(payload)
    .digest("hex")
    .slice(0, 32);
  const state = `${payload}.${sig}`;

  const res = NextResponse.redirect(buildTiktokAuthorizeUrl(state));
  res.cookies.set(TIKTOK_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    /*
     * 🔴 Fifteen minutes, where Meta and Google get ten.
     *
     * TikTok emails the advertiser a verification code partway through
     * authorization and will not proceed until it is typed in. That is a trip to
     * another application, and a ten-minute cookie would expire mid-flow — the
     * operator would come back having done everything right and be told the
     * sign-in could not be verified.
     */
    maxAge: 900,
  });
  return res;
}
