import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { clients } from "@/db/schema";
import { claimInstallation, exchangeCode } from "@/lib/ghl/oauth";
import { importPipelineStages } from "@/lib/clients";
import { getClientById } from "@/lib/clients";

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
    const installation = await exchangeCode(code);

    let slug: string | null = null;
    if (clientId) {
      const client = await getClientById(clientId);
      if (client) {
        await claimInstallation(installation.id, client.id);
        slug = client.slug;

        // Pull pipelines now so the mapping step is immediately usable.
        try {
          const refreshed = await getClientById(client.id);
          if (refreshed) await importPipelineStages(refreshed);
        } catch {
          // Non-fatal — the setup page has a manual "Import from GHL" button.
        }
      }
    } else {
      // Installed without a target client: try to bind by matching locationId.
      const [match] = await db
        .select()
        .from(clients)
        .where(eq(clients.ghlLocationId, installation.locationId))
        .limit(1);
      if (match) {
        await claimInstallation(installation.id, match.id);
        slug = match.slug;
      }
    }

    const url = req.nextUrl.clone();
    url.pathname = "/oauth/result";
    const params = new URLSearchParams({ status: "success" });
    if (slug) params.set("slug", slug);
    params.set("location", installation.locationName ?? installation.locationId);
    url.search = `?${params.toString()}`;

    const res = NextResponse.redirect(url);
    res.cookies.delete("ghl_oauth_state");
    return res;
  } catch (err) {
    return redirectWithError(
      req,
      err instanceof Error ? err.message : "Install failed",
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
