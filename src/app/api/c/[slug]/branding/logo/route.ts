import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { clients } from "@/db/schema";
import { clientAccessGuard } from "@/lib/auth";
import { getClientLogo } from "@/lib/branding-store";

/**
 * A client's logo, served from Postgres.
 *
 * Slug-scoped by design. The obvious shape, `/api/brand/<clientId>/logo.png`, is
 * broken here for a reason that is invisible until a client looks at their own
 * dashboard: `src/proxy.ts` 403s the whole `/api/` tree for client-role users,
 * so the agency would see the logo on every page and the client — the only
 * person the branding is FOR — would see a broken image. The slug in the path is
 * what lets the proxy apply the same ownership rule it already applies to
 * `/c/<slug>`, and what lets this handler re-check it independently.
 *
 * Storage note: Postgres `bytea`, not S3 or Vercel Blob. At roughly fifty logos
 * of a few hundred kilobytes, an object store buys nothing and costs three
 * environment variables, a CORS policy and a second thing that can be
 * mis-permissioned. An external URL was rejected outright — it is an SSRF vector
 * and the URL rots.
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
) {
  const { slug } = await ctx.params;

  // Checked here, not merely in the proxy. The proxy carve-out makes the route
  // reachable; this is what makes it authorized.
  const denied = await clientAccessGuard(slug);
  if (denied) return denied;

  const [client] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(eq(clients.slug, slug))
    .limit(1);
  if (!client) return new NextResponse(null, { status: 404 });

  const logo = await getClientLogo(client.id);
  if (!logo) return new NextResponse(null, { status: 404 });

  return new NextResponse(new Uint8Array(logo.bytes), {
    headers: {
      "Content-Type": logo.contentType,
      "Content-Length": String(logo.bytes.length),
      /*
       * Immutable, because the URL carries a `v=` bumped on every upload. Without
       * the version a replaced logo keeps serving from cache for the whole TTL
       * and the client concludes the upload silently failed.
       *
       * `private` because this is one tenant's asset: a shared CDN cache must
       * never be able to hand client A's logo to client B on a URL collision.
       */
      "Cache-Control": "private, max-age=31536000, immutable",
      // Belt and braces on an endpoint that returns bytes a user uploaded.
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
    },
  });
}
