/**
 * Resolving an ad to the CREATIVE it shows.
 *
 * 🔴 The single most consequential decision in creative reporting, and it has to
 * be right before any leaderboard ships.
 *
 * The same asset — one video, one image — routinely runs in a dozen ad sets.
 * Meta gives each of those a distinct AD ID. Group creative performance by ad
 * id and one creative's spend, leads and closes are split across twelve rows:
 * each row shows a twelfth of the spend against a twelfth of the leads, so the
 * ratio survives but every ABSOLUTE figure is wrong, small samples look
 * decisive, and a creative that is genuinely the best performer never appears at
 * the top because its budget was divided twelve ways.
 *
 * Grouping by `image_hash` / `video_id` — the asset's own identity — is what
 * makes "which creative works" answerable. Retrofitting it later means every
 * historical row is attributed wrongly and has to be re-derived.
 *
 * Where the identity actually lives, in priority order:
 *
 *  1. `creative.video_id` / `creative.image_hash` — set on a plain single-asset
 *     ad.
 *  2. `object_story_spec.video_data.video_id` / `link_data.image_hash` — set
 *     when the ad was built from a page post, which is most of them.
 *  3. `asset_feed_spec` — Dynamic Creative. Holds LISTS of images and videos
 *     that Meta recombines per impression, so the ad has no single identity and
 *     honestly resolves to `carousel`, not to whichever asset happens to be
 *     first in the array.
 *  4. `link_data.child_attachments` — a real carousel. Same reasoning.
 */

export type CreativeType = "image" | "video" | "carousel" | "unknown";

export interface ResolvedCreative {
  /** The dedup key: a video id, an image hash, or "" when unresolvable. */
  key: string;
  type: CreativeType;
  imageHash: string | null;
  videoId: string | null;
  thumbnailUrl: string | null;
  title: string | null;
  body: string | null;
  callToActionType: string | null;
  linkUrl: string | null;
}

interface Spec {
  [k: string]: unknown;
}

const str = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
};

const obj = (v: unknown): Spec | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Spec) : null;

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function resolveCreative(creative: unknown): ResolvedCreative {
  const c = obj(creative);
  const empty: ResolvedCreative = {
    key: "",
    type: "unknown",
    imageHash: null,
    videoId: null,
    thumbnailUrl: null,
    title: null,
    body: null,
    callToActionType: null,
    linkUrl: null,
  };
  if (!c) return empty;

  const story = obj(c.object_story_spec) ?? {};
  const videoData = obj(story.video_data);
  const linkData = obj(story.link_data);
  const feed = obj(c.asset_feed_spec);

  const thumbnailUrl =
    str(c.thumbnail_url) ??
    str(c.image_url) ??
    str(videoData?.image_url) ??
    str(linkData?.picture) ??
    null;

  const cta =
    obj(linkData?.call_to_action) ?? obj(videoData?.call_to_action) ?? null;
  const callToActionType = str(cta?.type);

  const linkUrl =
    str(linkData?.link) ??
    str(obj(cta?.value)?.link) ??
    str(obj(videoData?.call_to_action)?.value && obj(obj(videoData?.call_to_action)?.value)?.link) ??
    null;

  const title = str(c.title) ?? str(linkData?.name) ?? str(videoData?.title) ?? null;
  const body =
    str(c.body) ?? str(linkData?.message) ?? str(videoData?.message) ?? null;

  const base = { thumbnailUrl, title, body, callToActionType, linkUrl };

  /*
   * Dynamic Creative first. Its asset lists mean Meta assembles a different
   * combination per impression, so no single asset identifies the ad — and
   * picking `images[0]` would attribute a whole ad set's spend to one image
   * that may have served a fraction of it.
   */
  if (feed) {
    const images = arr(feed.images);
    const videos = arr(feed.videos);
    if (images.length + videos.length > 1) {
      return { ...empty, ...base, type: "carousel" };
    }
    // Exactly one asset in the feed spec — it IS the ad's identity.
    const oneVideo = str(obj(videos[0])?.video_id);
    if (oneVideo) {
      return { ...empty, ...base, key: oneVideo, type: "video", videoId: oneVideo };
    }
    const oneImage = str(obj(images[0])?.hash);
    if (oneImage) {
      return { ...empty, ...base, key: oneImage, type: "image", imageHash: oneImage };
    }
  }

  // A true carousel: several child attachments, several assets.
  if (arr(linkData?.child_attachments).length > 1) {
    return { ...empty, ...base, type: "carousel" };
  }

  // Video wins over image when both are present: a video ad also carries a
  // thumbnail image hash, and keying on the thumbnail would merge unrelated
  // videos that happen to share a cover frame.
  const videoId = str(c.video_id) ?? str(videoData?.video_id);
  if (videoId) {
    return { ...empty, ...base, key: videoId, type: "video", videoId };
  }

  const imageHash =
    str(c.image_hash) ??
    str(linkData?.image_hash) ??
    str(obj(arr(linkData?.child_attachments)[0])?.image_hash);
  if (imageHash) {
    return { ...empty, ...base, key: imageHash, type: "image", imageHash };
  }

  /*
   * Nothing identifiable. Returns `unknown` with an EMPTY key rather than
   * falling back to the creative id — a creative-id key would look like it
   * works while silently reintroducing the twelve-rows-per-asset bug for
   * exactly the ads we understand least.
   */
  return { ...empty, ...base };
}

/**
 * Video-length buckets for hold-rate benchmarking.
 *
 * ThruPlay counts "watched to completion" below 15 seconds and "reached 15
 * seconds" at or above it. A 10-second ad therefore earns its ThruPlay by being
 * finished, while a 60-second ad earns one at the quarter mark — so a single
 * hold-rate benchmark applied to both ranks them on different achievements.
 * Splitting at 15s is not a stylistic choice; it is where Meta's definition
 * changes.
 */
export type LengthBucket = "under_15s" | "15_30s" | "30_60s" | "over_60s" | "unknown";

export function lengthBucket(seconds: number | null | undefined): LengthBucket {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return "unknown";
  if (seconds < 15) return "under_15s";
  if (seconds < 30) return "15_30s";
  if (seconds <= 60) return "30_60s";
  return "over_60s";
}

export const LENGTH_BUCKET_LABEL: Record<LengthBucket, string> = {
  under_15s: "Under 15s",
  "15_30s": "15–30s",
  "30_60s": "30–60s",
  over_60s: "Over 60s",
  unknown: "Length unknown",
};

/**
 * What ThruPlay means for a video of this length — shown wherever hold rate is.
 *
 * Without this sentence the metric silently changes definition between two rows
 * of the same table.
 */
export function thruPlayMeaning(bucket: LengthBucket): string {
  return bucket === "under_15s"
    ? "watched to completion"
    : bucket === "unknown"
      ? "completion under 15s, or 15s reached above it — length unknown for this asset"
      : "watched at least 15 seconds";
}
