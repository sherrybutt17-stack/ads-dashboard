import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, CLIENT_A, CLIENT_B, type TestDb } from "@/lib/metrics/__testdb__/harness";

/**
 * Creative thumbnails: what counts as an image, whose rows may be read, and the
 * rule that matters most — a public document (a PDF or a share link) never asks
 * Meta for a fresh URL, so a share link cannot spend an account's Graph quota.
 */

let harness: { db: TestDb; close: () => Promise<void> };

vi.mock("@/db", () => ({
  get db() {
    return harness.db;
  },
  schema: {},
}));

const getAdCreative = vi.fn();
vi.mock("@/lib/meta/accounts", () => ({
  metaClientForAccount: () => ({ getAdCreative }),
}));

let thumbs: typeof import("./thumbs");
const CLIENT = { id: CLIENT_A, agencyId: "00000000-0000-0000-0000-000000000099" };

/** A real 10×10 PNG. */
let png: Buffer;

function respond(body: Buffer | string, type: string, status = 200): Response {
  return new Response(typeof body === "string" ? body : new Uint8Array(body), {
    status,
    headers: { "content-type": type },
  });
}

beforeAll(async () => {
  harness = await createTestDb();
  thumbs = await import("./thumbs");
  const { default: sharp } = await import("sharp");
  png = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#c33" } }).png().toBuffer();

  await harness.db.execute(sql`
    INSERT INTO meta_ad_accounts (client_id, ad_account_id, status) VALUES (${CLIENT_A}, 'act_1', 'active')
  `);
  await harness.db.execute(sql`
    INSERT INTO meta_ad_creatives (client_id, meta_ad_account_id, meta_ad_id, creative_key, thumbnail_url)
    VALUES (${CLIENT_A}, 'act_1', '11', 'vid_a', 'https://cdn.example/dead.jpg'),
           (${CLIENT_A}, 'act_1', '12', '', 'https://cdn.example/dynamic.jpg'),
           (${CLIENT_B}, 'act_9', '91', 'vid_secret', 'https://cdn.example/secret.jpg')
  `);
});

afterAll(async () => {
  await harness.close();
});

beforeEach(() => {
  getAdCreative.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseThumbRef", () => {
  it("reads an asset key or an ad, and nothing else", () => {
    expect(thumbs.parseThumbRef("vid_a")).toEqual({ kind: "creative", key: "vid_a" });
    expect(thumbs.parseThumbRef("ad.1234567")).toEqual({ kind: "ad", adId: "1234567" });
    expect(thumbs.parseThumbRef("../etc/passwd")).toBeNull();
    expect(thumbs.parseThumbRef("a b")).toBeNull();
    // Not an ad id, and a dot is never part of an asset key.
    expect(thumbs.parseThumbRef("ad.x1")).toBeNull();
  });
});

describe("fetchImage", () => {
  it("🔴 trusts the content type, not the status — Meta answers a dead link with a 200 HTML page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respond("<html>login</html>", "text/html")));
    expect(await thumbs.fetchImage("https://cdn.example/x")).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => respond(png, "image/png")));
    expect((await thumbs.fetchImage("https://cdn.example/x"))?.contentType).toBe("image/png");
    vi.stubGlobal("fetch", vi.fn(async () => respond(png, "image/png", 404)));
    expect(await thumbs.fetchImage("https://cdn.example/x")).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("timeout"))));
    expect(await thumbs.fetchImage("https://cdn.example/x")).toBeNull();
  });
});

describe("loadThumb", () => {
  it("🔴 reads only the client's own rows", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respond(png, "image/png")));
    expect(await thumbs.loadThumb(CLIENT, { kind: "creative", key: "vid_secret" }, { refresh: false })).toBeNull();
    expect(await thumbs.loadThumb(CLIENT, { kind: "creative", key: "vid_a" }, { refresh: false })).not.toBeNull();
    expect(await thumbs.loadThumb(CLIENT, { kind: "ad", adId: "12" }, { refresh: false })).not.toBeNull();
  });

  it("🔴 asks Meta for a fresh URL only when allowed to", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes("fresh") ? respond(png, "image/png") : respond("gone", "text/html"),
    );
    vi.stubGlobal("fetch", fetchMock);
    getAdCreative.mockResolvedValue({ image_url: "https://cdn.example/fresh.jpg" });

    expect(await thumbs.loadThumb(CLIENT, { kind: "creative", key: "vid_a" }, { refresh: false })).toBeNull();
    expect(getAdCreative).not.toHaveBeenCalled();

    expect(await thumbs.loadThumb(CLIENT, { kind: "creative", key: "vid_a" }, { refresh: true })).not.toBeNull();
    expect(getAdCreative).toHaveBeenCalledWith("11");
  });
});

describe("inline thumbnails for documents", () => {
  it("shrink an image to a JPEG data URI", async () => {
    const src = await thumbs.inlineThumb({ bytes: png, contentType: "image/png" });
    expect(src?.startsWith("data:image/jpeg;base64,")).toBe(true);
  });

  it("keep a small original when it cannot be resized, and nothing else", async () => {
    const broken = Buffer.from("not really an image");
    expect(await thumbs.inlineThumb({ bytes: broken, contentType: "image/png" })).toMatch(/^data:image\/png;base64,/);
    expect(await thumbs.inlineThumb({ bytes: broken, contentType: "image/svg+xml" })).toBeNull();
    expect(await thumbs.inlineThumb({ bytes: Buffer.alloc(200 * 1024), contentType: "image/png" })).toBeNull();
  });

  it("🔴 never refresh from Meta, and stop at the cap and the deadline", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respond("gone", "text/html")));
    const first = await thumbs.inlineThumbs(CLIENT, ["vid_a", "ad.12", "vid_secret"], { max: 2 });
    expect([...first.keys()]).toEqual(["vid_a", "ad.12"]);
    expect(getAdCreative).not.toHaveBeenCalled();

    const late = await thumbs.inlineThumbs(CLIENT, ["ad.11"], { deadlineMs: -1 });
    expect(late.size).toBe(0);
  });
});
