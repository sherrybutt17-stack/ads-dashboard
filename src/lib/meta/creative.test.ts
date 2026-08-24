import { describe, it, expect } from "vitest";
import { resolveCreative, lengthBucket, thruPlayMeaning } from "./creative";

/**
 * Creative identity is the one decision that cannot be retrofitted: get it
 * wrong and every historical per-creative figure is attributed to the wrong
 * thing, and re-deriving means re-fetching creatives for every ad that ever ran.
 */
describe("resolveCreative — the dedup key", () => {
  it("keys a video ad on its video id, never the creative id", () => {
    const r = resolveCreative({ id: "creative_999", video_id: "vid_1" });
    expect(r.key).toBe("vid_1");
    expect(r.type).toBe("video");
    // The creative id is deliberately NOT the key: the same video running in
    // twelve ad sets has twelve creative ids, which would split its spend
    // twelve ways and make its cost per lead read ~12× too low.
    expect(r.key).not.toBe("creative_999");
  });

  it("finds the video id inside object_story_spec, where page-post ads carry it", () => {
    const r = resolveCreative({
      id: "c1",
      object_story_spec: { video_data: { video_id: "vid_2", image_url: "t.jpg" } },
    });
    expect(r.key).toBe("vid_2");
    expect(r.type).toBe("video");
    expect(r.thumbnailUrl).toBe("t.jpg");
  });

  it("keys an image ad on its image hash", () => {
    const r = resolveCreative({
      id: "c2",
      object_story_spec: { link_data: { image_hash: "h_abc", link: "https://x.test" } },
    });
    expect(r.key).toBe("h_abc");
    expect(r.type).toBe("image");
    expect(r.linkUrl).toBe("https://x.test");
  });

  it("prefers the video over the image when both are present", () => {
    // A video ad also carries a thumbnail image hash. Keying on that would
    // merge unrelated videos that happen to share a cover frame.
    const r = resolveCreative({ video_id: "vid_3", image_hash: "thumb_hash" });
    expect(r.key).toBe("vid_3");
    expect(r.type).toBe("video");
  });

  it("refuses to give a Dynamic Creative ad a single identity", () => {
    // Meta recombines these per impression, so no one asset served the spend.
    const r = resolveCreative({
      asset_feed_spec: {
        images: [{ hash: "h1" }, { hash: "h2" }],
        videos: [{ video_id: "v1" }],
      },
    });
    expect(r.type).toBe("carousel");
    expect(r.key).toBe("");
  });

  it("does resolve a feed spec that carries exactly one asset", () => {
    const r = resolveCreative({ asset_feed_spec: { videos: [{ video_id: "v_solo" }] } });
    expect(r.key).toBe("v_solo");
    expect(r.type).toBe("video");
  });

  it("treats a multi-card carousel as a carousel", () => {
    const r = resolveCreative({
      object_story_spec: {
        link_data: {
          child_attachments: [{ image_hash: "a" }, { image_hash: "b" }],
        },
      },
    });
    expect(r.type).toBe("carousel");
    expect(r.key).toBe("");
  });

  it("returns an EMPTY key when nothing identifies the asset", () => {
    // Falling back to the creative id here would look like it works while
    // silently restoring the split-spend bug for the ads we understand least.
    const r = resolveCreative({ id: "c9" });
    expect(r.key).toBe("");
    expect(r.type).toBe("unknown");
  });

  it("survives junk without throwing", () => {
    for (const junk of [null, undefined, "x", 42, []]) {
      expect(resolveCreative(junk).key).toBe("");
    }
  });

  it("extracts copy for the creative grid", () => {
    const r = resolveCreative({
      object_story_spec: {
        link_data: {
          name: "Free Consultation",
          message: "Book this week",
          image_hash: "h",
          call_to_action: { type: "BOOK_TRAVEL" },
        },
      },
    });
    expect(r.title).toBe("Free Consultation");
    expect(r.body).toBe("Book this week");
    expect(r.callToActionType).toBe("BOOK_TRAVEL");
  });
});

describe("length buckets — the ThruPlay definition change", () => {
  it("splits at 15 seconds, where Meta's definition actually changes", () => {
    expect(lengthBucket(14.9)).toBe("under_15s");
    expect(lengthBucket(15)).toBe("15_30s");
  });

  it("has an explicit unknown rather than defaulting to a bucket", () => {
    expect(lengthBucket(null)).toBe("unknown");
    expect(lengthBucket(0)).toBe("unknown");
    expect(lengthBucket(NaN)).toBe("unknown");
  });

  it("states what a ThruPlay means for the bucket", () => {
    expect(thruPlayMeaning("under_15s")).toMatch(/completion/);
    expect(thruPlayMeaning("over_60s")).toMatch(/15 seconds/);
  });
});
