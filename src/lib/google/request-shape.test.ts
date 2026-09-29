import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GoogleAdsClient } from "./client";

/**
 * What actually goes over the wire to Google Ads — the version in the path and
 * the headers on the request.
 *
 * 🔴 Two dated facts this file pins, both of which fail every call if missed:
 *
 *   1. **Developer tokens were sunset on 2026-09-09.** Access now belongs to the
 *      Google Cloud project that owns the OAuth client. The client used to
 *      THROW "GOOGLE_ADS_DEVELOPER_TOKEN is not set." before sending anything,
 *      so an install configured the way Google now documents could not make a
 *      single request.
 *   2. **v22 sunsets on 2026-10-07.** Google hard-errors on a sunset version, so
 *      a stale default is an outage on a known date, not a data drift.
 *
 * `fetch` is stubbed: the first call is the OAuth token exchange, the second
 * the Ads API request under test.
 */

type Call = { url: string; headers: Record<string, string> };

let calls: Call[];

function stubFetch() {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }));
      }
      return new Response(JSON.stringify({ resourceNames: ["customers/1234567890"] }));
    }),
  );
}

/** The Ads API request — every call after the token exchange. */
const adsCall = () => {
  const c = calls.find((x) => x.url.startsWith("https://googleads.googleapis.com/"));
  if (!c) throw new Error("no Google Ads request was made");
  return c;
};

// A distinct refresh token per test, so the in-memory access-token cache from
// one test can never satisfy the next and skip the exchange.
let n = 0;
const freshToken = () => `refresh-${++n}`;

beforeEach(() => {
  vi.stubEnv("GOOGLE_ADS_CLIENT_ID", "client-id");
  vi.stubEnv("GOOGLE_ADS_CLIENT_SECRET", "client-secret");
  vi.stubEnv("GOOGLE_ADS_DEVELOPER_TOKEN", undefined);
  vi.stubEnv("GOOGLE_ADS_API_VERSION", undefined);
  stubFetch();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Google Ads request shape", () => {
  it("🔴 makes the call with no developer token configured, and sends none", async () => {
    const ids = await new GoogleAdsClient(freshToken(), "").listAccessibleCustomers();
    expect(ids).toEqual(["1234567890"]);
    expect(Object.keys(adsCall().headers)).not.toContain("developer-token");
    expect(adsCall().headers.Authorization).toBe("Bearer at");
  });

  it("still forwards a developer token left in the environment", async () => {
    // Harmless — Google ignores it — and it keeps an older pinned version,
    // set through GOOGLE_ADS_API_VERSION, working unchanged.
    vi.stubEnv("GOOGLE_ADS_DEVELOPER_TOKEN", "legacy-token");
    await new GoogleAdsClient(freshToken(), "").listAccessibleCustomers();
    expect(adsCall().headers["developer-token"]).toBe("legacy-token");
  });

  it("🔴 pins v25 by default — v22 stops answering on 2026-10-07", async () => {
    await new GoogleAdsClient(freshToken(), "").listAccessibleCustomers();
    expect(adsCall().url).toBe(
      "https://googleads.googleapis.com/v25/customers:listAccessibleCustomers",
    );
  });

  it("honours GOOGLE_ADS_API_VERSION, so the next move needs no deploy", async () => {
    vi.stubEnv("GOOGLE_ADS_API_VERSION", "v26");
    await new GoogleAdsClient(freshToken(), "").listAccessibleCustomers();
    expect(adsCall().url).toContain("/v26/");
  });
});
