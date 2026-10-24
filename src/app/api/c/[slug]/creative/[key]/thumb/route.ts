import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { clients } from "@/db/schema";
import { clientAccessGuard } from "@/lib/auth";
import { loadThumb, parseThumbRef } from "@/lib/meta/thumbs";

export const runtime = "nodejs";

/**
 * An ad creative's preview image, fetched by us and served from our own origin.
 *
 * 🔴 **Why this exists rather than pointing `<img>` straight at Meta.** The grid
 * rendered the stored `thumbnail_url` directly, and a large share of cards read
 * "Preview expired" while that exact URL returned `200 image/jpeg` to the
 * server. Three separate causes, none of them visible from the server side:
 *
 *   1. **A quarter of our creatives carry a `www.facebook.com/ads/image/?d=…`
 *      URL** rather than an `fbcdn.net` one — Meta returns whichever it likes,
 *      per creative. A `facebook.com` host with `/ads/` in the path is blocked
 *      outright by uBlock Origin, Brave, Safari's content blockers and plenty
 *      of corporate DNS. The image was never broken; the browser refused to ask
 *      for it, and `onError` reported that as an expiry.
 *   2. Browsers attach the viewer's own Facebook cookies to a `facebook.com`
 *      request, so the response depends on who is looking and whether they hold
 *      a role on someone else's ad account. A client viewing their own
 *      dashboard is precisely the person who does not.
 *   3. The signed URLs do genuinely expire (~2 weeks), so between syncs they
 *      die, and a dead preview reads as a broken dashboard.
 *
 * Proxying fixes all three at once, and as a side effect stops every card view
 * announcing to Meta which dashboard is being read — something the inline
 * `<img referrerPolicy="no-referrer">` could mitigate but never prevent.
 *
 * Slug-scoped for the same reason as the branding logo route: `src/proxy.ts`
 * 403s the whole `/api/` tree for client-role users, so an id-only path would
 * work for the agency and break for the client — the person the dashboard is
 * for.
 *
 * Keyed by `creative_key` (the `image_hash` / `video_id`), not by row id,
 * because that is the identity the grid groups on: one asset commonly runs
 * under several ads, and the card represents the asset. An ad with no single
 * asset (Dynamic Creative, carousels) is asked for as `ad.<ad id>`. The
 * fetching itself lives in `src/lib/meta/thumbs.ts`, shared with board PDFs and
 * share links.
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ slug: string; key: string }> },
) {
  const { slug, key } = await ctx.params;

  // Checked here, not merely in the proxy. The proxy carve-out makes the route
  // reachable; this is what makes it authorized.
  const denied = await clientAccessGuard(slug);
  if (denied) return denied;

  const [client] = await db
    .select({ id: clients.id, agencyId: clients.agencyId })
    .from(clients)
    .where(eq(clients.slug, slug))
    .limit(1);
  if (!client) return new NextResponse(null, { status: 404 });

  const ref = parseThumbRef(decodeURIComponent(key));
  if (!ref) return new NextResponse(null, { status: 404 });

  /*
   * Refreshes from Meta only once the stored URL has actually stopped working —
   * never speculatively, or one page load would be thirty Graph calls.
   */
  const image = await loadThumb(client, ref, { refresh: true });

  // No placeholder bytes: the grid already renders a typed fallback card, which
  // says more than a grey square would.
  if (!image) return new NextResponse(null, { status: 404 });

  return new NextResponse(new Uint8Array(image.bytes), {
    headers: {
      "Content-Type": image.contentType,
      "Content-Length": String(image.bytes.length),
      /*
       * Cached hard: a creative's image is immutable, because Meta mints a new
       * ad rather than repainting an existing one. `private` because the URL is
       * tenant-scoped and a shared cache must never hand one client's creative
       * to another.
       */
      "Cache-Control": "private, max-age=86400, stale-while-revalidate=604800",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
    },
  });
}
