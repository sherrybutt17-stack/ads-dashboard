import { NextRequest, NextResponse } from "next/server";
import { randomBytes, createHmac } from "node:crypto";
import { getSessionUser, isAgencyOperator } from "@/lib/auth";
import {
  buildGoogleAuthorizeUrl,
  isGoogleConnectConfigured,
} from "@/lib/google/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GOOGLE_STATE_COOKIE = "google_oauth_state";

/**
 * Start the Google Ads consent flow — the self-serve front door.
 *
 * The model: the client (or an operator sitting with them) signs in with
 * whatever Google account actually holds their ads, and we discover the
 * accessible accounts from there. That is Model B; the agency-MCC path
 * (Model A) remains as the fallback for accounts already linked to our Manager
 * account.
 *
 * `state` carries the client id this connection will bind to, HMAC-signed so a
 * tampered value cannot attach someone's Google account to another tenant, plus
 * a nonce echoed in a short-lived cookie — the CSRF defence.
 *
 * Staff-only, for the same reason as the GHL equivalent: `clientId` is
 * caller-supplied, so a non-staff user could otherwise start a flow that
 * rebinds another tenant's ad accounts on callback.
 */
export async function GET(req: NextRequest) {
  if (!isAgencyOperator(await getSessionUser())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!isGoogleConnectConfigured()) {
    return NextResponse.json(
      {
        error:
          "Google connect is not configured. Set GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET and GOOGLE_ADS_DEVELOPER_TOKEN.",
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
  const sig = createHmac("sha256", process.env.GOOGLE_ADS_CLIENT_SECRET!)
    .update(payload)
    .digest("hex")
    .slice(0, 32);
  const state = `${payload}.${sig}`;

  const res = NextResponse.redirect(buildGoogleAuthorizeUrl(state));
  res.cookies.set(GOOGLE_STATE_COOKIE, state, {
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
