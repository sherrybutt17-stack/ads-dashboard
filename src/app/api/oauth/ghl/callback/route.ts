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

  // CSRF: the state must match the cookie we set, and carry a valid signature.
  if (!state || !cookieState || !safeCompare(state, cookieState)) {
    return redirectWithError(req, "OAuth state mismatch — please retry");
  }

  const [clientId, nonce, sig] = state.split(".");
  const expected = createHmac("sha256", process.env.GHL_CLIENT_SECRET!)
    .update(`${clientId}.${nonce}`)
    .digest("hex")
    .slice(0, 32);
  if (!safeCompare(sig ?? "", expected)) {
    return redirectWithError(req, "OAuth state signature invalid");
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
    url.pathname = slug ? `/c/${slug}/setup` : "/";
    url.search = `?installed=${encodeURIComponent(installation.locationName ?? installation.locationId)}`;

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
  url.pathname = "/";
  url.search = `?oauth_error=${encodeURIComponent(message)}`;
  return NextResponse.redirect(url);
}

function safeCompare(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
