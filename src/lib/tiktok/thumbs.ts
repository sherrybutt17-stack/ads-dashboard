import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { tiktokCreativeAssets } from "@/db/schema";
import { parseAssetKey } from "./creative";

/**
 * TikTok creative pictures: fetched once, stored small, served from our rows.
 *
 * 🔴 Why stored and not linked, as Meta's are: TikTok signs its cover URLs for
 * about six hours (`x-expires`, verified 25 Oct 2026). Meta's last a fortnight
 * and can be re-resolved on demand; a TikTok one stored at night is dead by
 * morning, and a share link or PDF — which never calls TikTok — would print
 * every card without its picture. So the sync that resolves a URL fetches the
 * bytes in the same run and keeps a 400px JPEG (tens of kilobytes).
 *
 * The URL itself is never stored or logged: it carries a signature.
 */

/** TikTok's picture CDNs. A cover URL the API hands back anywhere else is not fetched. */
const COVER_HOSTS = /(^|\.)(tiktokcdn(-[a-z]{2})?\.com|ibyteimg\.com|byteimg\.com)$/i;

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** The most a stored picture may be. A 400px JPEG is 20–60 KB; anything bigger is not a thumbnail. */
export const MAX_THUMB_BYTES = 256 * 1024;
const THUMB_WIDTH = 400;
/** Without a resizer, only an image this small, in a plain web type, is kept as it is. */
const RAW_MAX = 150 * 1024;
const RAW_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export interface StoredPicture {
  bytes: Buffer;
  contentType: string;
}

const onCdn = (u: URL) => u.protocol === "https:" && COVER_HOSTS.test(u.hostname);

/**
 * A cover's bytes, shrunk to what is stored — or null for anything that is not
 * clearly an image from TikTok's CDN: another host (before or after a
 * redirect), a non-image answer, too large, or too slow.
 */
export async function fetchTiktokPicture(url: string, timeoutMs = 4000): Promise<StoredPicture | null> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!onCdn(u)) return null;
  try {
    const res = await fetch(u, { cache: "no-store", redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    // A redirect must stay on the CDN too.
    if (res.url && !onCdn(new URL(res.url))) return null;
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/")) return null;
    if (Number(res.headers.get("content-length") ?? 0) > MAX_IMAGE_BYTES) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null;
    return await shrink({ bytes, contentType });
  } catch {
    // A slow CDN is a missing picture, retried next run — never a failed sync.
    return null;
  }
}

/** 400px JPEG at quality 72, as board documents inline Meta's. `sharp` loads lazily. */
async function shrink(img: StoredPicture): Promise<StoredPicture | null> {
  try {
    const { default: sharp } = await import("sharp");
    const out = await sharp(img.bytes)
      .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: 72 })
      .toBuffer();
    return out.length <= MAX_THUMB_BYTES ? { bytes: out, contentType: "image/jpeg" } : null;
  } catch {
    const type = img.contentType.split(";")[0].trim().toLowerCase();
    return RAW_TYPES.has(type) && img.bytes.length <= RAW_MAX ? { bytes: img.bytes, contentType: type } : null;
  }
}

/** A stored picture, scoped to the client — never looked up by key alone. */
export async function loadTiktokPicture(clientId: string, assetKey: string): Promise<StoredPicture | null> {
  const [row] = await db
    .select({ thumb: tiktokCreativeAssets.thumb, contentType: tiktokCreativeAssets.thumbContentType })
    .from(tiktokCreativeAssets)
    .where(and(eq(tiktokCreativeAssets.clientId, clientId), eq(tiktokCreativeAssets.assetKey, assetKey)))
    .limit(1);
  return row?.thumb ? { bytes: row.thumb, contentType: row.contentType ?? "image/jpeg" } : null;
}

/**
 * A URL-safe reference to an asset's picture: `tt.` + base64url of its key.
 *
 * Not the key itself: TikTok image ids contain `/`, which a path segment would
 * split. Base64url carries any key through the thumb route's one segment, and
 * the `tt.` prefix keeps it apart from Meta's refs (hex hashes, digits, `ad.`).
 */
export function tiktokPictureRef(assetKey: string): string {
  return `tt.${Buffer.from(assetKey, "utf8").toString("base64url")}`;
}

/** The asset key a `tt.` ref names, or null for anything that is not one. */
export function parseTiktokPictureRef(segment: string): string | null {
  const m = /^tt\.([A-Za-z0-9_-]{1,400})$/.exec(segment);
  if (!m) return null;
  const key = Buffer.from(m[1], "base64url").toString("utf8");
  return parseAssetKey(key) && tiktokPictureRef(key) === segment ? key : null;
}
