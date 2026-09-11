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

/**
 * The stash is shared with the Meta and Google flows and tested against a real
 * Postgres in `lib/connect-stash.test.ts`. What is left here is the adapter:
 * which provider this module reaches for, and whether the advertiser ids
 * survive the trip through a shapeless jsonb payload.
 */
const putConnectStash = vi.fn(async () => "stash-id");
const readConnectStash = vi.fn();
const dropConnectStash = vi.fn(async () => {});
vi.mock("@/lib/connect-stash", () => ({
  putConnectStash: (...args: unknown[]) => putConnectStash(...(args as [])),
  readConnectStash: (...args: unknown[]) => readConnectStash(...(args as [])),
  dropConnectStash: (...args: unknown[]) => dropConnectStash(...(args as [])),
}));

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
  putConnectStash.mockResolvedValue("stash-id");
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

describe("the TikTok side of the shared stash", () => {
  it("stashes under the tiktok provider, carrying the advertiser ids", async () => {
    await mod.stashTiktokConnection(CLIENT, "grant-abc", ["700", "701"]);
    expect(putConnectStash).toHaveBeenCalledWith("tiktok", CLIENT, "grant-abc", {
      payload: { advertiserIds: ["700", "701"] },
    });
  });

  it("reads back under the tiktok provider, unpacking the payload", async () => {
    readConnectStash.mockResolvedValue({
      ok: true,
      clientId: CLIENT,
      token: "grant-abc",
      tokenExpiresAt: null,
      payload: { advertiserIds: ["700"] },
    });
    expect(await mod.readTiktokStash("stash-id", CLIENT)).toEqual({
      ok: true,
      clientId: CLIENT,
      accessToken: "grant-abc",
      advertiserIds: ["700"],
    });
    expect(readConnectStash).toHaveBeenCalledWith("tiktok", "stash-id", CLIENT);
  });

  it("🔴 checks the payload's shape instead of casting it", async () => {
    /*
     * `payload` is jsonb and shapeless by design, so this adapter is the only
     * place that knows what belongs in it. A cast would turn a malformed or
     * legacy row into a crash much further downstream — in the picker, where it
     * would read as TikTok having returned nothing.
     */
    for (const payload of [null, "nonsense", {}, { advertiserIds: "700" }, { advertiserIds: [1, "700"] }]) {
      readConnectStash.mockResolvedValue({
        ok: true,
        clientId: CLIENT,
        token: "grant-abc",
        tokenExpiresAt: null,
        payload,
      });
      const got = await mod.readTiktokStash("stash-id", CLIENT);
      expect(got.ok).toBe(true);
      // Never throws, and never yields a non-string id.
      expect(got.ok && got.advertiserIds.every((v) => typeof v === "string")).toBe(true);
    }
  });

  it("passes a refusal straight through rather than reshaping it", async () => {
    readConnectStash.mockResolvedValue({ ok: false, reason: "wrong_client" });
    expect(await mod.readTiktokStash("stash-id", OTHER)).toEqual({
      ok: false,
      reason: "wrong_client",
    });
  });

  it("drops only the tiktok stash of that id", async () => {
    await mod.dropTiktokStash("stash-id");
    expect(dropConnectStash).toHaveBeenCalledWith("tiktok", "stash-id");
  });
});

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
