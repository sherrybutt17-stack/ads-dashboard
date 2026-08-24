import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { safeFailureMessage } from "@/lib/api-failure";
import { claimInstallation, exchangeCode } from "@/lib/ghl/oauth";
import { importPipelineStages } from "@/lib/clients";
import { getClientUnscoped } from "@/lib/clients";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * OAuth callback.
 *
 * Exchanges the code, stores the installation, and — when the flow was started
 * from a specific client's setup page — binds the two together and imports that
 * sub-account's pipeline stages immediately, so the operator lands on a mapping
 * screen with real stage names rather than an empty list.
 */
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state") ?? "";
  const cookieState = req.cookies.get("ghl_oauth_state")?.value ?? "";

  if (!code) {
    return redirectWithError(req, "No authorization code returned by GHL");
  }

  /*
   * Two legitimate entry points:
   *   • App-initiated ("Install on a sub-account") sets a signed state cookie.
   *     We enforce it as CSRF protection and read the target client from it.
   *   • GHL-marketplace-initiated installs (their install link) arrive with no
   *     cookie of ours — there is nothing to forge against, so we accept the
   *     code and bind by locationId below instead of rejecting a real install.
   */
  let clientId = "";
  if (cookieState) {
    if (!state || !safeCompare(state, cookieState)) {
      return redirectWithError(req, "OAuth state mismatch — please retry");
    }
    const [cid, nonce, sig] = state.split(".");
    const expected = createHmac("sha256", process.env.GHL_CLIENT_SECRET!)
      .update(`${cid}.${nonce}`)
      .digest("hex")
      .slice(0, 32);
    if (!safeCompare(sig ?? "", expected)) {
      return redirectWithError(req, "OAuth state signature invalid");
    }
    clientId = cid;
  }

  try {
    const installation = await exchangeCode(code, clientId);

    let slug: string | null = null;
    if (clientId) {
      /*
       * Unscoped on purpose, and named so. The authorization for this lookup is
       * the HMAC-signed `state` verified above — the client id was minted into
       * it by the authorize route, which DID check the caller's session, so it
       * is not caller input by the time it arrives here.
       */
      const client = await getClientUnscoped(clientId, "oauth_state");
      if (client) {
        await claimInstallation(installation.id, client);
        slug = client.slug;

        // Pull pipelines now so the mapping step is immediately usable.
        try {
          const refreshed = await getClientUnscoped(client.id, "oauth_state");
          if (refreshed) await importPipelineStages(refreshed);
        } catch {
          // Non-fatal — the setup page has a manual "Import from GHL" button.
        }
      }
    }
    /*
     * 🔴 An install with no target client is left UNCLAIMED, on purpose.
     *
     * This branch used to bind it to whichever client had a matching
     * `ghlLocationId`. That column is a form field — anyone adding a client can
     * type any location id they like — so the match was: "somebody claimed this
     * sub-account in advance, give it to them." Type a competitor's location id
     * into a client of your own, wait for them to install, and their tokens,
     * contacts and pipeline bind to you.
     *
     * Guessing an owner is not a feature worth having. The install sits
     * unclaimed until someone connects it from a client's setup page, where
     * `claimInstallation` can check who is asking.
     */

    const url = req.nextUrl.clone();
    url.pathname = "/oauth/result";
    const params = new URLSearchParams({ status: "success" });
    if (slug) params.set("slug", slug);
    params.set(
      "location",
      installation.locationName ?? installation.locationId,
    );
    url.search = `?${params.toString()}`;

    const res = NextResponse.redirect(url);
    res.cookies.delete("ghl_oauth_state");
    return res;
  } catch (err) {
    // Redacted with no superadmin exemption — see the note in the Meta
    // callback: this rides in a URL. GHL's own errors quote the request path,
    // which carries a location id.
    return redirectWithError(
      req,
      safeFailureMessage(err, "ghl", "Install failed"),
    );
  }
}

function redirectWithError(req: NextRequest, message: string) {
  const url = req.nextUrl.clone();
  url.pathname = "/oauth/result";
  url.search = `?status=error&message=${encodeURIComponent(message)}`;
  return NextResponse.redirect(url);
}

function safeCompare(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
