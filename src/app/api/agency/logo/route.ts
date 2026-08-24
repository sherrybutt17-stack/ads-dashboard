import { NextResponse } from "next/server";
import { getSessionUser, isAgencyOperator } from "@/lib/auth";
import { getAgencyLogo } from "@/lib/branding-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The agency's own wordmark, for the settings form's preview.
 *
 * ── Why this is not how the REPORT gets the logo ─────────────────────────
 *
 * It cannot be. A share link's reader has no session, so this route would 401
 * on the one document the mark exists to sign — the same trap
 * `getClientLogoDataUri` was written to avoid for client logos. Reports embed
 * the bytes as a `data:` URI instead. This route exists only so the operator
 * can see what they just uploaded.
 *
 * ── No id in the path ────────────────────────────────────────────────────
 *
 * The tenant comes from the session, so there is no id to tamper with and no
 * ownership check to forget. Serving `/api/agency/<id>/logo` would have needed
 * one, and getting it wrong leaks one agency's wordmark to another — which is
 * exactly the material a convincing invoice is made of.
 */
export async function GET() {
  const session = await getSessionUser();
  if (!isAgencyOperator(session) || !session!.agencyId) {
    // 404 rather than 403: this is an image tag's src, and a 403 renders as a
    // broken image with a console error either way. There is nothing here.
    return new NextResponse(null, { status: 404 });
  }

  const logo = await getAgencyLogo(session!.agencyId);
  if (!logo) return new NextResponse(null, { status: 404 });

  return new NextResponse(new Uint8Array(logo.bytes), {
    headers: {
      "Content-Type": logo.contentType,
      "Content-Length": String(logo.bytes.length),
      /*
       * Immutable, because the URL carries a `v=` bumped on every upload —
       * without it a replaced logo keeps serving from cache and the upload
       * looks like it silently failed. `private` because this is one tenant's
       * asset and a shared cache must never hand it to another.
       */
      "Cache-Control": "private, max-age=31536000, immutable",
      // Belt and braces on an endpoint returning bytes a user uploaded.
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
    },
  });
}
