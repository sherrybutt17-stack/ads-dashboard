import { and, desc, eq, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { metaAdCreatives, metaAdAccounts } from "@/db/schema";
import { metaClientForAccount } from "@/lib/meta/accounts";
import { resolveCreative } from "@/lib/meta/creative";

/**
 * Creative thumbnails: found per client, fetched strictly, refreshed from Meta
 * only when the stored URL has died — shared by the thumb route (pages, behind
 * a session) and by board documents (PDFs and share links, which have none and
 * so carry their images inline).
 *
 * Why a proxy at all, rather than pointing `<img>` at Meta, is explained on the
 * route (`src/app/api/c/[slug]/creative/[key]/thumb/route.ts`).
 */

/** A thumbnail reference: an asset key (image hash / video id), or `ad.<id>` for an ad with no single asset. */
export type ThumbRef = { kind: "creative"; key: string } | { kind: "ad"; adId: string };

/** Parse a ref from a URL segment or card data. Null for anything else. */
export function parseThumbRef(segment: string): ThumbRef | null {
  const ad = /^ad\.(\d{1,30})$/.exec(segment);
  if (ad) return { kind: "ad", adId: ad[1] };
  // Image hashes are hex, video ids digits; nothing longer or stranger is a key.
  return /^[A-Za-z0-9_:-]{1,200}$/.test(segment) ? { kind: "creative", key: segment } : null;
}

export interface ThumbImage {
  bytes: Buffer;
  contentType: string;
}

interface ThumbRow {
  id: string;
  metaAdId: string;
  accountId: string;
  thumbnailUrl: string | null;
}

/**
 * The newest stored row for this ref, scoped to the client — never looked up by
 * key alone, or one tenant could read another's creative by guessing a hash.
 */
async function findThumbRow(clientId: string, ref: ThumbRef): Promise<ThumbRow | null> {
  const [row] = await db
    .select({
      id: metaAdCreatives.id,
      metaAdId: metaAdCreatives.metaAdId,
      accountId: metaAdCreatives.metaAdAccountId,
      thumbnailUrl: metaAdCreatives.thumbnailUrl,
    })
    .from(metaAdCreatives)
    .where(
      and(
        eq(metaAdCreatives.clientId, clientId),
        ref.kind === "ad"
          ? eq(metaAdCreatives.metaAdId, ref.adId)
          : eq(metaAdCreatives.creativeKey, ref.key),
        isNotNull(metaAdCreatives.thumbnailUrl),
      ),
    )
    .orderBy(desc(metaAdCreatives.syncedAt))
    .limit(1);
  return row ?? null;
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * Fetch the bytes, and be strict about what counts as an image.
 *
 * Meta answers an expired or unauthorised preview with a `200` HTML page often
 * enough that trusting the status code alone would cache a login screen and
 * serve it as a JPEG. The content type is the check that matters.
 */
export async function fetchImage(url: string, timeoutMs = 4000): Promise<ThumbImage | null> {
  try {
    const res = await fetch(url, {
      cache: "no-store",
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/")) return null;
    if (Number(res.headers.get("content-length") ?? 0) > MAX_IMAGE_BYTES) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    return bytes.length > 0 && bytes.length <= MAX_IMAGE_BYTES ? { bytes, contentType } : null;
  } catch {
    // A CDN timeout is a missing preview, not a 500 on the dashboard.
    return null;
  }
}

/** Re-resolve from Meta and persist, so the next viewer skips the round trip. */
async function refreshThumbnailUrl(
  client: { id: string; agencyId: string },
  row: ThumbRow,
): Promise<string | null> {
  try {
    const [account] = await db
      .select()
      .from(metaAdAccounts)
      .where(and(eq(metaAdAccounts.clientId, client.id), eq(metaAdAccounts.adAccountId, row.accountId)))
      .limit(1);
    if (!account) return null;

    const meta = metaClientForAccount(account, client.agencyId);
    const resolved = resolveCreative(await meta.getAdCreative(row.metaAdId));
    if (!resolved.thumbnailUrl) return null;

    await db
      .update(metaAdCreatives)
      .set({ thumbnailUrl: resolved.thumbnailUrl })
      .where(eq(metaAdCreatives.id, row.id));
    return resolved.thumbnailUrl;
  } catch {
    // A deleted ad, a lapsed token, a throttle — all mean "no preview right
    // now", and none of them should take the page down.
    return null;
  }
}

/**
 * One thumbnail's bytes.
 *
 * `refresh`: ask Meta for a fresh URL when the stored one has died. Only on
 * failure, never speculatively — and never from a public document view, where
 * any visitor holding a share link would otherwise spend the account's Graph
 * quota on pictures.
 */
export async function loadThumb(
  client: { id: string; agencyId: string },
  ref: ThumbRef,
  opts: { refresh: boolean; timeoutMs?: number },
): Promise<ThumbImage | null> {
  const row = await findThumbRow(client.id, ref);
  if (!row) return null;
  let image = row.thumbnailUrl ? await fetchImage(row.thumbnailUrl, opts.timeoutMs) : null;
  if (!image && opts.refresh) {
    const fresh = await refreshThumbnailUrl(client, row);
    if (fresh) image = await fetchImage(fresh, opts.timeoutMs);
  }
  return image;
}

/* ------------------------------------------------------------------ *
 * Inline thumbnails for documents
 * ------------------------------------------------------------------ */

const INLINE_WIDTH = 400;
/** Without a resizer, only an image this small goes into a document as it is. */
const RAW_INLINE_MAX = 150 * 1024;
const RAW_INLINE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

/**
 * A data URI small enough to put in a document: 400px wide JPEG, about
 * 20–40 KB. `sharp` is loaded lazily so a missing native binary costs a
 * thumbnail, never the document.
 */
export async function inlineThumb(img: ThumbImage): Promise<string | null> {
  try {
    const { default: sharp } = await import("sharp");
    const out = await sharp(img.bytes)
      .resize({ width: INLINE_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: 72 })
      .toBuffer();
    return `data:image/jpeg;base64,${out.toString("base64")}`;
  } catch {
    const type = img.contentType.split(";")[0].trim().toLowerCase();
    if (!RAW_INLINE_TYPES.has(type) || img.bytes.length > RAW_INLINE_MAX) return null;
    return `data:${type};base64,${img.bytes.toString("base64")}`;
  }
}

/** Recently inlined thumbnails, so a share link opened twice fetches nothing twice. */
const CACHE_MAX = 200;
const CACHE_MS = 60 * 60 * 1000;
/** A miss is retried sooner: the CDN may only have been slow. */
const MISS_MS = 5 * 60 * 1000;
const cache = new Map<string, { src: string | null; at: number }>();

function cached(key: string): string | null | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > (hit.src === null ? MISS_MS : CACHE_MS)) {
    cache.delete(key);
    return undefined;
  }
  // Re-insert: the Map's order is the eviction order.
  cache.delete(key);
  cache.set(key, hit);
  return hit.src;
}

function remember(key: string, src: string | null): void {
  cache.set(key, { src, at: Date.now() });
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * Many refs to data URIs, within limits: at most `max` images, `concurrency`
 * at a time, and nothing new started after `deadlineMs` — a PDF renderer waits
 * for the page, and a slow CDN must cost previews, not the whole document.
 * Never asks Meta for fresh URLs (see `loadThumb`).
 */
export async function inlineThumbs(
  client: { id: string; agencyId: string },
  refs: readonly string[],
  opts: { max?: number; concurrency?: number; deadlineMs?: number } = {},
): Promise<Map<string, string | null>> {
  const max = opts.max ?? 36;
  const deadline = Date.now() + (opts.deadlineMs ?? 10_000);
  const unique = [...new Set(refs)].slice(0, max);
  const out = new Map<string, string | null>();
  let next = 0;

  const worker = async () => {
    while (next < unique.length && Date.now() < deadline) {
      const ref = unique[next++];
      const key = `${client.id}:${ref}`;
      const hit = cached(key);
      if (hit !== undefined) {
        out.set(ref, hit);
        continue;
      }
      const parsed = parseThumbRef(ref);
      const img = parsed ? await loadThumb(client, parsed, { refresh: false }) : null;
      const src = img ? await inlineThumb(img) : null;
      remember(key, src);
      out.set(ref, src);
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 6, unique.length) }, worker));
  return out;
}
