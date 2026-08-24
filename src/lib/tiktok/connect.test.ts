import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The gap between "they authorized TikTok" and "these advertisers are this
 * client's".
 *
 * One TikTok grant can cover every advertiser an agency manages — the token
 * exchange hands back an `advertiser_ids` array — so attaching all of them
 * because somebody connected one client would put another tenant's spend on
 * this dashboard. Consent and selection stay two steps, and a live credential
 * waits in between.
 */

const listAdvertisers = vi.fn();
const getAdvertisers = vi.fn();

vi.mock("./client", () => ({
  TiktokClient: class {
    constructor(readonly accessToken: string) {}
    listAdvertisers = listAdvertisers;
    getAdvertisers = getAdvertisers;
  },
}));

process.env.ENCRYPTION_KEY = "d".repeat(64);
const mod = await import("./connect");

const CLIENT = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("TIKTOK_APP_ID", "app-1");
  vi.stubEnv("TIKTOK_APP_SECRET", "secret-1");
  listAdvertisers.mockResolvedValue([
    { advertiser_id: "700", advertiser_name: "Acme TikTok" },
  ]);
  getAdvertisers.mockResolvedValue([
    {
      advertiser_id: "700",
      advertiser_name: "Acme TikTok",
      currency: "USD",
      timezone: "America/Los_Angeles",
    },
  ]);
});

/* ------------------------------------------------------------------ *
 * The stash
 * ------------------------------------------------------------------ */

describe("the connection stash", () => {
  it("round-trips the grant for the client it was minted for", async () => {
    const id = await mod.stashTiktokConnection(CLIENT, "grant-abc", ["700"]);
    expect(mod.readTiktokStash(id, CLIENT)).toEqual({
      ok: true,
      clientId: CLIENT,
      accessToken: "grant-abc",
      advertiserIds: ["700"],
    });
  });

  it("🔴 refuses a stash minted for a different client", async () => {
    /*
     * The stash id travels through a URL, and one TikTok grant reaches many
     * advertisers. Without this an operator who can see two clients could take
     * a stash minted while connecting one and attach that grant's advertisers —
     * another tenant's spend — to the other.
     */
    const id = await mod.stashTiktokConnection(CLIENT, "grant-abc", ["700"]);
    expect(mod.readTiktokStash(id, OTHER)).toEqual({
      ok: false,
      reason: "wrong_client",
    });
  });

  it("encrypts the grant rather than parking it in a Map in the clear", async () => {
    const spy = vi.spyOn(await import("@/lib/crypto"), "encrypt");
    await mod.stashTiktokConnection(CLIENT, "grant-xyz", []);
    expect(spy).toHaveBeenCalledWith("grant-xyz");
    spy.mockRestore();
  });

  it("reads an unknown id as expired rather than throwing", () => {
    // On serverless a later request may land on another instance and find
    // nothing. That has to read as "sign-in expired, try again", not a 500.
    expect(mod.readTiktokStash("nope", CLIENT)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("drops a stash once used", async () => {
    const id = await mod.stashTiktokConnection(CLIENT, "grant-abc", []);
    mod.dropTiktokStash(id);
    expect(mod.readTiktokStash(id, CLIENT).ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Discovery
 * ------------------------------------------------------------------ */

describe("discoverTiktokAdvertisers", () => {
  it("merges the list call with the detail call", async () => {
    // Two calls are required, not one: `/oauth2/advertiser/get/` returns only
    // id and name; currency and timezone come from `/advertiser/info/`.
    const { advertisers } = await mod.discoverTiktokAdvertisers("tok");
    expect(advertisers).toEqual([
      {
        advertiserId: "700",
        name: "Acme TikTok",
        currency: "USD",
        timezone: "America/Los_Angeles",
      },
    ]);
  });

  it("refuses to run without app credentials", async () => {
    vi.stubEnv("TIKTOK_APP_SECRET", "");
    await expect(mod.discoverTiktokAdvertisers("tok")).rejects.toThrow(/TIKTOK_APP/);
  });

  it("skips the detail call entirely when nothing was listed", async () => {
    listAdvertisers.mockResolvedValue([]);
    const res = await mod.discoverTiktokAdvertisers("tok");
    expect(res).toEqual({ advertisers: [], detailUnavailable: false });
    expect(getAdvertisers).not.toHaveBeenCalled();
  });

  it("sorts by name, falling back to the id", async () => {
    listAdvertisers.mockResolvedValue([
      { advertiser_id: "700", advertiser_name: "Zeta" },
      { advertiser_id: "800", advertiser_name: "Alpha" },
    ]);
    getAdvertisers.mockResolvedValue([]);
    const { advertisers } = await mod.discoverTiktokAdvertisers("tok");
    expect(advertisers.map((a) => a.name)).toEqual(["Alpha", "Zeta"]);
  });

  describe("🔴 when the detail call fails", () => {
    /*
     * Showing the advertisers anyway is right: an operator who can see the
     * account they were looking for can proceed, whereas an empty list reads as
     * "the authorization did not work" and sends them round consent again for a
     * fault that is not theirs.
     *
     * Doing it SILENTLY is not. Each row renders `{currency ?? "?"}`, so a
     * failed detail call turns the whole column into `?` — identical to TikTok
     * not reporting a currency, which for an ad account does not happen. This
     * product sums spend across accounts and currencies cannot be summed, so
     * picking blind is how a EUR advertiser lands in a USD total.
     */
    beforeEach(() => {
      getAdvertisers.mockRejectedValue(new Error("info endpoint down"));
    });

    it("still returns the advertisers", async () => {
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      const { advertisers } = await mod.discoverTiktokAdvertisers("tok");
      expect(advertisers.map((a) => a.advertiserId)).toEqual(["700"]);
      err.mockRestore();
    });

    it("🔴 says the detail is unavailable rather than implying there is none", async () => {
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      const { advertisers, detailUnavailable } =
        await mod.discoverTiktokAdvertisers("tok");
      expect(detailUnavailable).toBe(true);
      expect(advertisers[0].currency).toBeNull();
      err.mockRestore();
    });

    it("keeps the name from the list call", async () => {
      // The list call carries a name even when detail does not, so the picker
      // is still usable — a list of bare numeric ids would not be.
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      const { advertisers } = await mod.discoverTiktokAdvertisers("tok");
      expect(advertisers[0].name).toBe("Acme TikTok");
      err.mockRestore();
    });
  });

  it("reports detail as available when it succeeded", async () => {
    const { detailUnavailable } = await mod.discoverTiktokAdvertisers("tok");
    expect(detailUnavailable).toBe(false);
  });
});

describe("🔴 the flag reaches the person choosing", () => {
  /*
   * A flag nothing renders is worth nothing. Asserted against the source
   * because the alternative is standing up the whole wizard to prove one
   * conditional, which would test the harness more than the rule.
   */
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  const strip = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  it("is passed through by the route", () => {
    /*
     * Asserted on the RESPONSE body, not on the file. The first version of this
     * checked the whole source for the word and passed against a route that had
     * stopped returning it — the destructuring line one statement above still
     * mentions it. Reading a value and sending it are different things.
     */
    const route = strip(
      read("src/app/api/clients/[id]/tiktok-connect/route.ts"),
    );
    expect(route).toContain(
      "const { advertisers, detailUnavailable } = await discoverTiktokAdvertisers",
    );

    /*
     * Anchored on the destructure, not on the first `NextResponse.json({` —
     * an earlier one answers the stash error, and slicing from that checked a
     * completely different response.
     */
    const after = route.slice(
      route.indexOf("const { advertisers, detailUnavailable }"),
    );
    expect(after.slice(0, after.indexOf("});"))).toContain("detailUnavailable,");
  });

  it("is rendered by the picker", () => {
    const wizard = strip(read("src/components/SetupWizard.tsx"));
    expect(wizard).toContain("setDetailUnavailable(Boolean(body.detailUnavailable))");
    expect(wizard).toContain("{detailUnavailable && (");
  });
});
