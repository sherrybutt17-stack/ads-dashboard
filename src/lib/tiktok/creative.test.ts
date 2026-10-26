import { describe, it, expect } from "vitest";
import { parseAssetKey, resolveTiktokCreative } from "./creative";

/**
 * Which asset a TikTok ad shows. One card per asset, never per ad — the same
 * video in five ad groups is one creative, and splitting its spend five ways
 * would make each part look like a cheap performer.
 */

describe("resolveTiktokCreative", () => {
  it("🔴 groups ads by their video, whatever cover image rides along", () => {
    // A video ad's `image_ids` is only its cover: the video is the asset.
    expect(resolveTiktokCreative({ video_id: "v09044", image_ids: ["tos-cover/abc"], ad_format: "SINGLE_VIDEO" })).toEqual({
      key: "v:v09044",
      type: "video",
      thumbKey: "v:v09044",
    });
  });

  it("names a single-image ad by its image", () => {
    expect(resolveTiktokCreative({ image_ids: ["ad-site-i18n-sg/202310/abc"] })).toEqual({
      key: "i:ad-site-i18n-sg/202310/abc",
      type: "image",
      thumbKey: "i:ad-site-i18n-sg/202310/abc",
    });
  });

  it("gives a carousel no single key, but a picture to show", () => {
    expect(resolveTiktokCreative({ image_ids: ["a", "b", "c"] })).toEqual({ key: "", type: "carousel", thumbKey: "i:a" });
  });

  it("names a Spark ad by its post", () => {
    expect(resolveTiktokCreative({ tiktok_item_id: "7290000000000000001", video_id: "v1" })).toMatchObject({
      key: "p:7290000000000000001",
      type: "video",
    });
    expect(resolveTiktokCreative({ tiktok_item_id: "729", ad_format: "CAROUSEL_ADS" }).type).toBe("carousel");
  });

  it("🔴 never falls back to the ad id", () => {
    expect(resolveTiktokCreative({})).toEqual({ key: "", type: "unknown", thumbKey: "" });
    expect(resolveTiktokCreative({ video_id: "  ", image_ids: [] })).toEqual({ key: "", type: "unknown", thumbKey: "" });
  });
});

describe("parseAssetKey", () => {
  it("reads each kind, and refuses anything else", () => {
    expect(parseAssetKey("v:v09044")).toEqual({ kind: "video", id: "v09044" });
    expect(parseAssetKey("i:a/b/c")).toEqual({ kind: "image", id: "a/b/c" });
    expect(parseAssetKey("p:729")).toEqual({ kind: "post", id: "729" });
    expect(parseAssetKey("")).toBeNull();
    expect(parseAssetKey("x:1")).toBeNull();
    expect(parseAssetKey("1234")).toBeNull();
  });
});
