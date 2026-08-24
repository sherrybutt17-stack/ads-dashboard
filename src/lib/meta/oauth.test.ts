import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  META_SCOPE,
  TOKEN_EXPIRY_WARN_DAYS,
  buildMetaAuthorizeUrl,
  exchangeMetaCode,
  isMetaConnectConfigured,
  metaRedirectUri,
  tokenExpiryState,
} from "./oauth";

const OLD_ENV = { ...process.env };

beforeEach(() => {
  process.env.META_APP_ID = "app-123";
  process.env.META_APP_SECRET = "secret-456";
  process.env.META_API_VERSION = "v25.0";
  process.env.NEXT_PUBLIC_APP_URL = "https://dash.example.com";
});

afterEach(() => {
  process.env = { ...OLD_ENV };
  vi.unstubAllGlobals();
});

const json = (body: unknown, ok = true, status = 200) =>
  ({ ok, status, text: async () => JSON.stringify(body) }) as unknown as Response;

describe("configuration", () => {
  it("needs both the app id and the secret", () => {
    expect(isMetaConnectConfigured()).toBe(true);
    delete process.env.META_APP_SECRET;
    expect(isMetaConnectConfigured()).toBe(false);
  });

  it("builds a redirect URI that matches the app config", () => {
    expect(metaRedirectUri()).toBe("https://dash.example.com/api/oauth/meta/callback");
  });

  it("strips a trailing slash rather than producing a double slash", () => {
    // A `//` here is not cosmetic — Meta compares the redirect_uri literally
    // against the app's configured value and rejects a mismatch.
    process.env.NEXT_PUBLIC_APP_URL = "https://dash.example.com/";
    expect(metaRedirectUri()).toBe("https://dash.example.com/api/oauth/meta/callback");
  });
});

describe("authorize URL", () => {
  it("asks for ads_read and nothing else", () => {
    /*
     * 🔴 Read-only by design. `ads_management` would permit changing budgets and
     * pausing campaigns — which this product never does — and would drag the
     * app into a slower review for a capability it would not use.
     */
    const url = new URL(buildMetaAuthorizeUrl("state-abc"));
    expect(url.searchParams.get("scope")).toBe("ads_read");
    expect(META_SCOPE).toBe("ads_read");
    expect(url.searchParams.get("scope")).not.toContain("ads_management");
  });

  it("carries the state and the app id", () => {
    const url = new URL(buildMetaAuthorizeUrl("state-abc"));
    expect(url.searchParams.get("state")).toBe("state-abc");
    expect(url.searchParams.get("client_id")).toBe("app-123");
    expect(url.searchParams.get("response_type")).toBe("code");
  });

  it("pins the API version in the path", () => {
    // An unpinned Meta URL silently falls back to an older version rather than
    // erroring, which is the quietest possible way to change behaviour.
    expect(buildMetaAuthorizeUrl("s")).toContain("/v25.0/dialog/oauth");
  });
});

describe("🔴 code exchange always upgrades to a long-lived token", () => {
  it("makes BOTH calls and returns the long-lived token", async () => {
    /*
     * The short-lived token lasts 1–2 hours. Storing it produces a connection
     * that works throughout setup, passes every check made while someone is
     * watching, and is dead before the first nightly sync — the hardest kind of
     * failure to trace back to its cause.
     */
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: URL) => {
      const u = new URL(String(url));
      calls.push(u.searchParams.get("grant_type") ?? "code");
      return u.searchParams.get("grant_type") === "fb_exchange_token"
        ? json({ access_token: "LONG", expires_in: 5_184_000 })
        : json({ access_token: "SHORT", expires_in: 3600 });
    });

    const out = await exchangeMetaCode("the-code");

    expect(calls).toEqual(["code", "fb_exchange_token"]);
    expect(out.accessToken).toBe("LONG");
    // ~60 days out, not ~1 hour.
    const days = (out.expiresAt!.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(50);
  });

  it("sends the short-lived token as fb_exchange_token", async () => {
    let exchanged: string | null = null;
    vi.stubGlobal("fetch", async (url: URL) => {
      const u = new URL(String(url));
      if (u.searchParams.get("grant_type") === "fb_exchange_token") {
        exchanged = u.searchParams.get("fb_exchange_token");
        return json({ access_token: "LONG", expires_in: 5_184_000 });
      }
      return json({ access_token: "SHORT", expires_in: 3600 });
    });
    await exchangeMetaCode("c");
    expect(exchanged).toBe("SHORT");
  });

  it("records a non-expiring token as null rather than as 'now'", async () => {
    // Absent `expires_in` means it does not expire. Storing a date here would
    // make the health check report a permanent token as expired.
    vi.stubGlobal("fetch", async () => json({ access_token: "T" }));
    expect((await exchangeMetaCode("c")).expiresAt).toBeNull();
  });

  it("🔴 throws on a 200 that carries an error object", async () => {
    // Meta reports some failures with a 200 and an `error` key. Reading that as
    // a token would store the string "undefined" as a credential.
    vi.stubGlobal("fetch", async () =>
      json({ error: { message: "Invalid verification code format." } }),
    );
    await expect(exchangeMetaCode("bad")).rejects.toThrow(/Invalid verification code/);
  });

  it("throws when the body has no access_token at all", async () => {
    vi.stubGlobal("fetch", async () => json({ something: "else" }));
    await expect(exchangeMetaCode("c")).rejects.toThrow();
  });

  it("throws a readable error on non-JSON", async () => {
    vi.stubGlobal(
      "fetch",
      async () => ({ ok: false, status: 502, text: async () => "<html>gateway</html>" }) as unknown as Response,
    );
    await expect(exchangeMetaCode("c")).rejects.toThrow(/non-JSON/i);
  });

  it("refuses to run without app credentials", async () => {
    delete process.env.META_APP_SECRET;
    await expect(exchangeMetaCode("c")).rejects.toThrow(/META_APP_ID \/ META_APP_SECRET/);
  });
});

describe("🔴 tokenExpiryState — the silent-death guard", () => {
  const now = new Date("2026-08-17T12:00:00Z");
  const inDays = (d: number) => new Date(now.getTime() + d * 86_400_000);

  it("treats a null expiry as never expiring, not as expired", () => {
    /*
     * The system user token behind the paste-an-id path has no expiry. Reading
     * null as "expired" would turn every existing client red on the day this
     * shipped.
     */
    expect(tokenExpiryState(null, now)).toBe("none");
    expect(tokenExpiryState(undefined, now)).toBe("none");
  });

  it("is ok well before the window", () => {
    expect(tokenExpiryState(inDays(60), now)).toBe("ok");
    expect(tokenExpiryState(inDays(TOKEN_EXPIRY_WARN_DAYS + 1), now)).toBe("ok");
  });

  it("warns inside the window, while there is still time to act", () => {
    // Two weeks, because re-authorising may need the CLIENT's Facebook account,
    // and that is a conversation rather than a button press.
    expect(tokenExpiryState(inDays(TOKEN_EXPIRY_WARN_DAYS), now)).toBe("expiring");
    expect(tokenExpiryState(inDays(1), now)).toBe("expiring");
  });

  it("reports expired once the date has passed", () => {
    expect(tokenExpiryState(inDays(-1), now)).toBe("expired");
    expect(tokenExpiryState(now, now)).toBe("expired");
  });

  it("never returns ok for a date in the past", () => {
    // Asserted as a property rather than on a chosen date: an off-by-one in the
    // comparison would otherwise hide behind whichever example was picked.
    for (let d = -400; d < 0; d += 7) {
      expect(tokenExpiryState(inDays(d), now), `${d} days`).toBe("expired");
    }
  });
});
