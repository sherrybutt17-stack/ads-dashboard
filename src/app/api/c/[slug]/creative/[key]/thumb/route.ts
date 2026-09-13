import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { clients, metaAdCreatives, metaAdAccounts } from "@/db/schema";
import { clientAccessGuard } from "@/lib/auth";
import { metaClientForAccount } from "@/lib/meta/accounts";
import { resolveCreative } from "@/lib/meta/creative";

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
 * under several ads, and the card represents the asset.
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

  /*
   * Scoped to the client from the path, never looked up by key alone —
   * otherwise anyone holding one slug could read another tenant's creative by
   * guessing an image hash. Newest row wins: the same asset may appear under
   * several ads and the most recently synced carries the freshest URL.
   */
  const [creative] = await db
    .select({
      id: metaAdCreatives.id,
      metaAdId: metaAdCreatives.metaAdId,
      accountId: metaAdCreatives.metaAdAccountId,
      thumbnailUrl: metaAdCreatives.thumbnailUrl,
    })
    .from(metaAdCreatives)
    .where(
      and(
        eq(metaAdCreatives.clientId, client.id),
        eq(metaAdCreatives.creativeKey, decodeURIComponent(key)),
        isNotNull(metaAdCreatives.thumbnailUrl),
      ),
    )
    .orderBy(desc(metaAdCreatives.syncedAt))
    .limit(1);
  if (!creative) return new NextResponse(null, { status: 404 });

  let image = creative.thumbnailUrl
    ? await fetchImage(creative.thumbnailUrl)
    : null;

  /*
   * Only on failure, never speculatively. Re-reading the creative for every
   * card of every view would turn one page load into thirty Graph calls and
   * spend the account's rate limit on pictures — so the stored URL is tried
   * first, and Meta is asked only once it has actually stopped working.
   */
  if (!image) {
    const fresh = await refreshThumbnailUrl(client, creative);
    if (fresh) image = await fetchImage(fresh);
  }

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

/**
 * Fetch the bytes, and be strict about what counts as an image.
 *
 * Meta answers an expired or unauthorised preview with a `200` HTML page often
 * enough that trusting the status code alone would cache a login screen and
 * serve it as a JPEG. The content type is the check that matters.
 */
async function fetchImage(
  url: string,
): Promise<{ bytes: Buffer; contentType: string } | null> {
  try {
    const res = await fetch(url, { cache: "no-store", redirect: "follow" });
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/")) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    return bytes.length > 0 ? { bytes, contentType } : null;
  } catch {
    // A CDN timeout is a missing preview, not a 500 on the dashboard.
    return null;
  }
}

/** Re-resolve from Meta and persist, so the next viewer skips the round trip. */
async function refreshThumbnailUrl(
  client: { id: string; agencyId: string },
  creative: { id: string; metaAdId: string; accountId: string },
): Promise<string | null> {
  try {
    const [account] = await db
      .select()
      .from(metaAdAccounts)
      .where(
        and(
          eq(metaAdAccounts.clientId, client.id),
          eq(metaAdAccounts.adAccountId, creative.accountId),
        ),
      )
      .limit(1);
    if (!account) return null;

    const meta = metaClientForAccount(account, client.agencyId);
    const resolved = resolveCreative(await meta.getAdCreative(creative.metaAdId));
    if (!resolved.thumbnailUrl) return null;

    await db
      .update(metaAdCreatives)
      .set({ thumbnailUrl: resolved.thumbnailUrl })
      .where(eq(metaAdCreatives.id, creative.id));
    return resolved.thumbnailUrl;
  } catch {
    // A deleted ad, a lapsed token, a throttle — all mean "no preview right
    // now", and none of them should take the page down.
    return null;
  }
}
