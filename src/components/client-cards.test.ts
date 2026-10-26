import { describe, it, expect } from "vitest";
import { adConnection, bucketFor, type CardAccounts } from "./ClientCards";

/*
 * 🔴 The client list counted Meta ad accounts and nothing else.
 *
 * So the one client running TikTok alone — the only TikTok advertiser the agency
 * had connected, syncing every day — read "Meta not connected" on its card, and
 * with no CRM wired yet it was filed under "Not connected yet", beside clients
 * nobody had touched. Together with an Overview that opened on Meta's empty view,
 * that was the whole of "he cannot see TikTok stats".
 */

const accounts = (over: Partial<CardAccounts> = {}): CardAccounts => ({
  meta: [],
  google: [],
  tiktok: [],
  ...over,
});

describe("adConnection", () => {
  it("🔴 names a TikTok-only client's platform, never 'Meta not connected'", () => {
    expect(adConnection(accounts({ tiktok: [null] }))).toEqual({ label: "TikTok · 1 advertiser", count: 1 });
    expect(adConnection(accounts({ tiktok: ["Acme Ads"] }))).toEqual({ label: "TikTok · Acme Ads", count: 1 });
  });

  it("names a Google-only client's platform too", () => {
    expect(adConnection(accounts({ google: ["Acme", null] }))).toEqual({ label: "Google · 2 accounts", count: 2 });
  });

  it("still gives a Meta client its account's name or count, now under the platform's", () => {
    expect(adConnection(accounts({ meta: ["Parfaire Ads"] })).label).toBe("Meta · Parfaire Ads");
    expect(adConnection(accounts({ meta: [null] })).label).toBe("Meta · 1 ad account");
    expect(adConnection(accounts({ meta: ["a", "b", "c"] })).label).toBe("Meta · 3 ad accounts");
  });

  it("lists the platforms of a client running several, and counts every account", () => {
    expect(adConnection(accounts({ meta: ["a"], tiktok: ["b", "c"] }))).toEqual({
      label: "Meta + TikTok",
      count: 3,
    });
    expect(adConnection(accounts({ meta: ["a"], google: ["b"], tiktok: ["c"] })).label).toBe(
      "Meta + Google + TikTok",
    );
  });

  it("says no ads are connected only when none are, on any platform", () => {
    expect(adConnection(accounts())).toEqual({ label: "Ads not connected", count: 0 });
    for (const p of ["meta", "google", "tiktok"] as const) {
      expect(adConnection(accounts({ [p]: [null] })).label).not.toMatch(/not connected/);
    }
  });
});

describe("which group a card sits in", () => {
  const card = (adAccounts: number, over: Partial<Parameters<typeof bucketFor>[0]> = {}) => ({
    health: "red" as const,
    ghlConnected: false,
    firstWebhookAt: null,
    adAccounts,
    ...over,
  });

  it("🔴 a TikTok-only client with no CRM yet is wired, not 'Not connected yet'", () => {
    const { count } = adConnection(accounts({ tiktok: [null] }));
    expect(bucketFor(card(count))).toBe("attention");
  });

  it("a client with nothing at all is still 'Not connected yet'", () => {
    expect(bucketFor(card(adConnection(accounts()).count))).toBe("unconnected");
  });

  it("a healthy client is live, whatever it runs", () => {
    expect(bucketFor(card(1, { health: "green", ghlConnected: true }))).toBe("live");
  });
});
