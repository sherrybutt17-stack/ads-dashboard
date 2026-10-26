import type { CreativeType } from "@/db/schema";
import type { TiktokAd } from "./client";

/**
 * Which asset a TikTok ad shows — the identity creative reporting groups by.
 *
 * The same rule Meta's `resolveCreative` follows, in TikTok's terms: one card
 * per asset, never per ad. The same video in five ad groups is five ads and one
 * creative; grouping by ad would split its spend five ways and make each part
 * look like a cheap performer.
 *
 * In order:
 *   1. a Spark post (`tiktok_item_id`) → `p:<item_id>`, the post being the asset;
 *   2. a video → `v:<video_id>`. Video wins over `image_ids`, which on a video
 *      ad is only its cover;
 *   3. exactly one image → `i:<image_id>`;
 *   4. two or more images → no single asset: key '' and type carousel, with the
 *      first image standing in as its picture;
 *   5. anything else → '' and unknown.
 *
 * The prefixes keep three id spaces apart in one column. It never falls back
 * to the ad id: an ad id as a "creative" would put each ad on its own card and
 * undo the grouping silently.
 *
 * `ad_format`, not `creative_type`, decides a Spark post's type — TikTok
 * returns `creative_type: null` for every ad (verified 25 Oct 2026). Automated
 * creative ads (`is_aco`) carry one `video_id` each and resolve like any video.
 */
export interface TiktokCreative {
  key: string;
  type: CreativeType;
  /** The asset whose picture stands for the ad: the key, or a carousel's first image. */
  thumbKey: string;
}

export function resolveTiktokCreative(
  ad: Pick<TiktokAd, "tiktok_item_id" | "video_id" | "image_ids" | "ad_format">,
): TiktokCreative {
  const item = id(ad.tiktok_item_id);
  if (item) {
    const key = `p:${item}`;
    return { key, type: /CAROUSEL/i.test(ad.ad_format ?? "") ? "carousel" : "video", thumbKey: key };
  }
  const video = id(ad.video_id);
  if (video) return { key: `v:${video}`, type: "video", thumbKey: `v:${video}` };
  const images = (Array.isArray(ad.image_ids) ? ad.image_ids : []).map(id).filter((x): x is string => x !== null);
  if (images.length === 1) return { key: `i:${images[0]}`, type: "image", thumbKey: `i:${images[0]}` };
  if (images.length > 1) return { key: "", type: "carousel", thumbKey: `i:${images[0]}` };
  return { key: "", type: "unknown", thumbKey: "" };
}

/** The asset an asset key names, for asking TikTok about it. */
export function parseAssetKey(key: string): { kind: "video" | "image" | "post"; id: string } | null {
  const m = /^([vip]):(.+)$/.exec(key);
  if (!m) return null;
  return { kind: m[1] === "v" ? "video" : m[1] === "i" ? "image" : "post", id: m[2] };
}

function id(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
