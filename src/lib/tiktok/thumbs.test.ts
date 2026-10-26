import { describe, it, expect, afterEach, vi } from "vitest";

/**
 * TikTok pictures: a ref that survives a URL path, and a fetch that takes only
 * an image, only from TikTok's CDN.
 */

vi.mock("@/db", () => ({ db: {} }));

const { fetchTiktokPicture, parseTiktokPictureRef, tiktokPictureRef } = await import("./thumbs");

afterEach(() => vi.unstubAllGlobals());

describe("picture refs", () => {
  it("🔴 carry any asset key through one path segment, slashes included", () => {
    for (const key of ["v:v09044", "i:ad-site-i18n-sg/202310/abc", "p:7290000000000000001"]) {
      const ref = tiktokPictureRef(key);
      expect(ref).toMatch(/^tt\.[A-Za-z0-9_-]+$/);
      expect(parseTiktokPictureRef(ref)).toBe(key);
    }
  });

  it("refuses anything that is not one", () => {
    expect(parseTiktokPictureRef("ad.1234")).toBeNull();
    expect(parseTiktokPictureRef("a1b2c3")).toBeNull();
    expect(parseTiktokPictureRef(`tt.${Buffer.from("x:1").toString("base64url")}`)).toBeNull();
    expect(parseTiktokPictureRef("tt.***")).toBeNull();
  });
});

describe("fetchTiktokPicture", () => {
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
  const answer = (over: { type?: string; url?: string; body?: Buffer; status?: number } = {}) =>
    ({
      ok: (over.status ?? 200) < 400,
      status: over.status ?? 200,
      url: over.url ?? "",
      headers: new Headers({ "content-type": over.type ?? "image/jpeg" }),
      arrayBuffer: async () => (over.body ?? JPEG).buffer.slice(0),
    }) as unknown as Response;

  it("fetches a cover from TikTok's CDN", async () => {
    const spy = vi.fn(async () => answer());
    vi.stubGlobal("fetch", spy);
    const got = await fetchTiktokPicture("https://p16-common-sign.tiktokcdn.com/tos/cover.jpeg?x-expires=1");
    expect(spy).toHaveBeenCalledTimes(1);
    // sharp cannot read these six bytes, so the small original is kept as it is.
    expect(got?.contentType).toBe("image/jpeg");
  });

  it("🔴 never fetches from anywhere else", async () => {
    const spy = vi.fn(async () => answer());
    vi.stubGlobal("fetch", spy);
    for (const url of ["https://evil.example.com/x.jpeg", "http://p16-sign.tiktokcdn.com/x.jpeg", "https://tiktokcdn.com.evil.io/x.jpeg", "not a url"]) {
      expect(await fetchTiktokPicture(url), url).toBeNull();
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses a redirect off the CDN, and anything that is not an image", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => answer({ url: "https://evil.example.com/x.jpeg" })));
    expect(await fetchTiktokPicture("https://p16-sign.tiktokcdn.com/x.jpeg")).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => answer({ type: "text/html" })));
    expect(await fetchTiktokPicture("https://p16-sign.tiktokcdn.com/x.jpeg")).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => answer({ status: 403 })));
    expect(await fetchTiktokPicture("https://p16-sign.tiktokcdn.com/x.jpeg")).toBeNull();
  });

  it("treats a slow or failing CDN as a missing picture, never an error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("timeout");
    }));
    await expect(fetchTiktokPicture("https://p16-sign.tiktokcdn.com/x.jpeg")).resolves.toBeNull();
  });
});
